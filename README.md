# Pi German Coach

A separate interactive coach backed by `@earendil-works/pi-durable`. It reads Pi session files read-only and imports German or uncertain text from user messages. Assistant messages, tool output, and system content are excluded. First run scans retained session files; later scans deduplicate by session and entry ID. Source files are never changed.

## Install with Nix

The flake exposes `packages.<system>.default` and a `german-coach` executable:

```sh
nix run github:npujol/german-language-coach
```

Home Manager configurations can install `packages.${pkgs.system}.default` from the pinned flake input.

## Start

The Home Manager integration uses Qwen2.5 1.5B Instruct at `http://127.0.0.1:8094/v1`, separate from regular Pi's llama.cpp endpoint. Start it in the background with `qwen25-instructor`; its log is `~/Library/Logs/qwen25-instructor.log`. The coach defaults to model ID `qwen2.5-1.5b-instruct`. Override with `GERMAN_COACH_BASE_URL` and `GERMAN_COACH_MODEL_ID` if needed. Direct installs fall back to `LLAMA_CPP_BASE_URL` when set, otherwise the same coach-specific defaults. Reviews default to batches of 8,000 characters; adjust with `GERMAN_COACH_REVIEW_CHARS`. An optional `LLAMA_CPP_API_KEY` is sent only to the configured loopback endpoint.

```sh
german-coach
```

Only loopback endpoints (`127.0.0.1` or `[::1]`) are accepted. Coach requests use the configured llama.cpp endpoint only; redirects and other destinations are blocked. No text is sent to a model during import. Entering text or requesting a review sends it to the local model.

## Commands

- `/sync [YYYY-MM-DD [YYYY-MM-DD]]` — import locally, without a model request.
- `/review` or `/review live` — review today's local-date entries.
- `/review YYYY-MM-DD [YYYY-MM-DD]` — review a date or date range.
- `/review all` — review all imported, non-excluded entries; large reviews are split into local batches.
- `/progress` — ask the local model for a learning-progress summary.
- `/list` — list imported source IDs, dates, and classifications; `paste?N` marks entries with N suspicious paragraphs.
- `/paste-candidates` — inspect paragraphs heuristically flagged as possible pasted blocks, including the signals that triggered the flag.
- `/paste-keep SESSION_ID:ENTRY_ID:PARAGRAPH` — mark a flagged paragraph as authored; the choice survives sync.
- `/paste-delete SESSION_ID:ENTRY_ID:PARAGRAPH` — omit a flagged paragraph from future reviews while preserving the original imported text.
- `/delete SESSION_ID:ENTRY_ID` — confirm and remove an entry from active coach imports; a tombstone prevents re-import.
- `/exclude SESSION_ID:ENTRY_ID` — omit an entry from future reviews without removing it from the active import list.
- `/export [FILE]` — print a local export or create a new file without overwriting an existing file.
- `/reset` — type `RESET` to erase the complete Durable coach database. Regular Pi transcripts are left unchanged.
- `/exit` — close the coach.

Plain text entered in the coach is treated as a direct practice request. The coach does not send reminders or interrupt normal Pi work.

## Local data

The default database is `$XDG_DATA_HOME/pi-german-coach/coach.sqlite`, or `~/.local/share/pi-german-coach/coach.sqlite` when `XDG_DATA_HOME` is unset. It contains imported writing, source references, and Durable conversations. Reviews use an isolated conversation per batch to keep model context bounded. Oversized interactive context is reset with a notice; stored Durable records remain. The app enforces a single process owner for the database.

The first import reads all retained Pi session files below `PI_SESSIONS_DIR` (default `~/.pi/agent/sessions`). Low-confidence or short text is retained as `uncertain` and included in requested reviews. Paragraphs that look potentially pasted (long blocks, structured formatting, multiple links, or a strong language shift) are attached as `pasteCandidates`, surfaced by `/sync`, `/list`, and `/paste-candidates`, and passed to the coach as uncertain authorship. Heuristics never remove text on their own. `/paste-delete` only omits a paragraph from future reviews; the original Pi transcript and imported source text stay unchanged. `/delete` removes an entry from the active coach document and tombstones its source key, but Durable history may retain prior snapshots. Local language detection can miss or misclassify text; `/sync` reports malformed source lines.

## Development

```sh
npm ci
npm test
nix flake check
```
