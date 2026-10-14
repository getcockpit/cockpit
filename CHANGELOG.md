# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-14

### Added
- One-line installer for macOS and Linux: `curl -fsSL https://getcockpit.github.io/install.sh | bash`. It skips the macOS "unidentified developer" prompt.
- Fixed-name release downloads (`Cockpit-macos.dmg`, `Cockpit-linux-x86_64.AppImage`) that always point at the latest release.
- An installer smoke test that installs every release on clean macOS, Windows and Linux machines and checks the app starts.

### Changed
- Windows and Linux installers name **Cockpit** as the publisher (it was "minorityreport").
- The demo's risk example is a production `DROP TABLE … CASCADE` that gets denied.

### Fixed
- Linux: Stop now ends only the run's own process group. Before, it could signal Cockpit itself.

## [0.1.0] - 2026-10-13

First public release.

### Added
- Run many Claude Code sessions in parallel, each in its own git worktree.
- **Needs you** queue: permissions, questions and plan approvals from every session, answered with one key.
- Focus view with the plan, a change map flagged by risk, and the exact command waiting for approval.
- Working docs: plan sessions write a block-by-block map you annotate, regenerate and build from.
- Timeline of what ran, what's next and which session will need you.
- Guided PR review and Address flows.
- Workspaces with separate Claude memory and history.
- Raw transcript (`⌘R`) and terminal handoff (`⌘T`).
- Installers for macOS (universal `.dmg`), Linux (`.AppImage`, `.deb`, `.rpm`) and Windows (`.msi`, `.exe`).

[Unreleased]: https://github.com/getcockpit/cockpit/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/getcockpit/cockpit/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/getcockpit/cockpit/releases/tag/v0.1.0
