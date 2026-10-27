import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { francAll } from "franc-min";

export const DEFAULT_PI_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const MIN_CONFIDENT_GERMAN_LENGTH = 40;
const MAX_CLASSIFICATION_SAMPLE = 4000;

function localDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function classifyGermanText(text) {
  const sample = text.trim();
  if (!sample) return "other";
  if (sample.length < MIN_CONFIDENT_GERMAN_LENGTH) return "uncertain";

  const rankings = francAll(sample.slice(0, MAX_CLASSIFICATION_SAMPLE), { minLength: 10 });
  if (!rankings.length || rankings[0][0] === "und") return "uncertain";

  const germanIndex = rankings.findIndex(([language]) => language === "deu");
  if (rankings[0][0] === "deu") return "german";
  if (germanIndex >= 0 && germanIndex < 3) return "uncertain";
  if (sample.length > MAX_CLASSIFICATION_SAMPLE) return "uncertain";
  return "other";
}

export function extractUserText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function sourceEntryKey(sessionId, entryId) {
  if (typeof sessionId !== "string" || !sessionId.trim()) throw new TypeError("sessionId is required");
  if (typeof entryId !== "string" || !entryId.trim()) throw new TypeError("entryId is required");
  return `${sessionId}:${entryId}`;
}

async function sessionFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sessionFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files.sort();
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export async function scanPiSessions({ root = DEFAULT_PI_SESSIONS_DIR, from, through } = {}) {
  if (from && !isCalendarDate(from)) throw new TypeError("from must be a valid YYYY-MM-DD date");
  if (through && !isCalendarDate(through)) throw new TypeError("through must be a valid YYYY-MM-DD date");
  if (from && through && from > through) throw new RangeError("from must not be after through");

  const resolvedRoot = resolve(root);
  const files = await sessionFiles(resolvedRoot);
  const messages = [];
  const issues = [];
  const seenSources = new Map();

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    let sessionId = null;

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        issues.push({ filePath, line: index + 1, message: `malformed JSON: ${error.message}` });
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        issues.push({ filePath, line: index + 1, message: "entry must be an object" });
        continue;
      }

      if (entry.type === "session") {
        if (typeof entry.id !== "string" || !entry.id.trim()) {
          issues.push({ filePath, line: index + 1, message: "session entry has no id" });
          sessionId = null;
        } else {
          sessionId = entry.id;
        }
        continue;
      }

      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const text = extractUserText(entry.message.content);
      if (!text) continue;
      if (!sessionId) {
        issues.push({ filePath, line: index + 1, message: "user message has no preceding session id" });
        continue;
      }
      if (typeof entry.id !== "string" || !entry.id.trim()) {
        issues.push({ filePath, line: index + 1, message: "user message has no entry id" });
        continue;
      }
      if (typeof entry.timestamp !== "string" || !localDate(entry.timestamp)) {
        issues.push({ filePath, line: index + 1, message: "user message has no valid timestamp" });
        continue;
      }

      const date = localDate(entry.timestamp);
      if (from && date < from) continue;
      if (through && date > through) continue;

      const sourceKey = sourceEntryKey(sessionId, entry.id);
      const priorText = seenSources.get(sourceKey);
      if (priorText !== undefined) {
        if (priorText !== text) issues.push({ filePath, line: index + 1, message: `conflicting duplicate source entry ${sourceKey}` });
        continue;
      }
      seenSources.set(sourceKey, text);

      const classification = classifyGermanText(text);
      if (classification === "other") continue;
      messages.push({
        sourceKey,
        sessionId,
        entryId: entry.id,
        timestamp: entry.timestamp,
        localDate: date,
        filePath,
        text,
        classification,
      });
    }
  }

  return { messages, issues };
}
