# Developing Cockpit

See also `CLAUDE.md` (architecture, conventions, commands) and `docs/` (PRD, design plan, decision log).

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

One JSON object per line. The types are in `sidecar/src/protocol.ts`.

- **Core → sidecar:**
  - `ping`
  - `start {session, cwd, prompt, resume?, tools?}`
  - `send {session, text}`
  - `interrupt {session}`
  - `stop {session}`
  - `permission_response {session, request_id, decision}`
  - `tool_result {session, call_id, text, is_error?}`
- **Sidecar → core:**
  - `ready {claude}`
  - `pong`
  - `session_started {session, sdk_session_id}`
  - `sdk {session, message}` (every Agent SDK message, as is)
  - `permission_request {session, request_id, tool, input, suggestions}`
  - `tool_call {session, call_id, tool, args}`
  - `session_ended {session, ok}`
  - `error`

Tools passed in `start.tools` become the in-process `mr` MCP server; every call is relayed to the core as `tool_call`.

**Live checks** (spend a little subscription usage): `bun run spike/probe.ts` and `bun run spike/live-session.ts`. Set `MR_SIDECAR_BIN=../src-tauri/binaries/mr-sidecar-<triple>` to test the compiled binary.

## Releasing

Push a tag `vX.Y.Z` (after bumping `version` in `src-tauri/tauri.conf.json`). The `Release` workflow builds the universal `.dmg`, the Linux `.AppImage`/`.deb`/`.rpm` and the Windows `.msi`/`.exe`, and attaches them to the GitHub release. Locally, `./scripts/package.sh` builds the `.dmg` into `dist/`.
