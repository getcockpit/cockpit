# Minority report

A visual-first desktop front-end for Claude Code. The PRD and design plan live in the docs: **Minority report**.

## Layout

| Path | What |
|---|---|
| `src-tauri/` | Rust core (Tauri v2): window, sidecar supervision, later sessions, event log, picker |
| `ui/` | React UI. Theme tokens are in `ui/src/design/tokens.css` (Control Room) |
| `sidecar/` | TypeScript process that will host the official Agent SDK. Speaks NDJSON over stdio |
| `scripts/` | `dev.sh` (run from source), `build-sidecar.sh` |
| `design/mockups/` | Snapshots of the MR-25 visual-direction canvas |

## Run

Needs: Rust (rustup), the Tauri CLI (`cargo install tauri-cli --version '^2'`), and Bun.

```bash
./scripts/dev.sh          # builds the sidecar, installs UI deps, starts the app with hot reload
```

`scripts/dev.sh` is also how the app will rebuild itself from inside the app (MR-33).

## Test

```bash
(cd sidecar && bun test)  # sidecar protocol over real stdio
(cd ui && bun run build)  # type-check + bundle
(cd src-tauri && cargo build)
```

## Sidecar protocol

One JSON object per line.

- **Sidecar → core:** `{"type":"ready",…}`, `{"type":"pong","id":…}`, `{"type":"error",…}`
- **Core → sidecar:** `{"type":"ping","id":…}`

MR-2 extends the protocol for Agent SDK sessions.
