# Pi German Coach

A separate interactive coach backed by `@earendil-works/pi-durable`. It reads Pi session files read-only and imports German or uncertain text from user messages. Assistant messages, tool output, and system content are excluded. First run scans retained session files; later scans deduplicate by session and entry ID. Source files are never changed.

## Install with Nix

The flake exposes `packages.<system>.default` and a `german-coach` executable:

```sh
nix run github:npujol/german-language-coach
```

Home Manager configurations can install `packages.${pkgs.system}.default` from the pinned flake input.

## Start

The local llama.cpp server must be running at `LLAMA_CPP_BASE_URL` (the Home Manager default is `http://127.0.0.1:8091/v1`). If its `/v1/models` endpoint lists one model, that model is selected. If it lists multiple, set `GERMAN_COACH_MODEL_ID` to one of those IDs. Reviews default to batches of 8,000 characters; adjust with `GERMAN_COACH_REVIEW_CHARS` if needed. An optional `LLAMA_CPP_API_KEY` is sent only to this local endpoint.

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
- `/list` — list imported source IDs, dates, and classifications.
- `/exclude SESSION_ID:ENTRY_ID` — omit an entry from future reviews. Earlier copies may remain in append-only Durable history.
- `/export [FILE]` — print a local export or create a new file without overwriting an existing file.
- `/reset` — type `RESET` to erase the complete Durable coach database. Regular Pi transcripts are left unchanged.
- `/exit` — close the coach.

Plain text entered in the coach is treated as a direct practice request. The coach does not send reminders or interrupt normal Pi work.

## Local data

The default database is `$XDG_DATA_HOME/pi-german-coach/coach.sqlite`, or `~/.local/share/pi-german-coach/coach.sqlite` when `XDG_DATA_HOME` is unset. It contains imported writing, source references, and the Durable conversation. The app enforces a single process owner for the database.

The first import reads all retained Pi session files below `PI_SESSIONS_DIR` (default `~/.pi/agent/sessions`). Low-confidence or short text is retained as `uncertain` and included in requested reviews. Local language detection can still miss or misclassify text; `/sync` reports malformed source lines.

## Development

```sh
npm ci
npm test
nix flake check
```
