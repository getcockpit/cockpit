# The Cockpit film

The 45-second product film on the website, rendered from code: every frame is HTML computed from time `t` (`film.html`, `seek(t)`), so it re-renders exactly when the UI changes.

```bash
(cd ui && bunx vite --port 1530)        # the demo harness, no Claude needed
cd scripts/film && bun add puppeteer-core
bun capture.ts                          # shots/*.png at 2x + shots/boxes.json (element positions)
cp ../../src-tauri/icons/128x128@2x.png shots/icon.png
bun render.ts preview 4.6 9 16 23       # check single frames → preview/
bun render.ts full 60                   # all frames → frames/
FORMAT=45 bun render.ts full 30         # the 4:5 cut for LinkedIn → frames-45/
ffmpeg -framerate 60 -i frames/%05d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart cockpit-demo.mp4
# the site's silent hero loop: the first 13 s (calm → one needs you → 1 → the risk card → D)
ffmpeg -framerate 60 -i frames/%05d.jpg -frames:v 790 -vf scale=1600:-2 -c:v libx264 -crf 26 -preset slow -pix_fmt yuv420p -an -movflags +faststart hero-loop.mp4
```

Sound: `score.py` synthesizes an original 120 BPM score (no samples, no licence): the drop on 2.2 s when a session turns amber, the groove dropping out at 28.8 s as the wall goes calm, and clicks on every keycap. It needs numpy; then mux and normalise it:

```bash
python3 score.py   # → score.wav
ffmpeg -i cockpit-demo.mp4 -i score.wav -map 0:v -map 1:a -c:v copy -af loudnorm=I=-14:TP=-1.5 -c:a aac -b:a 192k -shortest cockpit-film.mp4
```

`social.html` is the 1280×640 link-preview card (render it with headless Chrome at that window size).

Script (MR-139), one story where every answer is a key: the calm wall → one session needs you → `1` → "Drop the old table" on production → `D` → Claude's safer plan → `⌥1` → "All 211 tests pass" → `⌘⇧U` Catch me up flags that no test ran → the plan map → the wall goes calm → "Less reading. Less tired." → the end card. Edit `SCENES`, `CAM`, `KEYS`, `CAPS` and `HEADS` in `film.html`; `?format=45` renders the same film at 1080×1350. Captures come from the demo harness (`calm`, `timeline`, `busy`). It needs Chrome at the default macOS path (change `executablePath` elsewhere).
