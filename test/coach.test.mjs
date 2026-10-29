import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acquireCoachLock, createReviewConversation, DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_ID, deleteAllPasteCandidates, deleteImportedEntry, excludeImportedEntry, getImportedWriting, importPiWriting, localOnlyFetch, resetOversizedCoachContext, runCoach, setPasteCandidateDisposition, validateLocalBaseUrl } from "../src/coach.mjs";

const roots = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "pi-german-coach-test-"));
  roots.push(path);
  return path;
}

function message(id, timestamp, role, content) {
  return { type: "message", id, timestamp, message: { role, content } };
}

function localNoon(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12).toISOString();
}

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("local model defaults to the Qwen2.5 instructor endpoint and ID", () => {
  assert.equal(DEFAULT_MODEL_BASE_URL, "http://127.0.0.1:8094/v1");
  assert.equal(DEFAULT_MODEL_ID, "qwen2.5-1.5b-instruct");
});

test("local model URL rejects remote hosts and accepts loopback only", () => {
  assert.equal(validateLocalBaseUrl("http://127.0.0.1:8091/v1"), "http://127.0.0.1:8091/v1");
  assert.equal(validateLocalBaseUrl("http://[::1]:8091/v1/"), "http://[::1]:8091/v1");
  assert.throws(() => validateLocalBaseUrl("https://api.openai.com/v1"), /only 127\.0\.0\.1 or \[::1\]/);
  assert.throws(() => validateLocalBaseUrl("http://localhost:8091/v1"), /only 127\.0\.0\.1 or \[::1\]/);
  assert.throws(() => validateLocalBaseUrl("http://127.0.0.1:8091/v1?redirect=https://example.com"), /no credentials, query, or fragment/);
});

test("SQLite data directory is exclusively locked to one Durable process", async () => {
  const rootDir = await tempDir();
  const databasePath = join(rootDir, "coach.sqlite");
  await writeFile(databasePath, "");
  const release = await acquireCoachLock(databasePath);
  try {
    await assert.rejects(acquireCoachLock(databasePath), /already owns/);
  } finally {
    await release();
  }
  const reopen = await acquireCoachLock(databasePath);
  await reopen();
});

test("local-only fetch blocks remote requests and redirects", async () => {
  let fetchCalls = 0;
  let requestPayload;
  const fetch = localOnlyFetch("http://127.0.0.1:8091/v1", async (_input, init) => {
    fetchCalls++;
    assert.equal(init.redirect, "manual");
    requestPayload = JSON.parse(init.body);
    return new Response(null, { status: 302, headers: { location: "https://example.com" } });
  });
  await assert.rejects(fetch("https://example.com/v1/chat/completions"), /configured local completion endpoint/);
  await assert.rejects(fetch("http://127.0.0.1:8092/v1/chat/completions"), /configured local completion endpoint/);
  await assert.rejects(fetch("http://127.0.0.1:8091/v1/models"), /configured local completion endpoint/);
  assert.equal(fetchCalls, 0);
  await assert.rejects(fetch("http://127.0.0.1:8091/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "fixture" }) }), /may not redirect/);
  assert.equal(requestPayload.chat_template_kwargs.enable_thinking, false);
  assert.equal(fetchCalls, 1);
});

test("imports source messages into Durable state without generating model responses", async () => {
  const rootDir = await tempDir();
  const sessionsDir = join(rootDir, "sessions");
  const sessionDir = join(sessionsDir, "--personal--");
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "session.jsonl");
  const german = "Ich lerne gerade Deutsch und möchte meine Texte jeden Tag verbessern.";
  const uncertain = "Ich habe ein Problem in Produktion";
  const transcript = [
    JSON.stringify({ type: "session", id: "session-1" }),
    JSON.stringify(message("german-entry", localNoon(today()), "user", german)),
    JSON.stringify(message("short-entry", localNoon(today()), "user", uncertain)),
    JSON.stringify(message("assistant-entry", localNoon(today()), "assistant", german)),
  ].join("\n") + "\n";
  await writeFile(sessionFile, transcript);
  const output = [];
  const storage = new MemoryStorage();
  await runCoach({
    dataDir: join(rootDir, "state"),
    sessionsDir,
    models: createModels(),
    storage,
    input: Readable.from(["/exit\n"]),
    outputStream: { write: (text) => output.push(text), isTTY: false },
    output: (text) => output.push(`${text}\n`),
  });
  assert.ok(output.join("").includes("2 new entries (2 ≥90%, 0 60–89%)"));
  assert.ok(output.join("").includes("German coach commands:"));
  assert.equal(await readFile(sessionFile, "utf8"), transcript);
});

test("imports are idempotent, date-filtered, and source entries can be excluded from future reviews", async () => {
  const rootDir = await tempDir();
  const sessionsDir = join(rootDir, "sessions");
  await mkdir(sessionsDir);
  const sessionFile = join(sessionsDir, "session.jsonl");
  const writing = "Ich lerne gerade Deutsch und schreibe heute eine längere Nachricht.";
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", id: "session-2" }),
    JSON.stringify(message("entry-1", localNoon("2026-10-26"), "user", writing)),
    JSON.stringify(message("entry-2", localNoon("2026-10-27"), "user", writing)),
  ].join("\n"));

  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const first = await importPiWriting({ harness, root, context: BACKGROUND_CONTEXT, sessionsDir, from: "2026-10-27", through: "2026-10-27" });
    const repeated = await importPiWriting({ harness, root, context: BACKGROUND_CONTEXT, sessionsDir, from: "2026-10-27", through: "2026-10-27" });
    assert.equal(first.imported, 1);
    assert.equal(repeated.imported, 0);
    const entries = await getImportedWriting(harness, root, BACKGROUND_CONTEXT);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].entryId, "entry-2");
    assert.ok(entries[0].germanConfidence >= 0.8);
    await excludeImportedEntry({ harness, root, context: BACKGROUND_CONTEXT, sourceKey: entries[0].sourceKey });
    assert.equal((await getImportedWriting(harness, root, BACKGROUND_CONTEXT))[0].excluded, true);
    await root.submit({
      type: "write",
      entry: { kind: "app.test.large-context", model: [{ role: "user", content: "x".repeat(6000), timestamp: Date.now() }] },
    }, BACKGROUND_CONTEXT);
    assert.ok(await resetOversizedCoachContext(root, BACKGROUND_CONTEXT, 5000) > 5000);
    assert.equal((await getImportedWriting(harness, root, BACKGROUND_CONTEXT))[0].sourceKey, entries[0].sourceKey);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("imports keep likely pasted paragraphs as review metadata", async () => {
  const rootDir = await tempDir();
  const sessionsDir = join(rootDir, "sessions");
  await mkdir(sessionsDir);
  const text = "Kannst du mir bitte helfen, diese Nachricht zu verstehen? Ich möchte wissen, ob der folgende Text höflich klingt.\n\n" +
    "Please review the following detailed implementation requirements and explain how they should be applied. This paragraph contains copied English source material that is much longer than the surrounding German question. ".repeat(5);
  await writeFile(join(sessionsDir, "session.jsonl"), [
    JSON.stringify({ type: "session", id: "session-paste" }),
    JSON.stringify(message("entry-paste", localNoon(today()), "user", text)),
  ].join("\n"));

  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    const result = await importPiWriting({ harness, root, context: BACKGROUND_CONTEXT, sessionsDir });
    const entries = await getImportedWriting(harness, root, BACKGROUND_CONTEXT);
    assert.equal(result.imported, 1);
    assert.equal(result.flaggedPasteEntries, 1);
    assert.equal(result.flaggedPasteBlocks, 1);
    assert.match(entries[0].pasteCandidates[0].text, /^Please review/);
    assert.equal(entries[0].text, text.trim(), "the heuristic must not alter or discard content beyond the importer's existing trim");

    await setPasteCandidateDisposition({ harness, root, context: BACKGROUND_CONTEXT, sourceKey: entries[0].sourceKey, paragraphIndex: 2, disposition: "deleted" });
    let updated = (await getImportedWriting(harness, root, BACKGROUND_CONTEXT))[0];
    assert.doesNotMatch(updated.reviewText, /^Please review/m);
    assert.equal(updated.text, text.trim(), "deleting a candidate from reviews must preserve the imported source");
    await importPiWriting({ harness, root, context: BACKGROUND_CONTEXT, sessionsDir });
    updated = (await getImportedWriting(harness, root, BACKGROUND_CONTEXT))[0];
    assert.equal(updated.pasteCandidates[0].disposition, "deleted", "sync must preserve manual candidate decisions");
    assert.doesNotMatch(updated.reviewText, /^Please review/m);

    await setPasteCandidateDisposition({ harness, root, context: BACKGROUND_CONTEXT, sourceKey: entries[0].sourceKey, paragraphIndex: 2, disposition: "authored" });
    await importPiWriting({ harness, root, context: BACKGROUND_CONTEXT, sessionsDir });
    updated = (await getImportedWriting(harness, root, BACKGROUND_CONTEXT))[0];
    assert.equal(updated.pasteCandidates[0].disposition, "authored");
    assert.match(updated.reviewText, /^Please review/m);

    await deleteImportedEntry({ harness, root, context: BACKGROUND_CONTEXT, sourceKey: entries[0].sourceKey });
    assert.equal((await getImportedWriting(harness, root, BACKGROUND_CONTEXT)).length, 0);
    const afterDeleteSync = await importPiWriting({ harness, root, context: BACKGROUND_CONTEXT, sessionsDir });
    assert.equal(afterDeleteSync.imported, 0, "deleted source entries must not reappear on sync");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("bulk delete omits all active paste candidates from future reviews", async () => {
  const rootDir = await tempDir();
  const sessionsDir = join(rootDir, "sessions");
  await mkdir(sessionsDir);
  const authored = "Kannst du mir bitte helfen, diese beiden eingefügten Absätze einzuordnen? Ich lerne Deutsch und möchte nur meine eigenen Formulierungen üben.";
  const pasteA = "Copied source material that is long enough to trigger the paste heuristic. ".repeat(12);
  const pasteB = "Another copied source block that should also be detected as pasted material. ".repeat(12);
  const sourceText = `${authored}\n\n${pasteA}\n\n${pasteB}`;
  await writeFile(join(sessionsDir, "session.jsonl"), [
    JSON.stringify({ type: "session", id: "session-paste-bulk" }),
    JSON.stringify(message("entry-paste-bulk", localNoon(today()), "user", sourceText)),
  ].join("\n"));

  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await importPiWriting({ harness, root, context: BACKGROUND_CONTEXT, sessionsDir });
    const before = (await getImportedWriting(harness, root, BACKGROUND_CONTEXT))[0];
    assert.equal(before.pasteCandidates.filter((candidate) => candidate.disposition === "review").length, 2);

    const result = await deleteAllPasteCandidates({ harness, root, context: BACKGROUND_CONTEXT });
    assert.deepEqual(result, { deletedBlocks: 2, changedEntries: 1 });
    const afterDelete = (await getImportedWriting(harness, root, BACKGROUND_CONTEXT))[0];
    assert.equal(afterDelete.text, sourceText.trim());
    assert.equal(afterDelete.reviewText, authored);

    await importPiWriting({ harness, root, context: BACKGROUND_CONTEXT, sessionsDir });
    const afterSync = (await getImportedWriting(harness, root, BACKGROUND_CONTEXT))[0];
    assert.equal(afterSync.reviewText, authored, "sync must preserve bulk candidate deletion");
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});

test("SQLite Durable state survives reopening", async () => {
  const rootDir = await tempDir();
  const sessionsDir = join(rootDir, "sessions");
  await mkdir(sessionsDir);
  const text = "Ich lerne gerade Deutsch und schreibe heute eine längere Nachricht.";
  await writeFile(join(sessionsDir, "session.jsonl"), [
    JSON.stringify({ type: "session", id: "session-persist" }),
    JSON.stringify(message("entry-persist", localNoon(today()), "user", text)),
  ].join("\n"));
  const databasePath = join(rootDir, "coach.sqlite");

  const firstHarness = await Harness.open(await openNodeSqliteStorage(databasePath), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const root = await firstHarness.root(BACKGROUND_CONTEXT);
    await importPiWriting({ harness: firstHarness, root, context: BACKGROUND_CONTEXT, sessionsDir });
  } finally {
    await firstHarness.close(BACKGROUND_CONTEXT);
  }

  const reopened = await Harness.open(await openNodeSqliteStorage(databasePath), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const root = await reopened.root(BACKGROUND_CONTEXT);
    const entries = await getImportedWriting(reopened, root, BACKGROUND_CONTEXT);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].text, text);
    assert.equal(entries[0].sourceKey, "session-persist:entry-persist");
    assert.ok(entries[0].germanConfidence >= 0.8);
  } finally {
    await reopened.close(BACKGROUND_CONTEXT);
  }
});

test("confirmed reset removes coach state but leaves regular Pi transcripts untouched", async () => {
  const rootDir = await tempDir();
  const sessionsDir = join(rootDir, "sessions");
  await mkdir(sessionsDir);
  const sourcePath = join(sessionsDir, "session.jsonl");
  const source = [
    JSON.stringify({ type: "session", id: "session-reset" }),
    JSON.stringify(message("entry-reset", localNoon(today()), "user", "Ich lerne gerade Deutsch und schreibe heute eine längere Nachricht.")),
  ].join("\n");
  await writeFile(sourcePath, source);
  const dataDir = join(rootDir, "coach-state");
  await runCoach({
    dataDir,
    sessionsDir,
    models: createModels(),
    storage: new MemoryStorage(),
    input: Readable.from(["/reset\n"]),
    confirmReset: async () => "RESET",
    outputStream: { write: () => {}, isTTY: false },
    output: () => {},
  });
  await assert.rejects(access(dataDir), /ENOENT/);
  assert.equal(await readFile(sourcePath, "utf8"), source);
});

test("interactive review sends text only to the configured loopback model", async () => {
  const rootDir = await tempDir();
  const sessionsDir = join(rootDir, "sessions");
  await mkdir(sessionsDir);
  const learnerText = "Ich lerne gerade Deutsch und schreibe heute eine längere Nachricht.";
  await writeFile(join(sessionsDir, "session.jsonl"), [
    JSON.stringify({ type: "session", id: "session-review" }),
    JSON.stringify(message("entry-review", localNoon(today()), "user", learnerText)),
  ].join("\n"));

  const requests = [];
  let modelListRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      modelListRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-fixture", meta: { n_ctx: 65536, max_tokens: 8192 } }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, body: JSON.parse(body) });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.end([
      `data: ${JSON.stringify({ id: "local-answer", object: "chat.completion.chunk", created: Date.now(), model: "local-fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Dein Satz ist natürlich formuliert." }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ id: "local-answer", object: "chat.completion.chunk", created: Date.now(), model: "local-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const output = [];
  try {
    await runCoach({
      dataDir: join(rootDir, "state"),
      sessionsDir,
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      modelId: "local-fixture",
      input: Readable.from([`/review ${today()}\n`, "/exit\n"]),
      outputStream: { write: (text) => output.push(text), isTTY: false },
      output: (text) => output.push(`${text}\n`),
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  assert.equal(modelListRequests, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/v1/chat/completions");
  assert.equal(requests[0].body.model, "local-fixture");
  assert.equal(requests[0].body.chat_template_kwargs.enable_thinking, false);
  assert.equal(requests[0].body.max_tokens ?? requests[0].body.max_completion_tokens, 8192);
  assert.ok(JSON.stringify(requests[0].body.messages).includes(learnerText));
  assert.ok(output.join("").includes("Dein Satz ist natürlich formuliert."));
});
