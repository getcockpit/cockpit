# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.14] - 2026-10-20

### Changed
- **Spawned sessions sit with their parent:** on the Wall, a session and the sessions it spawned form one group, drawn like a doc and its sessions: a header naming the parent over the children's tiles, each tagged "↳ spawned". Groups share a row, and single sessions get the row below. On the Overview, a spawned session sits under its parent.
- **Recurring sessions and suggestions stay in their workspace:** the Wall's Recurring count and list show only the current workspace's schedules, and workspace-specific suggestions only show where they apply.

## [0.1.13] - 2026-10-20

### Added
- **Sessions can start sessions:** Claude can hand independent work to a new Cockpit session with the `session_spawn` tool, with no approval needed. It picks the folder, the workspace and whether the new session gets its own worktree. Spawned sessions show ↳ on the Wall with their parent's name, can't spawn more, and count toward the session cap.
- **Spawned sessions report back:** each turn a spawned session finishes sends its reply to the session that started it ("↳ child →"). If the parent has stopped, the report waits for your next message to it.
- **Move a working session:** moving a session that's mid-turn to another workspace is queued until its turn ends, instead of being refused. Cancel it from the same menu.

### Changed
- **Recurring sessions are generic:** the schedule editor no longer has a PR review mode or PR presets; a recurring session runs any prompt.

## [0.1.12] - 2026-10-20

### Changed
- **Less usage overhead:** a card or a finished plan now ends Claude's turn on the spot, instead of Claude spending one more call (a full re-read of the context) just to stop. In a benchmark against plain `claude -p`, Cockpit's extra cost fell from about 9% to under 1%.
- **Recurring review also catches PRs you commented on but haven't approved:** a "ship it" left as a comment no longer drops the PR from review-mode lists. Each unapproved head gets one review.
- **Doc groups are at most two tiles wide:** a plan and its build session sit side by side instead of spanning the whole Running row.

## [0.1.11] - 2026-10-20

### Added
- **Recurring review schedules:** a schedule can now run in review mode. Each slot lists the open PRs of the folder's GitHub repo that need you, and starts one Review session per PR whose latest commit isn't reviewed or being reviewed yet (shared with Auto-review, so a PR is never reviewed twice). Reviews still stop before publishing. The editor offers an "Each run" choice, and the history lists the PRs each run started.

## [0.1.10] - 2026-10-19

### Changed
- **Repeat… sits beside the session title:** a quiet ↻ Repeat… link (Schedule… on a recurring run) instead of a button in the action row, which no longer wraps Mark done onto a second line. ⌘⇧R opens it from anywhere in the session.

## [0.1.9] - 2026-10-19

### Added
- **Cron-like schedules for recurring sessions:** a visual builder (presets, then rows for minutes, hours, weekdays and days of month) plus an editable cron expression, with a plain-English label and the next five runs. "Every 5 min during work hours" is one click. Existing schedules keep working.
- **"Only run when…" checks:** a recurring session can have a shell command that runs first, for free. Claude starts only when it exits 0 and prints something new since the last run, and what it printed goes into the prompt. Comes with presets (review requests, your PRs' reviews and CI, new commits on main). The list shows the last check: "checked 2m ago · no change · skipped 7×".
- **Auto-review can watch chosen repos:** Settings → Sessions → Reviews → Also watch, for teams that never request reviewers.

### Changed
- A recurring run is skipped while the schedule's previous run is still going.
- PR review/address suggestions and auto-review show only in the workspace that works in that repo.

## [0.1.8] - 2026-10-19

### Added
- **Recurring sessions:** save a prompt, folder, workspace and cadence (daily, weekdays, chosen days, every N hours), and Cockpit starts a fresh session when it's due, catching up once on missed runs. Open them from ↻ Recurring on the Wall or the tray, or turn a session into one with **Repeat…**. Finished runs land on the Wall marked new. Cockpit can keep running in the background (tray icon, start at login).
- **Doc groups:** on the Wall, a working doc and the sessions that plan and build it show as one group (▤ plan / ▤ build); the Overview nests them under the doc too. A session outside a group carries a chip naming its doc, and clicking it opens the doc.
- **Plan and build stay in sync:** when one session changes the doc's question, design, scope or risk, the doc's other running sessions get a short note right away. Other changes wait and go in front of your next message to that session, even across a restart.
- Copy button on every rendered text block: turns, code fences and view text.
- The folder picker can create a folder that doesn't exist yet.
- @ mentions list folders outside the session folder (`@~/`, `@../`, `@./`, `@/`), including paths with spaces.

### Changed
- PR review and address sessions archive themselves once the review is posted or the fixes are pushed.
- ⌘K from inside a session starts the new one in the background instead of jumping to it.
- Much faster start-up: archived sessions' history loads only when you open them.

### Fixed
- Sign in… runs `claude auth login`, closes by itself, and resends your message only once the sign-in actually took.

## [0.1.7] - 2026-10-16

### Fixed
- Cockpit no longer climbs to high CPU when notifications go unanswered. Every notification used to wait for its click and poll macOS twice a second, so dozens of ignored ones kept the app busy. Now only the newest three wait for a click (their Answer buttons still work); older ones are reposted silently as plain notifications, a newer notification for the same decision replaces the old one, and answering a decision in Cockpit takes its notification down.

## [0.1.6] - 2026-10-16

### Added
- **Overview** (⌘0, or the Overview button in the tab bar): every workspace on one canvas, each session and doc as a block in Resume, In progress or Review. Launch lands on it when you have more than one workspace. Scroll or drag empty space to pan; pinch, ⌘-scroll or +/− to zoom; ⌘0 fits everything. Far out each workspace shows its name, what needs you and a lamp per item; closer in, titles and then status and plan step.
- Drag a workspace (from anywhere on it) to arrange the map; it snaps to a grid and never lands on another one, and the canvas pans when you drag to an edge. **Tidy up** puts everything back in the automatic grid, with an Undo.
- Find on the map: press **/** and type; what doesn't match fades, Enter flies to each hit.
- Coming back to the Overview, what changed while you were away is marked (●), by block and by workspace, and the bar says how many changed and finished. What you had on screen doesn't count.
- Keyboard: arrows pan, Space-drag or the middle button pan anywhere, Tab moves the camera to what it focuses, Esc goes back to the workspace you came from. Screen readers hear each workspace's counts and each block's status.
- Drag a session onto a workspace tab to move it there.
- Review: an **Approve on my behalf** tickbox next to Publish, off by default.
- Review skips a pull request with nothing new since your last review, and says so, with **Review anyway**.
- **/mcp → Add server**: name, URL or command, headers or env, and a scope; it attaches to the running session.

### Fixed
- In a session, whatever is scrolled into view (Tab, find, a jump) stops below the sticky header instead of behind it.

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
