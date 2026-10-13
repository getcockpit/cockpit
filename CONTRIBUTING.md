# Contributing to Cockpit

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Report a bug or ask for a feature

- **Bug:** [open a bug report](https://github.com/getcockpit/cockpit/issues/new?template=bug_report.yml). Include your OS, the Cockpit version (Settings → About) and `claude --version`.
- **Idea:** [open a feature request](https://github.com/getcockpit/cockpit/issues/new?template=feature_request.yml). Describe the moment that felt slow or confusing; that matters more than a proposed solution.
- **Security issue:** please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Set up a dev build (about 10 min)

You need [Rust](https://rustup.rs), [Bun](https://bun.sh), Claude Code signed in, and on Linux the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/getcockpit/cockpit && cd cockpit
./scripts/dev.sh                    # builds everything and starts the app with hot reload
(cd ui && bunx vite --port 1530)    # or: UI only, no Claude needed → http://localhost:1530/?demo=busy
```

Architecture, conventions and every command are in [AGENTS.md](AGENTS.md) (written for humans and coding agents alike).

## Make a change

1. Fork and branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. Run the checks for what you touched:
   ```bash
   (cd ui && bun run test && bun run build)
   (cd sidecar && bun test && bunx tsc --noEmit -p .)
   (cd src-tauri && cargo test)
   ```
4. For UI work, include a screenshot or a short clip from the demo harness.
5. Open a pull request and fill in the template. CI runs on macOS, Linux and Windows.

## House rules

- **UI:** theme values come only from `ui/src/design/tokens.css` (`var(--mr-*)`, never a hex). Square corners, colour only for state. Keep the `data-mr` attributes on rendered elements.
- **Platforms:** unix-only code goes behind `#[cfg(unix)]` or `#[cfg(target_os = "macos")]` with a Windows path.
- **Privacy:** never read, log or store Claude credentials. Everything stays on the user's machine.
- **Commits:** short imperative subject ("Fix the lamp colour on errors"), with the why in the body when it isn't obvious.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
