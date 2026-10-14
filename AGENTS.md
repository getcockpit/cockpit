# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor and others) working in this repository.

Cockpit is a desktop front-end for Claude Code (macOS first; Linux and Windows too). It runs several Claude Code sessions in parallel and shows them as visuals (decision cards, doc maps, change maps, lamps) instead of terminal text, on the user's own Claude subscription.

## Commands

```bash
./scripts/dev.sh                     # bootstrap + run the app: Vite hot reload, core from build slot a/b; in-app Update rebuilds + restarts (MR_WATCH=1: cargo tauri dev)
./scripts/bootstrap.sh               # make a fresh checkout/worktree buildable (deps, sidecar, dictate helper)
./scripts/package.sh                 # shareable installer: dist/Cockpit-<version>.dmg, universal, ad-hoc signed (docs/INSTALL.md)

(cd ui && bun run test)              # vitest: reducer, picker, suggestions (fixtures from real sessions)
(cd ui && bunx vitest run src/state/reduce.test.ts -t "workspaces")   # one test
(cd ui && bun run build)             # type-check + bundle
(cd sidecar && bun test)             # protocol tests over real stdio (scripted fake query)
(cd sidecar && bunx tsc --noEmit -p .)
(cd src-tauri && cargo test)         # event log, docs, worktrees, flows, self-build supervisor, PTY…
(cd src-tauri && cargo test docs::)  # one module

./scripts/e2e-ui.sh                  # UI end-to-end: every JTBD flow headless via PinchTab over the demo harness (no Claude); `J4` runs matching flows
(cd ui && bunx vite --port 1530)    # UX demo harness: http://127.0.0.1:1530/?demo=fresh|empty|busy|archive (no Claude)
./scripts/selftest.sh                # end-to-end through the real app + sidecar + claude (uses a little usage)
./scripts/selftest-{doc,resume,flow,address,terminal,selfbuild,workspace,view,plan,title,update,layer,skip,askfirst,attach}.sh
```

**Self-tests:**
- They run the real app binary with `MR_SELFTEST=<mode>` and a temporary `MR_DATA_DIR`, then check the event log with `sqlite3`.
- `selfbuild` needs no Claude usage; the others need a signed-in `claude`.

## Architecture

```
React UI (ui/) ──Tauri IPC──▶ Rust core (src-tauri/) ──NDJSON stdio──▶ sidecar (Bun, Agent SDK) ──▶ the user's `claude`
                                  │                                        ▲
                                  └─ SQLite event log ◀── every message ───┘
```

### Sidecar (`sidecar/`)
- The only code that talks to Claude Code, through the official Agent SDK under the user's own login. Never use `--bare`, and never read or store tokens.
- **Protocol:** `sidecar/src/protocol.ts`.
- **Sessions:** `sessions.ts` keeps a push-based prompt stream so follow-ups go into the same run. `canUseTool` becomes `permission_request`/`permission_response`.
- **`mr` MCP tools:** declared by the core per session; `mcp.ts` relays every call to the core as `tool_call`.
- **Which `claude` it drives:** `claude-path.ts` picks the user's native install and skips copies bundled inside other apps.

### Event log (`src-tauri/src/eventlog.rs`)
- Append-only SQLite: monotonic ULID ids, `kind`, JSON payload, optional anchor.
- **Kinds:** `sidecar.*` (agent messages, recorded before the UI sees them), `ui.*` (user actions, logged inside the Rust command that performs them), `doc.*`, `flow.*`, `selfbuild.*`.
- **State is rebuilt by replay:** the UI reducer is `ui/src/state/reduce.ts`; Rust folds docs in `docs.rs`.
- **House rules:** no foreign keys, enums, CHECKs or literal DEFAULTs; explicit column lists.

### Rust modules — one per capability
| Module | Does |
|---|---|
| `sidecar.rs` | Supervision, session commands, routing tool calls |
| `docs.rs` | Working docs plus the `doc_*` tools |
| `flows.rs` | `review_*` / `address_*` tools and their prompt append |
| `cockpit_layer.rs` | The Cockpit layer (decision 34): draws cards, plans and titles after each turn on its own key, and meters every Cockpit model call as `cockpit.usage` |
| `views.rs` | `render_view` (Claude composes catalog views, decision 26) `plan_set` (Claude's plan for the Plan panel) and `title_set` (the thread's title) |
| `worktree.rs` | One worktree per blank session |
| `workspaces.rs` | Per-workspace `CLAUDE_CONFIG_DIR` with shared files symlinked |
| `terminal.rs` | PTY takeover |
| `voice.rs` | Runs the `mr-dictate` helper (`dictate/main.swift`) |
| `changes.rs` | Git changes, diffs, god-mode marks to `evals/marks.jsonl` |
| `update.rs` | One-click Update: pending app commits on main, background build of the other dev slot, restart via `dev.sh` |
| `selfbuild.rs` | Build, store, relaunch via supervisor with health check and fallback (god-mode fix builds, history) |
| `daily.rs` | Daily-driver counter |
| `selftest.rs` | Self-test modes |

### UI (`ui/src/`)
- **Rendering path:** `state/` (replayed store) → `picker/` → `components/` → `screens/`.
  - `picker/pick.ts`: layer-1 mapping to catalog components, under 16 ms.
  - `picker/suggest.ts`: suggested-next rules.
  - `components/`: the catalog.
- **Screens:**
  - `Wall`: lamps, needs-you queue, running grid, review tray.
  - `Focus`: decisions, transcript or flow, plan, change map.
  - `DocMap`: semantic zoom, walkthrough, decision blocks.
  - `Flows`: Review, Address.
  - Overlays: `StartPicker`, `GodMode`, `Builds`, `Workspaces`, `Terminal`, `Voice`.

## Conventions that aren't obvious

- **Theme:** the Control Room theme (decision 15) lives only in `ui/src/design/tokens.css`. Components use `var(--mr-*)`, never a hex value, so themes can swap (MR-26).
  - Light only.
  - Square corners (2px at most); depth from fills, not hairline borders or shadows.
  - Colour only for state: amber = needs you, red = error, teal = selected, green = done.
- **`data-mr` tags:** every rendered element carries `data-mr` (component), `data-mr-source` (session, request or block id) and optionally `data-mr-layer`. God mode and point-and-talk depend on these, so keep them when adding UI.
- **Pointing:** ⌘-click goes deeper, ⌥-click starts a side session (discover). Use `components/pointer.ts`.
- **Starting sessions:** new ones go through `api.start(cwd, prompt, kind, worktree?, workspace?)`. Blank sessions in a git repo get a worktree at `<repo>-worktrees/<slug-id>` on branch `mr/<slug-id>`. Review and Address don't, because the user's commands manage worktrees.
- **Environment variables:**

  | Variable | Purpose |
  |---|---|
  | `MR_DATA_DIR` | Data folder |
  | `MR_SESSION_CAP` | Session cap: how many may be mid-turn at once (default 10; Settings → Sessions overrides it) |
  | `MR_CLAUDE_PATH` | Which `claude` to drive |
  | `MR_APP_REPO` | This repo, for god mode and self-build |
  | `MR_SELFTEST` | Self-test mode |
  | `MR_BUILD_ID` | Set by the self-build supervisor |
  | `MR_AUTO_RESUME` | Set by the self-build supervisor |
  | `MR_FALLBACK` | Set by the self-build supervisor |
  | `MR_COCKPIT_API_KEY`, `MR_COCKPIT_BASE_URL` | The Cockpit layer's key and endpoint (the Keychain and api.anthropic.com otherwise) |
  | `MR_DEV_LOOP`, `MR_DEV_SLOT` | Set by `dev.sh`: Update is available, and which build slot is running |

- **Scripts and PATH:** scripts and self-builds must work with a minimal GUI PATH. They add cargo, bun and mise paths themselves, and the UI build runs on bun's runtime (`bun --bun`).
- **Platforms:** macOS is primary; CI runs `cargo test` on macOS, Linux and Windows, plus the selfbuild self-test on macOS. Keep unix-only calls behind `#[cfg(unix)]` / `#[cfg(target_os = "macos")]` with a Windows path, and gate macOS-only tests the same way.
- **Releases:** bump `version` in `src-tauri/tauri.conf.json`, push a `vX.Y.Z` tag; `.github/workflows/release.yml` builds and attaches every installer.
