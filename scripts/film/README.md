# The Cockpit film

The 40-second product film on the website, rendered from code: every frame is HTML computed from time `t` (`film.html`, `seek(t)`), so it re-renders exactly when the UI changes.

```bash
(cd ui && bunx vite --port 1530)        # the demo harness, no Claude needed
cd scripts/film && bun add puppeteer-core
bun capture.ts                          # shots/*.png at 2x + shots/boxes.json (element positions)
cp ../../src-tauri/icons/128x128@2x.png shots/icon.png
bun render.ts preview 7.5 14 22         # check single frames → preview/
bun render.ts full 60                   # all frames → frames/
ffmpeg -framerate 60 -i frames/%05d.jpg -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart cockpit-demo.mp4
```

Sound: `score.py` synthesizes an original 120 BPM score (no samples, no licence) with the drop on 4.5 s and UI clicks/whooshes on the film's events. It needs numpy; then mux and normalise it:

```bash
python3 score.py   # → score.wav
ffmpeg -i cockpit-demo.mp4 -i score.wav -map 0:v -map 1:a -c:v copy -af loudnorm=I=-14:TP=-1.5 -c:a aac -b:a 192k -shortest cockpit-film.mp4
```

`social.html` is the 1280×640 link-preview card (render it with headless Chrome at that window size).

Script: the hook (eight terminals, one waiting) → the queue (answer in one key) → risk before it runs → what it did → the change map → plans → timeline → review → every screen at once → the end card. Edit `SCENES`, `CAM`, `CUR`, `CAPS` and `HEADS` in `film.html`, and `WARP` for pacing. It needs Chrome at the default macOS path (change `executablePath` elsewhere).
