"""Original score for the Cockpit film (45 s, 120 BPM), synthesized from scratch: no samples, no licence.
The bar grid starts at 0.2 s so the drop lands on 2.2 s (the first session turns amber). The groove drops
out at 28.8 s while the wall goes calm, builds back into "Less reading." at 34.2 s, and ends on the end card.
UI sounds sit on the film's own events (keypresses, scene changes). Writes score.wav (44.1 kHz stereo)."""
import numpy as np, wave

SR = 44100
DUR = 45.0
BPM = 120
BEAT = 60 / BPM
GRID0 = 0.2            # first downbeat
DROP = 2.2             # one session needs you
CALM = 28.8            # the wall goes grey: the groove drops out
OUTRO = 32.2           # build back in
HEAD = 34.2            # "Less reading. Less tired."
END = 39.0             # end card
N = int(SR * DUR)
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(7)

def t_arr(n): return np.arange(n) / SR
def place(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR)
    if i >= N: return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 - pan))
    R[i:i + len(sig)] += sig * np.sqrt(0.5 * (1 + pan))
def env(n, a=0.005, d=0.2, s=0.0, r=0.1, hold=0.0):
    t = t_arr(n); e = np.zeros(n)
    A, D, H = a, d, hold
    e = np.where(t < A, t / A, np.where(t < A + H, 1.0, s + (1 - s) * np.exp(-(t - A - H) / max(D, 1e-4))))
    tail = int(r * SR)
    if tail and tail < n: e[-tail:] *= np.linspace(1, 0, tail)
    return e
def lp(x, a):  # one-pole low-pass, a in (0,1): higher = brighter
    y = np.empty_like(x); acc = 0.0
    for i, v in enumerate(x): acc += a * (v - acc); y[i] = acc
    return y
def note(f): return 440.0 * 2 ** ((f - 69) / 12)
def bars(): return [GRID0 + 2.0 * k for k in range(23)]

# --- drums ---
def kick():
    n = int(0.45 * SR); t = t_arr(n)
    f = 45 + 110 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7) * 0.95
def clap():
    n = int(0.25 * SR); t = t_arr(n)
    x = rng.standard_normal(n) * (np.exp(-t * 28) + 0.6 * np.exp(-((t - 0.012) ** 2) / 1e-5))
    return (x - lp(x, 0.25)) * 0.35
def hat(open_=False):
    n = int((0.18 if open_ else 0.05) * SR); t = t_arr(n)
    x = rng.standard_normal(n); x = x - lp(x, 0.6)
    return x * np.exp(-t * (18 if open_ else 70)) * 0.18
K, C, H, HO = kick(), clap(), hat(), hat(True)

# --- tonal voices ---
def saw(f, n):
    t = t_arr(n); ph = (f * t) % 1.0
    return 2 * ph - 1
def pad(midi_notes, length, gain=0.12):
    n = int(length * SR); out = np.zeros(n)
    for m in midi_notes:
        for det in (-0.08, 0.0, 0.08):
            out += saw(note(m + det), n)
    out = lp(out, 0.035) * env(n, a=0.6, d=9, s=0.85, r=0.6)
    return out * gain / len(midi_notes)
def bass(m, length):
    n = int(length * SR); t = t_arr(n)
    x = np.sin(2 * np.pi * note(m) * t) + 0.35 * np.sign(np.sin(2 * np.pi * note(m) * t))
    return lp(x, 0.08) * env(n, a=0.004, d=0.22, s=0.35, r=0.05) * 0.25
def pluck(m, length=0.4):
    n = int(length * SR); t = t_arr(n)
    x = saw(note(m), n) * 0.6 + np.sin(2 * np.pi * note(m) * 2 * t) * 0.3
    return lp(x, 0.18) * np.exp(-t * 9) * 0.10

# Am – F – C – G (one bar each)
PROG = [(57, [57, 60, 64, 69]), (53, [53, 57, 60, 65]), (48, [52, 55, 60, 64]), (55, [55, 59, 62, 67])]

# --- intro (0–2.2 s): a held drone, ticking 16ths that speed up, a riser into the drop ---
place(pad([45, 52, 57, 60], DROP + 0.3, 0.10), 0.0)
for k in range(int(DROP / (BEAT / 4))):
    tt = k * BEAT / 4
    if tt > 0.4: place(H, tt, 0.35 + 0.65 * tt / DROP, pan=0.3 * np.sin(k))
n = int(2.0 * SR); t = t_arr(n)
riser = rng.standard_normal(n); riser = riser - lp(riser, 0.05)  # bright noise
riser = lp(riser, 0.4) * (t / t[-1]) ** 2.5 * 0.22
place(riser, DROP - 2.0)
n = int(2.0 * SR); t = t_arr(n)
place(np.sin(2 * np.pi * np.cumsum(220 + 660 * (t / t[-1]) ** 2) / SR) * (t / t[-1]) ** 3 * 0.05, DROP - 2.0)

# --- main groove (2.2–28.8 s) ---
for b, bar_t in enumerate(bars()):
    if bar_t < DROP - 1e-6 or bar_t >= CALM - 1e-6: continue
    root, chord = PROG[(b - 2) % 4]
    place(pad(chord, 2.05, 0.11), bar_t)
    breakdown = abs(bar_t - 18.2) < 1e-6   # one bar without kick and bass, re-drop on the plans section
    for beat in range(4):
        bt = bar_t + beat * BEAT
        if breakdown:
            place(H, bt + BEAT / 2, 0.6, pan=-0.2)
            continue
        place(K, bt, 0.9)
        if beat in (1, 3): place(C, bt, 0.8)
        place(H, bt + BEAT / 2, 0.8, pan=-0.2)
        if beat == 3 and b % 2: place(HO, bt + BEAT / 2, 0.7, pan=0.2)
        # bass on the off-beat eighths, root and octave
        place(bass(root - 12, BEAT / 2 * 0.95), bt + BEAT / 2, 1.0)
    # pluck arpeggio, 8ths, a little brighter after 20 s (the plans/timeline section)
    for i in range(8):
        m = chord[[0, 2, 1, 3, 2, 1, 3, 2][i]] + 12
        place(pluck(m), bar_t + i * BEAT / 2, 1.0 if bar_t < 20 else 1.25, pan=0.4 * np.sin(i * 1.3))

# riser into the re-drop at 20.2 s
n = int(1.9 * SR); t = t_arr(n)
r2 = rng.standard_normal(n); r2 = lp(r2 - lp(r2, 0.05), 0.45) * (t / t[-1]) ** 2.2 * 0.18
place(r2, 20.2 - 1.9)
place(K, 20.2, 1.0)

# --- calm (28.8–32.2 s): only a soft held chord and one bell; no drums ---
place(pad([45, 57, 60, 64], OUTRO - CALM + 0.4, 0.07), CALM)
n = int(3.0 * SR); t = t_arr(n)
place(np.sin(2 * np.pi * note(76) * t) * np.exp(-t * 1.6) * 0.05, CALM + 0.3, pan=-0.2)

# --- build (32.2–34.2 s): snare roll into the headline, then a light groove under it to the end card ---
for k in range(int((HEAD - OUTRO) / (BEAT / 4))):
    tt = OUTRO + k * BEAT / 4
    place(C, tt, 0.25 + 0.55 * k / ((HEAD - OUTRO) / (BEAT / 4)))
place(pad([45, 57, 60, 64, 69], HEAD - OUTRO + 0.2, 0.10), OUTRO)
place(K, HEAD, 1.0)
place(pad([41, 53, 57, 60, 65], END - HEAD, 0.14), HEAD)
for k in range(int((END - HEAD) / BEAT)):
    place(K, HEAD + k * BEAT, 0.6)
    place(H, HEAD + k * BEAT + BEAT / 2, 0.6, pan=-0.2)
# --- end card: one big chord and a long tail ---
place(K, END, 1.0)
place(pad([45, 52, 57, 60, 64, 69, 76], DUR - END, 0.2), END)
n = int(3.0 * SR); t = t_arr(n)
place(np.sin(2 * np.pi * note(81) * t) * np.exp(-t * 1.8) * 0.06, END + 0.05)

# --- UI sounds on the film's events ---
def click():
    n = int(0.06 * SR); t = t_arr(n)
    return (np.sin(2 * np.pi * 2400 * t) * 0.5 + rng.standard_normal(n) * 0.3) * np.exp(-t * 90) * 0.35
def whoosh(length=0.45):
    n = int(length * SR); t = t_arr(n)
    x = rng.standard_normal(n); x = lp(x, 0.12) - lp(x, 0.02)
    return x * np.sin(np.pi * t / t[-1]) ** 2 * 0.5
for c in (4.6, 9.0, 12.3, 15.6):          # the keycaps
    place(click(), c, 1.0)
for s in (6.4, 9.6, 13.2, 15.8, 21.2, 28.8):
    place(whoosh(), s - 0.2, 0.9, pan=0.3)
place(whoosh(0.8), DROP - 0.5, 1.0)

# --- simple stereo room: a few feedback delays, then master ---
def room(x, side):
    y = x.copy()
    for d, g in ((0.031, 0.32), (0.047, 0.26), (0.071, 0.2), (0.113, 0.14)):
        k = int((d + (0.004 if side else 0)) * SR)
        y[k:] += x[:-k] * g
    return y
L, R = room(L, 0), room(R, 1)
mix = np.stack([L, R], 1)
mix = np.tanh(mix * 1.4) / np.tanh(1.4)                 # gentle glue
fade = int(1.2 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
mix *= 0.89 / np.max(np.abs(mix))
with wave.open("score.wav", "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print("score.wav", DUR, "s")
