# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-10-14

### Added
- In-app updates: Cockpit checks GitHub releases and installs a new version with one click.
- Prompt boxes grow with what you type or paste (↵ sends, ⇧↵ adds a line).

### Changed
- The app identifier is now `dev.getcockpit.app`. On first launch Cockpit moves your data folder, caches and saved keys to the new name and leaves a link at the old path, so nothing is lost. macOS asks once more for notification and microphone permission.
- Linux and Windows show Ctrl, Shift and Alt in shortcut labels, and the shortcuts work with Ctrl.
- View cards show marks as a coloured edge and a word, and details as chips.

### Fixed
- Without Claude Code installed, Cockpit no longer crashes its background process. The Wall says how to install it, and **Check again** picks it up without a restart.
- The changes panel no longer stays on "Reading git…" forever when git is missing; it says "git isn't installed".

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
