# Evals: god-mode marks

Every time you mark something wrong in god mode (⌘⇧G), one JSON line is appended to `marks.jsonl`:
`{note, component, source, layer, view, text, html, at, event_id}`.

- **Fixes:** each mark also opens a fix session on this repo (in its own worktree). That session fixes the component, picker or state, and adds a vitest regression test built from the packet.
- **Eval set:** the file doubles as an eval set. Replay it to check that the picker and components no longer reproduce a marked mistake.
