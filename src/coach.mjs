#!/usr/bin/env node

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { AssistantEntry, createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import lockfile from "proper-lockfile";
import { chmod, mkdir, open, rmdir, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { scanPiSessions } from "./pi-session-import.mjs";
import { buildProgressPrompt, buildReviewPrompt, chunkReviewEntries, COACH_INSTRUCTIONS } from "./prompt.mjs";

export const DEFAULT_DATA_DIR = process.env.GERMAN_COACH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "pi-german-coach");
export const DEFAULT_PI_SESSIONS_DIR = process.env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions");
export const DEFAULT_MODEL_BASE_URL = "http://127.0.0.1:8094/v1";
export const DEFAULT_MODEL_ID = "qwen2.5-1.5b-instruct";
export const DATA_FILE_NAME = "coach.sqlite";

const ImportedWriting = defineDoc({
  kind: "app.german-coach.imported-writing",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ entries: [], deletedSourceKeys: [] }),
  checkpointWhen: () => true,
});

function isLoopbackHostname(hostname) {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

export function validateLocalBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("LLAMA_CPP_BASE_URL is required");
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`LLAMA_CPP_BASE_URL is not a valid URL: ${error.message}`, { cause: error });
  }
  if (!(["http:", "https:"].includes(url.protocol)) || !isLoopbackHostname(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error("LLAMA_CPP_BASE_URL must be an http(s) URL using only 127.0.0.1 or [::1], with no credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/v1")) throw new Error("LLAMA_CPP_BASE_URL must end in /v1");
  return url.toString().replace(/\/$/, "");
}

function assertLocalRequestUrl(input, endpoint) {
  const requestUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
  const url = new URL(requestUrl);
  const expectedPath = `${endpoint.pathname}/chat/completions`;
  if (url.origin !== endpoint.origin || url.pathname !== expectedPath) {
    throw new Error(`Blocked model request outside the configured local completion endpoint: ${url.origin}${url.pathname}`);
  }
}

export function localOnlyFetch(baseUrl, nativeFetch = globalThis.fetch.bind(globalThis)) {
  const endpoint = new URL(validateLocalBaseUrl(baseUrl));
  return async (input, init = {}) => {
    assertLocalRequestUrl(input, endpoint);
    if (typeof init.body !== "string") throw new Error("Expected a JSON model request body");
    let payload;
    try {
      payload = JSON.parse(init.body);
    } catch (error) {
      throw new Error(`Could not parse local model request body: ${error.message}`, { cause: error });
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Local model request body must be a JSON object");
    payload.chat_template_kwargs = { ...(payload.chat_template_kwargs ?? {}), enable_thinking: false };
    const response = await nativeFetch(input, { ...init, body: JSON.stringify(payload), redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Blocked model endpoint redirect (HTTP ${response.status}); local-only requests may not redirect`);
    }
    return response;
  };
}

async function resolveLocalModel(endpoint, configuredModelId) {
  const url = new URL(`${endpoint}/models`);
  const headers = { Authorization: `Bearer ${process.env.LLAMA_CPP_API_KEY ?? "local"}` };
  const response = await globalThis.fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(5000) });
  if (response.status >= 300 && response.status < 400) throw new Error("Blocked local model-list redirect");
  if (!response.ok) throw new Error(`Local llama.cpp model-list request failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.data) || payload.data.some((model) => typeof model?.id !== "string" || !model.id.trim())) {
    throw new Error("Local llama.cpp returned an invalid /models response");
  }
  const ids = [...new Set(payload.data.map((model) => model.id.trim()))];
  if (ids.length === 0) throw new Error("Local llama.cpp lists no models at /models");
  const selectedId = typeof configuredModelId === "string" && configuredModelId.trim()
    ? configuredModelId.trim()
    : ids.length === 1
      ? ids[0]
      : null;
  if (!selectedId) throw new Error(`Local llama.cpp lists multiple models; set GERMAN_COACH_MODEL_ID to one of: ${ids.join(", ")}`);
  const selected = payload.data.find((model) => model.id.trim() === selectedId);
  if (!selected) throw new Error(`GERMAN_COACH_MODEL_ID ${selectedId} is not listed by the local llama.cpp server`);
  return {
    id: selectedId,
    contextWindow: selected.meta?.n_ctx ?? selected.meta?.n_ctx_train ?? selected.context_length,
    maxTokens: selected.meta?.max_tokens ?? selected.max_tokens,
  };
}

export async function createLocalModels({ baseUrl = process.env.GERMAN_COACH_BASE_URL ?? process.env.LLAMA_CPP_BASE_URL ?? DEFAULT_MODEL_BASE_URL, modelId = process.env.GERMAN_COACH_MODEL_ID ?? DEFAULT_MODEL_ID } = {}) {
  const endpoint = validateLocalBaseUrl(baseUrl);
  const selectedModel = await resolveLocalModel(endpoint, modelId);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const api = openAICompletionsApi();
  const providerId = "llama-cpp-local";
  const model = {
    id: selectedModel.id,
    name: selectedModel.id,
    api: "openai-completions",
    provider: providerId,
    baseUrl: endpoint,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: Number.parseInt(String(process.env.GERMAN_COACH_CONTEXT_WINDOW ?? selectedModel.contextWindow ?? "32768"), 10),
    maxTokens: Number.parseInt(String(process.env.GERMAN_COACH_MAX_TOKENS ?? selectedModel.maxTokens ?? "4096"), 10),
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1024) throw new Error("GERMAN_COACH_CONTEXT_WINDOW must be an integer >= 1024");
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) throw new Error("GERMAN_COACH_MAX_TOKENS must be a positive integer");

  const provider = createProvider({
    id: providerId,
    name: "Local llama.cpp",
    baseUrl: endpoint,
    auth: {
      apiKey: {
        name: "Local llama.cpp",
        resolve: async () => ({ auth: { apiKey: process.env.LLAMA_CPP_API_KEY ?? "local" }, source: "loopback llama.cpp" }),
      },
    },
    models: [model],
    api: {
      stream: (requestedModel, context, options) => api.stream(requestedModel, context, { ...options, fetch: localOnlyFetch(endpoint, nativeFetch) }),
      streamSimple: (requestedModel, context, options) => api.streamSimple(requestedModel, context, { ...options, fetch: localOnlyFetch(endpoint, nativeFetch) }),
    },
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, modelRef: { provider: providerId, modelId: model.id }, endpoint };
}

async function ensurePrivateDataDirectory(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const databasePath = join(dataDir, DATA_FILE_NAME);
  const handle = await open(databasePath, "a", 0o600);
  try {
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return databasePath;
}

export async function acquireCoachLock(databasePath) {
  try {
    return await lockfile.lock(databasePath, { retries: 0, stale: 30_000, update: 10_000 });
  } catch (error) {
    if (error.code === "ELOCKED") throw new Error(`Pi German Coach already owns ${databasePath}`, { cause: error });
    throw error;
  }
}

async function ensureImportedWriting(harness, root, context) {
  await root.commit(async (tx) => { await tx.doc(ImportedWriting, root.id); }, context);
  return await harness.snapshot(ImportedWriting, root.id, context);
}

function reviewTextFor(text, pasteCandidates = []) {
  const deletedParagraphs = new Set(pasteCandidates
    .filter((candidate) => candidate.disposition === "deleted")
    .map((candidate) => candidate.paragraphIndex));
  return text.split(/\n\s*\n/).filter((_, index) => !deletedParagraphs.has(index + 1)).join("\n\n").trim();
}

export async function importPiWriting({ harness, root, context, sessionsDir = DEFAULT_PI_SESSIONS_DIR, from, through }) {
  const scanned = await scanPiSessions({ root: sessionsDir, from, through });
  const snapshot = await ensureImportedWriting(harness, root, context);
  const priorByKey = new Map(snapshot.entries.map((entry) => [entry.sourceKey, entry]));
  const deletedSourceKeys = new Set(snapshot.deletedSourceKeys ?? []);
  const additions = scanned.messages.filter((entry) => !priorByKey.has(entry.sourceKey) && !deletedSourceKeys.has(entry.sourceKey));
  const refreshedByKey = new Map(scanned.messages.map((entry) => {
    const prior = priorByKey.get(entry.sourceKey);
    const dispositionById = new Map((prior?.pasteCandidates ?? []).map((candidate) => [candidate.id, candidate.disposition ?? "review"]));
    const pasteCandidates = entry.pasteCandidates.map((candidate) => ({
      ...candidate,
      disposition: dispositionById.get(candidate.id) ?? "review",
    }));
    return [entry.sourceKey, { ...entry, pasteCandidates, reviewText: reviewTextFor(entry.text, pasteCandidates) }];
  }));
  const candidateUpdates = snapshot.entries.filter((entry) => {
    const refreshed = refreshedByKey.get(entry.sourceKey);
    return refreshed && (
      JSON.stringify(entry.pasteCandidates ?? []) !== JSON.stringify(refreshed.pasteCandidates) ||
      entry.reviewText !== refreshed.reviewText
    );
  });

  if (additions.length || candidateUpdates.length) {
    await root.commit(async (tx) => {
      const doc = await tx.doc(ImportedWriting, root.id);
      doc.deletedSourceKeys ??= [];
      const committed = new Set(doc.entries.map((entry) => entry.sourceKey));
      for (const entry of additions) {
        const refreshed = refreshedByKey.get(entry.sourceKey);
        if (!committed.has(entry.sourceKey) && !doc.deletedSourceKeys.includes(entry.sourceKey)) {
          doc.entries.push({ ...refreshed, excluded: false });
        }
      }
      for (const entry of doc.entries) {
        const refreshed = refreshedByKey.get(entry.sourceKey);
        if (refreshed) {
          entry.pasteCandidates = refreshed.pasteCandidates;
          entry.reviewText = refreshed.reviewText;
        }
      }
    }, context);
  }

  const flagged = [...refreshedByKey.values()].filter((entry) => entry.pasteCandidates.some((candidate) => candidate.disposition === "review"));
  return {
    imported: additions.length,
    aboveThreshold: additions.filter((entry) => entry.germanConfidence >= 0.9).length,
    nearThreshold: additions.filter((entry) => entry.germanConfidence >= 0.6 && entry.germanConfidence < 0.9).length,
    flaggedPasteEntries: flagged.length,
    flaggedPasteBlocks: flagged.reduce((total, entry) => total + entry.pasteCandidates.filter((candidate) => candidate.disposition === "review").length, 0),
    candidateUpdates: candidateUpdates.length,
    issues: scanned.issues,
  };
}

export async function getImportedWriting(harness, root, context) {
  const snapshot = await ensureImportedWriting(harness, root, context);
  return snapshot.entries;
}

export async function excludeImportedEntry({ harness, root, context, sourceKey }) {
  await root.commit(async (tx) => {
    const doc = await tx.doc(ImportedWriting, root.id);
    const target = doc.entries.find((item) => item.sourceKey === sourceKey);
    if (!target) throw new Error(`No imported entry found for ${sourceKey}`);
    target.excluded = true;
  }, context);
}

export async function deleteImportedEntry({ harness, root, context, sourceKey }) {
  await root.commit(async (tx) => {
    const doc = await tx.doc(ImportedWriting, root.id);
    const index = doc.entries.findIndex((item) => item.sourceKey === sourceKey);
    if (index < 0) throw new Error(`No imported entry found for ${sourceKey}`);
    doc.entries.splice(index, 1);
    doc.deletedSourceKeys ??= [];
    if (!doc.deletedSourceKeys.includes(sourceKey)) doc.deletedSourceKeys.push(sourceKey);
  }, context);
}

export async function setPasteCandidateDisposition({ harness, root, context, sourceKey, paragraphIndex, disposition }) {
  if (!["authored", "deleted"].includes(disposition)) throw new TypeError("disposition must be authored or deleted");
  await root.commit(async (tx) => {
    const doc = await tx.doc(ImportedWriting, root.id);
    const entry = doc.entries.find((item) => item.sourceKey === sourceKey);
    if (!entry) throw new Error(`No imported entry found for ${sourceKey}`);
    const candidate = (entry.pasteCandidates ?? []).find((item) => item.paragraphIndex === paragraphIndex);
    if (!candidate) throw new Error(`No paste candidate for paragraph ${paragraphIndex} in ${sourceKey}`);
    candidate.disposition = disposition;
    entry.reviewText = reviewTextFor(entry.text, entry.pasteCandidates);
  }, context);
}

export async function deleteAllPasteCandidates({ harness, root, context }) {
  let deletedBlocks = 0;
  let changedEntries = 0;
  await root.commit(async (tx) => {
    const doc = await tx.doc(ImportedWriting, root.id);
    for (const entry of doc.entries) {
      let changed = false;
      for (const candidate of entry.pasteCandidates ?? []) {
        if ((candidate.disposition ?? "review") === "review") {
          candidate.disposition = "deleted";
          deletedBlocks++;
          changed = true;
        }
      }
      if (changed) {
        changedEntries++;
        entry.reviewText = reviewTextFor(entry.text, entry.pasteCandidates);
      }
    }
  }, context);
  return { deletedBlocks, changedEntries };
}

export function serializedContextSize(messages) {
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

export async function resetOversizedCoachContext(conversation, context, maxChars = Number.parseInt(process.env.GERMAN_COACH_CONTEXT_CHARS ?? "12000", 10)) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1024) throw new RangeError("GERMAN_COACH_CONTEXT_CHARS must be an integer >= 1024");
  const view = await conversation.context(context);
  const size = serializedContextSize(view.messages);
  if (size <= maxChars) return 0;
  await conversation.reset(undefined, context);
  return size;
}

export async function createReviewConversation(harness, context, modelRef) {
  if (!modelRef || typeof modelRef.provider !== "string" || typeof modelRef.modelId !== "string") {
    throw new TypeError("a configured local model is required for review conversations");
  }
  return harness.createConversation({
    ownership: { kind: "ownerless" },
    agent: { model: modelRef, instructions: COACH_INSTRUCTIONS },
  }, context);
}

async function sendInput(root, context, content, output) {
  const submission = await root.submit({ type: "input", content }, context);
  const settled = await submission.wait(context);
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(`Coach run did not complete: ${settled.status}${settled.reason ? ` (${settled.reason})` : ""}`);
  }
  const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  const text = answer?.model?.[0]?.content?.filter((block) => block.type === "text").map((block) => block.text).join("") ?? "";
  if (!text) throw new Error("Local model returned no text answer");
  output(text);
  return text;
}

function currentLocalDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function selectEntries(entries, from, through) {
  return entries.filter((entry) => !entry.excluded && (entry.reviewText ?? entry.text).trim() && (!from || entry.localDate >= from) && (!through || entry.localDate <= through));
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function parseReviewRange(args) {
  if (args.length === 0 || args[0] === "live" || args[0] === "today") {
    const today = currentLocalDate();
    return { from: today, through: today };
  }
  if (args[0] === "all") return {};
  if (args.length > 2) throw new Error("Use /review [live|today|all|YYYY-MM-DD [YYYY-MM-DD]]");
  const [from, through = from] = args;
  for (const value of [from, through]) {
    if (!isCalendarDate(value)) throw new Error("Use /review [live|today|all|YYYY-MM-DD [YYYY-MM-DD]]");
  }
  if (from > through) throw new Error("Review start date must not be after end date");
  return { from, through };
}

function showUsage() {
  return [
    "German coach commands:",
    "  /sync [FROM [THROUGH]]  import Pi user writing locally; no model request",
    "  /review [live|today|all|DATE [THROUGH]]",
    "  /progress               ask the local model for a learning summary",
    "  /list                   show imported entry IDs, date, confidence, and paste flags",
    "  /paste-candidates       inspect paragraphs heuristically flagged as possible pastes",
    "  /exclude SESSION:ENTRY  omit an entry from future reviews (reversible by reset only)",
    "  /delete SESSION:ENTRY   remove an entry and prevent it being re-imported",
    "  /paste-keep SESSION:ENTRY:PARAGRAPH  mark a candidate as authored",
    "  /paste-delete SESSION:ENTRY:PARAGRAPH  omit a candidate paragraph from reviews",
    "  /paste-delete-all       confirm and omit all active candidates from reviews",
    "  /export [FILE]          export local writing and source metadata",
    "  /reset                  erase the complete coach database after confirmation",
    "  /help  /exit",
    "Plain text asks the local coach for feedback.",
  ].join("\n");
}

async function exportWriting(entries, path) {
  const json = `${JSON.stringify(entries, null, 2)}\n`;
  if (!path) return json;
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(target, 0o600);
  return `Export written to ${target}`;
}

async function confirmBulkPasteDeletion(rl, output, confirmDelete, count) {
  const prompt = `Omit all ${count} active paste candidates from future reviews? Original imported text stays unchanged. Type DELETE to confirm: `;
  const answer = confirmDelete ? await confirmDelete(prompt) : await rl.question(prompt);
  if (answer !== "DELETE") {
    output("Paste-candidate deletion cancelled.");
    return false;
  }
  return true;
}

async function confirmEntryDeletion(rl, output, confirmDelete, sourceKey) {
  const prompt = `Remove ${sourceKey} from active coach imports? The Pi transcript is unchanged. Type DELETE to confirm: `;
  const answer = confirmDelete ? await confirmDelete(prompt) : await rl.question(prompt);
  if (answer !== "DELETE") {
    output("Entry deletion cancelled.");
    return false;
  }
  return true;
}

async function requestFullReset(rl, output, confirmReset) {
  const prompt = "This deletes the entire local Durable coach database. Type RESET to confirm: ";
  const answer = confirmReset ? await confirmReset(prompt) : await rl.question(prompt);
  if (answer !== "RESET") {
    output("Reset cancelled.");
    return false;
  }
  return true;
}

async function eraseDatabaseFiles(databasePath) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      await unlink(`${databasePath}${suffix}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export async function runCoach({
  dataDir = DEFAULT_DATA_DIR,
  sessionsDir = DEFAULT_PI_SESSIONS_DIR,
  modelId = process.env.GERMAN_COACH_MODEL_ID ?? DEFAULT_MODEL_ID,
  baseUrl = process.env.GERMAN_COACH_BASE_URL ?? process.env.LLAMA_CPP_BASE_URL ?? DEFAULT_MODEL_BASE_URL,
  models: injectedModels,
  storage: injectedStorage,
  input = process.stdin,
  outputStream = process.stdout,
  output = (message) => outputStream.write(`${message}\n`),
  context = BACKGROUND_CONTEXT,
  confirmReset,
  confirmDelete,
  reviewMaxChars = Number.parseInt(process.env.GERMAN_COACH_REVIEW_CHARS ?? "8000", 10),
} = {}) {
  const databasePath = await ensurePrivateDataDirectory(dataDir);
  const localModel = injectedModels ? null : await createLocalModels({ baseUrl, modelId });
  const models = injectedModels ?? localModel.models;
  const modelRef = localModel?.modelRef;
  const releaseLock = await acquireCoachLock(databasePath);
  let storage;
  let harness;
  let rl;
  let resetRequested = false;

  try {
    storage = injectedStorage ?? await openNodeSqliteStorage(databasePath);
    harness = await Harness.open(storage, {
      models,
      registry: createRegistry(),
      settings: { extensions: [], compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 4000, backgroundTokens: 0 } },
    }, context);
    harness.resume();
    const root = await harness.root(context, modelRef ? { agent: { model: modelRef, instructions: COACH_INSTRUCTIONS } } : undefined);
    if (modelRef) await root.configure({ model: modelRef, instructions: COACH_INSTRUCTIONS }, context);
    const clearedContextChars = await resetOversizedCoachContext(root, context);
    if (clearedContextChars) output(`Cleared ${clearedContextChars} characters of oversized active coach history; durable records and imported writing remain stored.`);
    const imported = await importPiWriting({ harness, root, context, sessionsDir });
    output(`Pi import: ${imported.imported} new entries (${imported.aboveThreshold} ≥90%, ${imported.nearThreshold} 60–89%); ${imported.issues.length} source issues.`);
    for (const issue of imported.issues) output(`Import issue: ${issue.filePath}:${issue.line}: ${issue.message}`);

    rl = createInterface({ input, output: outputStream, terminal: Boolean(input.isTTY && outputStream.isTTY) });
    output(showUsage());
    for (;;) {
      let line;
      try {
        line = await rl.question("de> ");
      } catch (error) {
        if (error.code === "ERR_USE_AFTER_CLOSE" || error.code === "ERR_STREAM_PREMATURE_CLOSE") break;
        if (input.destroyed || input.readableEnded) break;
        throw error;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith("/")) {
        await sendInput(root, context, trimmed, output);
        continue;
      }

      const [command, ...args] = trimmed.slice(1).split(/\s+/);
      if (command === "exit" || command === "quit") break;
      if (command === "help") {
        output(showUsage());
      } else if (command === "sync") {
        const [from, through] = args;
        const importedNow = await importPiWriting({ harness, root, context, sessionsDir, from, through: through ?? from });
        output(`Imported ${importedNow.imported} new entries (${importedNow.aboveThreshold} ≥90%, ${importedNow.nearThreshold} 60–89%); flagged ${importedNow.flaggedPasteBlocks} likely pasted blocks in ${importedNow.flaggedPasteEntries} entries; updated ${importedNow.candidateUpdates} prior entries; ${importedNow.issues.length} source issues.`);
        for (const issue of importedNow.issues) output(`Import issue: ${issue.filePath}:${issue.line}: ${issue.message}`);
      } else if (command === "review" || command === "progress") {
        const range = command === "progress" ? {} : parseReviewRange(args);
        const refreshed = await importPiWriting({ harness, root, context, sessionsDir, from: range.from, through: range.through });
        if (refreshed.imported || refreshed.candidateUpdates || refreshed.issues.length) {
          output(`Pi import: ${refreshed.imported} new entries (${refreshed.aboveThreshold} ≥90%, ${refreshed.nearThreshold} 60–89%); flagged ${refreshed.flaggedPasteBlocks} likely pasted blocks in ${refreshed.flaggedPasteEntries} entries; ${refreshed.issues.length} source issues.`);
          for (const issue of refreshed.issues) output(`Import issue: ${issue.filePath}:${issue.line}: ${issue.message}`);
        }
        const entries = selectEntries(await getImportedWriting(harness, root, context), range.from, range.through);
        if (!entries.length) {
          output("No eligible German Pi text found for that period.");
          continue;
        }
        const batches = chunkReviewEntries(entries, reviewMaxChars);
        if (batches.length > 1) output(`Review split into ${batches.length} local batches to fit the model context.`);
        for (let index = 0; index < batches.length; index++) {
          const batch = { index: index + 1, total: batches.length };
          const prompt = command === "progress"
            ? buildProgressPrompt(batches[index], { batch })
            : buildReviewPrompt(batches[index], { ...range, batch });
          const reviewConversation = await createReviewConversation(harness, context, modelRef);
          if (batches.length > 1) output(`Review batch ${batch.index}/${batch.total}`);
          await sendInput(reviewConversation, context, prompt, output);
        }
      } else if (command === "list") {
        const entries = await getImportedWriting(harness, root, context);
        output(entries.map(({ sourceKey, localDate, germanConfidence, excluded, pasteCandidates = [] }) => {
          const activeCandidates = pasteCandidates.filter((candidate) => (candidate.disposition ?? "review") === "review");
          return `${excluded ? "excluded" : germanConfidence.toFixed(2)}${activeCandidates.length ? `\tpaste?${activeCandidates.length}` : ""}\t${localDate}\t${sourceKey}`;
        }).join("\n") || "No imported writing.");
      } else if (command === "paste-candidates") {
        const entries = await getImportedWriting(harness, root, context);
        const candidates = entries.flatMap((entry) => (entry.pasteCandidates ?? [])
          .filter((candidate) => (candidate.disposition ?? "review") === "review")
          .map((candidate) => ({ ...candidate, sourceKey: entry.sourceKey, localDate: entry.localDate })));
        output(candidates.map(({ sourceKey, localDate, paragraphIndex, signals, text }) =>
          `${sourceKey} (${localDate}), paragraph ${paragraphIndex} [${signals.join(", ")}]\n${text}`
        ).join("\n\n") || "No likely pasted blocks flagged. Heuristics are only clues; they can miss pasted text or flag your own writing.");
      } else if (command === "paste-delete-all") {
        if (args.length) throw new Error("Use /paste-delete-all without arguments");
        const entries = await getImportedWriting(harness, root, context);
        const count = entries.reduce((total, entry) => total + (entry.pasteCandidates ?? []).filter((candidate) => (candidate.disposition ?? "review") === "review").length, 0);
        if (!count) {
          output("No active paste candidates to delete.");
          continue;
        }
        if (await confirmBulkPasteDeletion(rl, output, confirmDelete, count)) {
          const result = await deleteAllPasteCandidates({ harness, root, context });
          output(`Omitted ${result.deletedBlocks} paste candidates from future reviews across ${result.changedEntries} entries. Original imported text is unchanged.`);
        }
      } else if (command === "paste-keep" || command === "paste-delete") {
        if (args.length !== 1) throw new Error(`Use /${command} SESSION_ID:ENTRY_ID:PARAGRAPH`);
        const separator = args[0].lastIndexOf(":");
        const sourceKey = args[0].slice(0, separator);
        const paragraphIndex = Number(args[0].slice(separator + 1));
        if (separator <= 0 || !Number.isSafeInteger(paragraphIndex) || paragraphIndex < 1) {
          throw new Error(`Use /${command} SESSION_ID:ENTRY_ID:PARAGRAPH`);
        }
        const disposition = command === "paste-keep" ? "authored" : "deleted";
        await setPasteCandidateDisposition({ harness, root, context, sourceKey, paragraphIndex, disposition });
        output(disposition === "authored"
          ? `Marked paragraph ${paragraphIndex} in ${sourceKey} as authored; it will remain in reviews without a paste warning.`
          : `Removed paragraph ${paragraphIndex} in ${sourceKey} from future reviews; the original imported text is unchanged.`);
      } else if (command === "delete") {
        if (args.length !== 1 || !args[0].includes(":")) throw new Error("Use /delete SESSION_ID:ENTRY_ID");
        const entries = await getImportedWriting(harness, root, context);
        if (!entries.some((entry) => entry.sourceKey === args[0])) throw new Error(`No imported entry found for ${args[0]}`);
        if (await confirmEntryDeletion(rl, output, confirmDelete, args[0])) {
          await deleteImportedEntry({ harness, root, context, sourceKey: args[0] });
          output(`Removed ${args[0]} from active coach imports. It will not be re-imported; the Pi transcript is unchanged.`);
        }
      } else if (command === "exclude") {
        if (args.length !== 1 || !args[0].includes(":")) throw new Error("Use /exclude SESSION_ID:ENTRY_ID");
        const entries = await getImportedWriting(harness, root, context);
        const entry = entries.find((item) => item.sourceKey === args[0]);
        if (!entry) throw new Error(`No imported entry found for ${args[0]}`);
        await excludeImportedEntry({ harness, root, context, sourceKey: args[0] });
        output(`Excluded ${args[0]} (confidence ${entry.germanConfidence.toFixed(2)}) from future reviews. Earlier copies may remain in append-only Durable history.`);
      } else if (command === "export") {
        const entries = await getImportedWriting(harness, root, context);
        output(await exportWriting(entries, args[0]));
      } else if (command === "reset") {
        resetRequested = await requestFullReset(rl, output, confirmReset);
        if (resetRequested) break;
      } else {
        throw new Error(`Unknown command: /${command}; use /help`);
      }
    }
  } finally {
    rl?.close();
    try {
      if (harness) await harness.close(context);
      else if (storage) await storage.close(context);
      if (resetRequested) await eraseDatabaseFiles(databasePath);
    } finally {
      await releaseLock();
    }
  }

  if (resetRequested) {
    await rmdir(dataDir);
    output("All German coach data was deleted. Regular Pi source session files were left unchanged.");
  }
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(`${showUsage()}\n\nModel config: LLAMA_CPP_BASE_URL (loopback only), GERMAN_COACH_MODEL_ID.\n`);
    return;
  }
  process.umask(0o077);
  await runCoach();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`German coach failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
