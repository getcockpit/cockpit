# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.5] - 2026-10-15

### Added
- When Claude Code's sign-in expires, the session says so instead of a dead "Not logged in" line. **Sign in…** opens Claude's own /login for that workspace and sends your refused message again once you exit; **Already signed in · send again** retries right away. These sessions wait in the needs-you queue, with a notification.
- Move a session to another workspace from the Focus header: the conversation resumes there under that workspace's sign-in.

### Fixed
- **Back to visual** brings the message box back after a terminal takeover.
- Esc closes the model picker and Builds when they were opened by shortcut.

## [0.1.4] - 2026-10-14

### Added
- Working docs have a lifecycle: each shows Drafting, Ready to build, Building or Shipped on its header and Wall tile. A doc is marked shipped by itself once every branch building it is merged into main; **Mark shipped** covers work built another way. **Done** archives a shipped doc, and **Drop** closes one that won't be built.
- The Wall offers one-click **Mark done** for shipped docs, and asks you to build or drop a doc that hasn't moved in 3 days.
- Build sessions end by adding a "What shipped" note to their doc: what was built, where it differed from the plan, and follow-ups.

### Changed
- A finished session with every plan step ticked off shows ◇ Ready to review instead of ✓ Done; Done is kept for sessions that have ended.

## [0.1.3] - 2026-10-14

### Added
- Fewer permission prompts: sessions start in Claude Code's auto mode, which approves routine reads, edits and commands and asks only about risky ones. The intro (or a one-time prompt, if you've used Cockpit before) asks how often sessions should ask; change it any time in Settings → Sessions → Ask before.
- **Never ask**, behind a full-screen disclaimer: everything goes through except high-risk actions (rm -rf, force-push, sudo, piping a download into a shell, DROP TABLE, kubectl or terraform apply or destroy, migrations), edits outside the project, and Claude's own questions and plans. A red Never ask lamp shows on the Wall while it's on.
- Image review: Claude can show images as a gallery or a side-by-side compare. In the Lightbox you approve, reject, comment, pin numbered notes, draw, and add arrows and labelled boxes; your marks are sent back as text plus a PNG with them drawn in. Your own pasted screenshots can be marked up the same way.
- An active `/goal` shows in Focus with its condition and the last check, with Cancel, and as a ◎ mark on the Wall tile.
- The message box matches Claude Code: paste images and files, drop PDFs, and pick @files and /skills.
- Voice: tap ⌥ Space to talk hands-free (tap again or ↵ to send, Esc to cancel); holding still works as push-to-talk.

### Fixed
- Dictation sometimes pasted nothing; it now always delivers the text.
- Leaving the window while holding the voice key turns the microphone off.
- A fresh data folder opens on the Personal workspace instead of an empty wall.

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
