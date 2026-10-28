import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { germanConfidenceScore, isExtensionMessage, scanPiSessions, sourceEntryKey } from "../src/pi-session-import.mjs";

const roots = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-german-sessions-"));
  roots.push(root);
  return root;
}

function localNoon(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date, 12).toISOString();
}

function message(id, timestamp, role, content) {
  return { type: "message", id, timestamp, message: { role, content } };
}

function line(value) {
  return JSON.stringify(value);
}

test("returns a 0-1 confidence score for German, 0 for non-German", () => {
  const highScore = germanConfidenceScore("Ich lerne gerade Deutsch und möchte meine Texte jeden Tag verbessern.");
  assert.ok(highScore > 0.95, `Expected high German confidence, got ${highScore}`);
  assert.ok(germanConfidenceScore("Please help me debug this issue in production today.") < 0.8, "Expected below threshold for English");
  assert.equal(germanConfidenceScore("  "), 0);
  assert.equal(germanConfidenceScore(""), 0);
});

test("scores German even when another language ranks higher on short text", () => {
  assert.ok(germanConfidenceScore("Ich habe ein Problem in Produktion") >= 0.9);
  assert.ok(germanConfidenceScore("Guten Morgen") >= 0.8);
  assert.ok(germanConfidenceScore("Das ist gut") >= 0.8);
});

test("imports only user-authored German text with confidence >= 0.8, with stable provenance", async () => {
  const root = await fixtureRoot();
  const projectDir = join(root, "--repo--");
  await mkdir(projectDir);
  const filePath = join(projectDir, "2026-10-20T10-00-00-000Z_session.jsonl");
  const german = "Ich lerne gerade Deutsch und möchte meine Texte jeden Tag verbessern.";
  const shortGerman = "Ich habe ein Problem in Produktion";
  const english = "Please help me debug this issue in production today.";
  const source = [
    { type: "session", id: "session-a" },
    message("german-1", localNoon("2026-10-20"), "user", [{ type: "text", text: german }, { type: "image", data: "ignored" }]),
    message("short-1", localNoon("2026-10-20"), "user", shortGerman),
    message("english-1", localNoon("2026-10-20"), "user", english),
    message("assistant-1", localNoon("2026-10-20"), "assistant", german),
    message("tool-1", localNoon("2026-10-20"), "toolResult", german),
  ].map(line).join("\n") + "\n";
  await writeFile(filePath, source);

  const { messages, issues } = await scanPiSessions({ root });

  assert.deepEqual(issues, []);
  assert.deepEqual(messages.map(({ entryId, germanConfidence }) => [entryId, germanConfidence]), [
    ["german-1", germanConfidenceScore(german)],
    ["short-1", germanConfidenceScore(shortGerman)],
  ]);
  assert.equal(messages[0].text, german);
  assert.equal(messages[0].sessionId, "session-a");
  assert.equal(messages[0].timestamp, localNoon("2026-10-20"));
  assert.equal(messages[0].sourceKey, "session-a:german-1");
  assert.equal(await readFile(filePath, "utf8"), source, "scanner must not mutate source transcript");
});

test("scans nested sessions and filters by local message date", async () => {
  const root = await fixtureRoot();
  const nested = join(root, "--repo--", "nested");
  await mkdir(nested, { recursive: true });
  const session = [
    { type: "session", id: "session-dates" },
    message("day-1", localNoon("2026-10-20"), "user", "Ich lerne gerade Deutsch und schreibe heute eine längere Nachricht."),
    message("day-2", localNoon("2026-10-21"), "user", "Ich lerne gerade Deutsch und schreibe morgen eine längere Nachricht."),
  ].map(line).join("\n");
  await writeFile(join(nested, "session.jsonl"), session);

  const { messages } = await scanPiSessions({ root, from: "2026-10-21", through: "2026-10-21" });
  assert.deepEqual(messages.map(({ entryId, localDate, germanConfidence }) => [entryId, localDate, germanConfidence]), [["day-2", "2026-10-21", germanConfidenceScore("Ich lerne gerade Deutsch und schreibe morgen eine längere Nachricht.")]]);
  await assert.rejects(scanPiSessions({ root, from: "2026-10-22", through: "2026-10-21" }), /from must not be after through/);
  await assert.rejects(scanPiSessions({ root, from: "2026-02-30" }), /valid YYYY-MM-DD date/);
});

test("deduplicates repeated source entries and reports malformed or truncated JSONL lines", async () => {
  const root = await fixtureRoot();
  const german = "Ich lerne gerade Deutsch und möchte meine Texte jeden Tag verbessern.";
  const duplicate = message("same-entry", localNoon("2026-10-20"), "user", german);
  const filePath = join(root, "session.jsonl");
  await writeFile(filePath, [
    line({ type: "session", id: "session-dup" }),
    line(duplicate),
    line(duplicate),
    "{malformed",
    "{truncated",
  ].join("\n"));

  const { messages, issues } = await scanPiSessions({ root });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sourceKey, "session-dup:same-entry");
  assert.equal(messages[0].germanConfidence, germanConfidenceScore(german));
  assert.deepEqual(issues.map(({ line: lineNumber }) => lineNumber), [4, 5]);
  assert.ok(issues.every(({ filePath: issuePath }) => issuePath === filePath));
});

test("reports missing source identity rather than guessing it", async () => {
  const root = await fixtureRoot();
  await writeFile(join(root, "session.jsonl"), line(message("entry-without-session", localNoon("2026-10-20"), "user", "Ich lerne gerade Deutsch und schreibe eine längere Nachricht.")));
  const { messages, issues } = await scanPiSessions({ root });
  assert.deepEqual(messages, []);
  assert.match(issues[0].message, /no preceding session id/);
  assert.throws(() => sourceEntryKey("session", ""), /entryId is required/);
});

test("excludes entries below the German confidence threshold", async () => {
  const root = await fixtureRoot();
  const highConf = "Ich lerne gerade Deutsch und möchte meine Texte jeden Tag verbessern.";
  const lowConf = "Please help me debug this issue in production today.";
  const filePath = join(root, "session.jsonl");
  await writeFile(filePath, [
    line({ type: "session", id: "session-conf" }),
    line(message("high-1", localNoon("2026-10-20"), "user", highConf)),
    line(message("low-1", localNoon("2026-10-20"), "user", lowConf)),
  ].join("\n"));

  const { messages } = await scanPiSessions({ root });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].entryId, "high-1");
  assert.ok(messages[0].germanConfidence >= 0.8);
});

test("fails clearly when the configured Pi session directory is unavailable", async () => {
  await assert.rejects(scanPiSessions({ root: join(tmpdir(), "does-not-exist-pi-session-root") }), /ENOENT/);
});

test("skips user messages that are extension/skill injections", async () => {
  const root = await fixtureRoot();
  const skillText = '<skill name="openspec-apply-change" location="/foo/.pi/skill/SKILL.md">Implement tasks.</skill>\n\nBitte mach das.';
  const realUserText = "Ich lerne gerade Deutsch und möchte meine Texte jeden Tag verbessern.";
  const filePath = join(root, "session.jsonl");
  await writeFile(filePath, [
    line({ type: "session", id: "session-ext" }),
    line(message("skill-1", localNoon("2026-10-20"), "user", skillText)),
    line(message("real-1", localNoon("2026-10-20"), "user", realUserText)),
  ].join("\n"));

  const { messages } = await scanPiSessions({ root });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].entryId, "real-1");
  assert.equal(messages[0].germanConfidence, germanConfidenceScore(realUserText));
});

test("isExtensionMessage detects skill tags", () => {
  assert.ok(isExtensionMessage("<skill name=\"foo\">bar</skill>"));
  assert.ok(isExtensionMessage("<Skill name=\"foo\">bar</Skill>"));
  assert.ok(!isExtensionMessage("Ich lerne Deutsch."));
  assert.ok(!isExtensionMessage(""));
});
