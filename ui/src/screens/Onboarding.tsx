import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Bar, Key, Lamp, Lamps, RiskMeter, StateMark } from "../components";
import { FlowDiagram } from "../components/FlowDiagram";
import { keyOf } from "../components/keys";
import type { TileSpec } from "../picker/pick";
import { api } from "../state/store";
import type { AppState, Diagram } from "../state/types";
const SignInPane = lazy(() => import("./Terminal").then((m) => ({ default: m.SignInPane })));

// First run (MR-37, made full-screen and hands-on in MR-38). You learn by doing:
// 1. a live mock wall where you answer a real-looking decision card
// 2. a wall of agent text that turns into a picture
// 3. right-click / ⌘ / ⌥ pointing on a demo tile
// 4. a live check that Claude Code is installed and signed in (the official `claude` /login, never an in-app login)
// 5. your first session.
// Shows once (ui.onboarded); Settings → Show the intro brings it back.

const STEPS = ["The wall", "Pictures", "Point", "Connect", "Go"] as const;

export function Onboarding({ state, onDone, onStart }: { state: AppState; onDone: () => void; onStart: () => void }) {
  const [step, setStep] = useState(0);
  const finish = (start: boolean) => { void api.log("ui.onboarded", {}); onDone(); if (start) onStart(); };
  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, .xterm")) return;
      const key = keyOf(e);
      if (key === "ArrowRight") { e.preventDefault(); go(step + 1); }
      if (key === "ArrowLeft") { e.preventDefault(); go(step - 1); }
      if (key === "Escape") { e.preventDefault(); finish(false); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  return (
    <div role="dialog" aria-label="Welcome to Minority report" data-mr="Onboarding" data-mr-source={STEPS[step]}
      style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--mr-base)", display: "flex", flexDirection: "column" }}>
      <header className="mr-band mr-row" style={{ padding: "14px 28px", gap: 20 }}>
        <strong style={{ fontSize: 15 }}>Minority report</strong>
        <nav aria-label="Intro steps" className="mr-row" style={{ gap: 4, flex: 1, maxWidth: 640 }}>
          {STEPS.map((s, i) => (
            <button key={s} type="button" onClick={() => go(i)} aria-current={i === step ? "step" : undefined}
              style={{ flex: 1, border: 0, background: "transparent", padding: 0, cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, font: "inherit", textAlign: "left", color: i <= step ? "var(--mr-ink)" : "var(--mr-ink-3)" }}>
              <span style={{ height: 4, background: i < step ? "var(--mr-ink)" : i === step ? "var(--mr-needs)" : "var(--mr-well)", transition: "background .3s" }} />
              <span style={{ fontSize: 12, fontWeight: i === step ? 700 : 400 }}><span className="mr-mono">{i + 1}</span> {s}</span>
            </button>
          ))}
        </nav>
        <span className="mr-grow" />
        <span className="mr-dim mr-mono" style={{ fontSize: 12 }}>← → to move</span>
        <Key k="esc" onClick={() => finish(false)}>Skip intro</Key>
      </header>

      <main key={step} className="mr-zoom-in" style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", padding: "40px 56px 28px", gap: 28 }}>
        {step === 0 && <WallStep onNext={() => go(1)} />}
        {step === 1 && <PictureStep onNext={() => go(2)} />}
        {step === 2 && <PointStep onNext={() => go(3)} />}
        {step === 3 && <ConnectStep state={state} onNext={() => go(4)} />}
        {step === 4 && <GoStep onStart={() => finish(true)} />}
      </main>
    </div>
  );
}

function Title({ kicker, children, sub }: { kicker: string; children: React.ReactNode; sub: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 860 }}>
      <div className="mr-mono" style={{ color: "var(--mr-needs-ink)", fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase" }}>{kicker}</div>
      <h1 style={{ margin: "6px 0 0", fontSize: 40, lineHeight: 1.1, letterSpacing: "-.01em" }}>{children}</h1>
      <p className="mr-dim" style={{ margin: "12px 0 0", fontSize: 17, lineHeight: 1.45 }}>{sub}</p>
    </div>
  );
}

function Next({ onClick, children, ready = true }: { onClick: () => void; children: React.ReactNode; ready?: boolean }) {
  return <div className="mr-row" style={{ marginTop: "auto" }}><span className="mr-grow" /><span className={ready ? "mr-onb-nudge" : undefined}><Key k="→" tone={ready ? "primary" : undefined} onClick={onClick}>{children}</Key></span></div>;
}

// ── 1. A living wall: four fake sessions tick along; one stops to ask you something. ──
type Sim = { title: string; p: number; s: TileSpec["state"]; doing: string };
const START: Sim[] = [
  { title: "Fix the login redirect", p: 0.35, s: "working", doing: "Edit auth/session.ts" },
  { title: "Review PR #482", p: 0.6, s: "working", doing: "Reading the diff" },
  { title: "Plan: billing export", p: 0.15, s: "working", doing: "Writing the plan" },
  { title: "Bump dependencies", p: 0.45, s: "working", doing: "bun update" },
];

function WallStep({ onNext }: { onNext: () => void }) {
  const [sims, setSims] = useState(START);
  const [asked, setAsked] = useState<null | "asking" | "allowed" | "denied">(null);
  useEffect(() => {
    const t = setInterval(() => setSims((xs) => xs.map((x, i) => {
      if (x.s === "done" || x.s === "needs_you") return x;
      if (i === 0 && x.p > 0.5 && asked === null) { setAsked("asking"); return { ...x, s: "needs_you", doing: "Wants to run: git push --force" }; }
      const p = Math.min(1, x.p + 0.015 + Math.random() * 0.04);
      return { ...x, p, s: p >= 1 ? "done" : p > 0.8 ? "almost" : "working", doing: p >= 1 ? "Finished" : x.doing };
    })), 450);
    return () => clearInterval(t);
  }, [asked]);
  const answer = (allow: boolean) => {
    if (asked !== "asking") return;
    setAsked(allow ? "allowed" : "denied");
    setSims((xs) => xs.map((x, i) => (i === 0 ? { ...x, s: "working", doing: allow ? "Pushing…" : "Okay, pushing to a branch instead" } : x)));
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { const key = keyOf(e); if (key === "a") answer(true); if (key === "d") answer(false); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const count = (s: TileSpec["state"]) => sims.filter((x) => x.s === s).length;
  return (
    <>
      <Title kicker="Claude Code, but visual" sub={<>Run many Claude Code sessions at once, on your own plan. Instead of scrolling through transcripts, you watch a wall. <b>Amber</b> means a session needs you. Everything else can wait.</>}>
        Stop reading. Start <span style={{ background: "var(--mr-needs)", color: "var(--mr-needs-ink)", padding: "0 8px" }}>deciding</span>.
      </Title>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
        <Lamps>
          <Lamp value={count("needs_you")} label="Needs you" on={count("needs_you") > 0 && "needs"} />
          <Lamp value={count("working") + count("almost")} label="Running" on="plain" />
          <Lamp value={count("almost")} label="Almost done" on={count("almost") > 0 && "plain"} />
          <Lamp value={count("done")} label="Done" on={count("done") > 0 && "plain"} />
        </Lamps>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "var(--mr-gap)" }}>
          {sims.map((x) => (
            <div key={x.title} className={x.s === "needs_you" ? "mr-onb-pulse" : undefined} style={{ padding: 14, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 8, boxShadow: x.s === "needs_you" ? "inset 0 0 0 3px var(--mr-needs)" : undefined, transition: "box-shadow .3s" }}>
              <StateMark s={x.s} />
              <strong>{x.title}</strong>
              <span className="mr-dim mr-ellipsis mr-mono" style={{ fontSize: 12 }}>{x.doing}</span>
              <Bar value={x.p} tone={x.s === "needs_you" ? "needs" : undefined} />
            </div>
          ))}
        </div>
      </div>
      <div style={{ minHeight: 130 }}>
        {asked === "asking" && (
          <div className="mr-onb-rise" style={{ display: "flex", gap: 20, alignItems: "center", padding: 18, background: "var(--mr-tile)", boxShadow: "inset 4px 0 0 var(--mr-needs)", maxWidth: 860 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
              <strong>“Fix the login redirect” wants to run</strong>
              <code className="mr-code mr-mono" style={{ padding: 8 }}>git push --force origin main</code>
              <RiskMeter risk="high" why="Rewrites shared history on main." />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="mr-dim">Try it:</span>
              <Key k="A" tone="primary" onClick={() => answer(true)}>Allow</Key>
              <Key k="D" onClick={() => answer(false)}>Deny</Key>
            </div>
          </div>
        )}
        {(asked === "allowed" || asked === "denied") && (
          <div className="mr-onb-rise mr-row" style={{ gap: 14 }}>
            <Burst />
            <strong style={{ fontSize: 20 }}>{asked === "denied" ? "Good call." : "Done, in one keystroke."}</strong>
            <span className="mr-dim">That's the loop: glance, decide, move on. Real cards work the same way: <span className="mr-mono">J/K</span> to move, <span className="mr-mono">A/D</span> to answer.</span>
          </div>
        )}
        {asked === null && <span className="mr-dim">Watch the wall. One of these sessions is about to need you…</span>}
      </div>
      <Next onClick={onNext} ready={asked === "allowed" || asked === "denied"}>Next: pictures</Next>
    </>
  );
}

function Burst() {
  const bits = Array.from({ length: 14 }, (_, i) => i);
  const colors = ["var(--mr-needs)", "var(--mr-done)", "var(--mr-selected)", "var(--mr-ink)"];
  return (
    <span aria-hidden style={{ position: "relative", width: 30, height: 30, flex: "none" }}>
      {bits.map((i) => {
        const a = (i / bits.length) * Math.PI * 2, r = 34 + (i % 3) * 10;
        return <span key={i} className="mr-onb-bit" style={{ position: "absolute", left: 12, top: 12, width: 6, height: 6, background: colors[i % colors.length], ["--dx" as string]: `${Math.cos(a) * r}px`, ["--dy" as string]: `${Math.sin(a) * r}px` } as React.CSSProperties} />;
      })}
      <span className="mr-onb-pop" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--mr-done)", fontSize: 24, fontWeight: 700 }}>✓</span>
    </span>
  );
}

// ── 2. Text becomes a picture. ──
const WALL_OF_TEXT = `I looked into the failing checkout. Here's the plan:
1. Reproduce it with a failing test against the staging fixture.
2. Decide whether to patch the currency rounding or replace the helper with the shared one.
3. Apply the fix and update the three call sites.
4. Risk: the e2e suite is flaky on CI, so it may need two runs.
5. Run the whole suite; done when it's green.
Let me know if you want me to go ahead or adjust anything first.`;
const PICTURE: Diagram = {
  title: "Fix the failing checkout",
  nodes: [
    { id: "a", label: "Reproduce with a failing test", kind: "step" },
    { id: "b", label: "Patch rounding or reuse helper?", kind: "decision" },
    { id: "c", label: "Fix + update 3 call sites", kind: "step" },
    { id: "d", label: "Flaky e2e on CI", kind: "risk" },
    { id: "e", label: "Suite green", kind: "done" },
  ],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "you pick" }, { from: "c", to: "d" }, { from: "d", to: "e" }],
};

function PictureStep({ onNext }: { onNext: () => void }) {
  const [pic, setPic] = useState(false);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!pic) { setShown(0); return; }
    const t = setInterval(() => setShown((n) => (n >= PICTURE.nodes.length ? n : n + 1)), 260);
    return () => clearInterval(t);
  }, [pic]);
  const visible = PICTURE.nodes.slice(0, Math.max(1, shown));
  const partial: Diagram = { ...PICTURE, nodes: visible, edges: PICTURE.edges.filter((e) => visible.some((n) => n.id === e.to)) };
  const done = pic && shown >= PICTURE.nodes.length;
  return (
    <>
      <Title kicker="Pictures, not transcripts" sub="Long plans, recaps and reviews turn into diagrams, cards and maps you can scan in a second. Questions buried in prose get pulled out as decisions. Flip it and see.">
        Same message. <span style={{ textDecoration: pic ? "none" : "line-through", textDecorationColor: "var(--mr-error)" }}>Wall of text</span>{pic ? " → a picture." : "?"}
      </Title>
      <div className="mr-row" style={{ gap: 12 }}>
        <div role="radiogroup" aria-label="Show as" className="mr-row" style={{ gap: 0, background: "var(--mr-well)", padding: 3 }}>
          {([["Text", false], ["Picture", true]] as const).map(([l, v]) => (
            <button key={l} type="button" role="radio" aria-checked={pic === v} onClick={() => setPic(v)}
              style={{ border: 0, padding: "8px 18px", font: "inherit", fontWeight: 600, cursor: "pointer", background: pic === v ? "var(--mr-ink)" : "transparent", color: pic === v ? "var(--mr-tile)" : "var(--mr-ink)", transition: "background .2s" }}>{l}</button>
          ))}
        </div>
        {!pic && <span className="mr-dim mr-onb-nudge">← flip it</span>}
      </div>
      <div style={{ minHeight: 240, maxWidth: 1000 }}>
        {pic ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)" }}>
            <FlowDiagram d={partial} />
            {done && (
              <div className="mr-onb-rise mr-row" style={{ padding: 14, background: "var(--mr-tile)", boxShadow: "inset 4px 0 0 var(--mr-needs)", gap: 12 }}>
                <StateMark s="needs_you" /><span className="mr-grow">Asks: go ahead, or adjust the plan first?</span>
                <Key tone="primary">Go ahead</Key><Key>Adjust…</Key>
              </div>
            )}
          </div>
        ) : (
          <pre style={{ margin: 0, padding: 18, background: "var(--mr-tile)", whiteSpace: "pre-wrap", fontFamily: "var(--mr-mono)", fontSize: 13, lineHeight: 1.6, color: "var(--mr-ink-2)" }}>{WALL_OF_TEXT}</pre>
        )}
      </div>
      <Next onClick={onNext} ready={done}>Next: pointing</Next>
    </>
  );
}

// ── 3. Point at things. ──
function PointStep({ onNext }: { onNext: () => void }) {
  const [tried, setTried] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mark = (k: string) => setTried((t) => new Set(t).add(k));
    const ctx = () => mark("right");
    const click = (e: MouseEvent) => { if (e.metaKey) mark("deeper"); else if (e.altKey) mark("discover"); };
    el.addEventListener("contextmenu", ctx);
    el.addEventListener("click", click);
    return () => { el.removeEventListener("contextmenu", ctx); el.removeEventListener("click", click); };
  }, []);
  const moves = [
    { k: "right", key: "Right-click", what: "Mark it wrong. A session fixes the app itself and adds a test (god mode)." },
    { k: "deeper", key: "⌘-click", what: "Go deeper: open the session, file or block behind it." },
    { k: "discover", key: "⌥-click", what: "Discover: a side session explains it and flags risks, changing nothing." },
    { k: "voice", key: "⌥Space", what: "Hold and talk to whatever is under the pointer." },
  ];
  return (
    <>
      <Title kicker="Point, don't type" sub="Everything on screen is something you can point at. Try these on the card on the right.">
        The same moves work <i>everywhere</i>.
      </Title>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 28, alignItems: "start", maxWidth: 1100 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {moves.map((m) => (
            <div key={m.k} className="mr-row" style={{ gap: 14, padding: 12, background: tried.has(m.k) ? "var(--mr-tile)" : "var(--mr-well)", transition: "background .3s" }}>
              <span key={String(tried.has(m.k))} className={tried.has(m.k) ? "mr-onb-pop mr-mono" : "mr-mono"} style={{ width: 22, color: tried.has(m.k) ? "var(--mr-done)" : "var(--mr-ink-3)", fontSize: 18 }}>{tried.has(m.k) ? "✓" : "○"}</span>
              <kbd className="mr-mono" style={{ padding: "3px 8px", background: "var(--mr-ink)", color: "var(--mr-tile)", minWidth: 96, textAlign: "center" }}>{m.key}</kbd>
              <span>{m.what}</span>
            </div>
          ))}
        </div>
        <div ref={ref} data-mr="DemoTile" data-mr-source="onboarding" className={tried.size === 0 ? "mr-onb-pulse" : undefined}
          style={{ padding: 18, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 10, cursor: "context-menu" }}>
          <span className="mr-dim mr-mono" style={{ fontSize: 12 }}>try me: right-click · ⌘-click · ⌥-click</span>
          <StateMark s="almost" />
          <strong style={{ fontSize: 18 }}>Migrate settings to the new schema</strong>
          <span className="mr-dim">Step 4 of 5 · Running the migration test</span>
          <Bar value={0.82} />
        </div>
      </div>
      <Next onClick={onNext} ready={tried.size > 0}>Next: connect</Next>
    </>
  );
}

// ── 4. Connect: live checks. ──
function ConnectStep({ state, onNext }: { state: AppState; onNext: () => void }) {
  const [signIn, setSignIn] = useState(false);
  const claude = state.sidecar.claude;
  const acct = state.account;
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  useEffect(() => { if (!acct.checked) void api.refreshLimits().catch(() => {}); }, [acct.checked]);
  return (
    <>
      <Title kicker="Your plan, your login" sub={<>It drives the official <span className="mr-mono">claude</span> app with your own Claude subscription. Sign-in happens in Claude's own login. This app never sees your password or tokens.</>}>
        Let's check you're <span style={{ color: acct.signedIn ? "var(--mr-done)" : "inherit" }}>{acct.signedIn ? "all set" : "connected"}</span>.
      </Title>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)", maxWidth: 900 }}>
        <Check ok={claude ? true : state.sidecar.up ? false : null} title="Claude Code is installed"
          detail={claude ? claude : state.sidecar.up ? <>Not found. In a terminal run <span className="mr-mono">curl -fsSL https://claude.ai/install.sh | bash</span>, then reopen this app.</> : "Looking…"} />
        <Check ok={acct.checked ? acct.signedIn : null} title="Signed in with a Claude plan"
          detail={!acct.checked ? "Checking…" : acct.signedIn ? (
            <span className="mr-row" style={{ gap: 14, flexWrap: "wrap" }}>
              <b>{(acct.plan ?? "subscription").toUpperCase()}</b>
              <span className="mr-row" style={{ gap: 6 }}>5-hour <Meter v={state.usage.fiveHour} /> {pct(state.usage.fiveHour)}</span>
              <span className="mr-row" style={{ gap: 6 }}>Week <Meter v={state.usage.weekly} /> {pct(state.usage.weekly)}</span>
            </span>
          ) : "Not signed in, or using an API key instead of a plan."}
          action={acct.checked && !acct.signedIn ? (signIn ? <Key onClick={() => void api.refreshLimits()}>Check again</Key> : <Key tone="primary" onClick={() => setSignIn(true)}>Sign in</Key>) : null} />
        {signIn && !acct.signedIn && (
          <div className="mr-onb-rise" style={{ background: "var(--mr-tile)", padding: 10, height: 340, display: "flex", flexDirection: "column" }}>
            <Suspense fallback={<span className="mr-dim">Opening claude…</span>}>
              <SignInPane workspace="personal" onExit={() => { setSignIn(false); void api.refreshLimits(); }} />
            </Suspense>
          </div>
        )}
        <Check ok={null} optional title="Picker model (optional)"
          detail="Cloudflare's free Clef-flash model helps sort unclear messages. Everything works without it. Add it any time in Settings (⌘,)." />
      </div>
      <Next onClick={onNext} ready={acct.signedIn}>Next: go</Next>
    </>
  );
}

function Meter({ v }: { v: number | null }) {
  return <span style={{ width: 90, height: 6, background: "var(--mr-well)", display: "inline-block" }}><span className="mr-onb-grow" style={{ display: "block", height: 6, width: `${Math.round((v ?? 0) * 100)}%`, background: (v ?? 0) >= 0.8 ? "var(--mr-needs)" : "var(--mr-ink-2)" }} /></span>;
}

function Check({ ok, title, detail, action, optional }: { ok: boolean | null; title: string; detail: React.ReactNode; action?: React.ReactNode; optional?: boolean }) {
  const mark = ok === true ? "✓" : ok === false ? "✕" : optional ? "○" : "…";
  const color = ok === true ? "var(--mr-done)" : ok === false ? "var(--mr-error)" : "var(--mr-ink-3)";
  return (
    <div className="mr-row" style={{ padding: 16, background: "var(--mr-tile)", gap: 16 }}>
      <span key={String(ok)} className={ok === true ? "mr-onb-pop" : undefined} style={{ display: "grid", placeItems: "center", width: 34, height: 34, flex: "none", background: ok === true ? "var(--mr-done)" : "var(--mr-well)", color: ok === true ? "var(--mr-tile)" : color, fontSize: 18, fontWeight: 700 }}>{mark}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 }}><strong style={{ fontSize: 16 }}>{title}</strong><span className="mr-dim" style={{ wordBreak: "break-word" }}>{detail}</span></span>
      {action}
    </div>
  );
}

// ── 5. Go. ──
function GoStep({ onStart }: { onStart: () => void }) {
  const kinds = [
    { t: "Blank", d: "Any task. Gets its own git worktree, so your checkout stays clean.", k: "⌘1" },
    { t: "Plan", d: "A working doc first: a map you annotate and decide on before any code.", k: "⌘2" },
    { t: "Review", d: "Your /review on a PR, as findings you step through.", k: "⌘3" },
    { t: "Address", d: "Your /pr-address, one reviewer thread at a time.", k: "⌘4" },
  ];
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (keyOf(e) === "Enter") { e.preventDefault(); onStart(); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <>
      <Title kicker="Your turn" sub="The wall starts empty and fills up as sessions run. Every visual comes from a live session. Pick a folder, say what you want, and watch.">
        Start your first session.
      </Title>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "var(--mr-gap)", maxWidth: 1100 }}>
        {kinds.map((x, i) => (
          <button key={x.t} type="button" onClick={onStart} className="mr-onb-rise mr-onb-lift"
            style={{ animationDelay: `${i * 80}ms`, border: 0, padding: 18, textAlign: "left", font: "inherit", color: "var(--mr-ink)", background: "var(--mr-tile)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, minHeight: 150 }}>
            <span className="mr-row" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: 18 }}>{x.t}</strong><kbd className="mr-mono mr-dim">{x.k}</kbd></span>
            <span className="mr-dim">{x.d}</span>
          </button>
        ))}
      </div>
      <div className="mr-row" style={{ gap: 18, marginTop: "auto" }}>
        <span className="mr-dim">Any time: <span className="mr-mono">⌘K</span> start · <span className="mr-mono">⌘,</span> settings · <span className="mr-mono">⌘⇧G</span> god mode · right-click anything</span>
        <span className="mr-grow" />
        <span className="mr-onb-nudge"><Key k="↵" tone="primary" onClick={onStart}>Start my first session</Key></span>
      </div>
    </>
  );
}
