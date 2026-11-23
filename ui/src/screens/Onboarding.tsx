import { lazy, Suspense, useEffect, useState } from "react";
import { NoClaude } from "../components/NoClaude";
import { PermissionOptions, usePermissionPick } from "../components/PermissionChoice";
import { Bar, Key, Lamp, Lamps, RiskMeter, StateMark } from "../components";
import { FlowDiagram } from "../components/FlowDiagram";
import { keyOf } from "../components/keys";
import { keyLabel } from "../platform";
import type { TileSpec } from "../picker/pick";
import { api } from "../state/store";
import type { AppState, Diagram, SessionKind } from "../state/types";
const SignInPane = lazy(() => import("./Terminal").then((m) => ({ default: m.SignInPane })));

// First run (MR-37, made full-screen and hands-on in MR-38, cut to three steps in MR-216 on the synthetic
// panel's evidence: research/synthetic/FINDINGS.md). Value first, about a minute:
// 1. try it: a live mock wall where you answer a real-looking decision card, then see a plan arrive as a picture
// 2. connect: a live check that Claude Code is installed and signed in (the official `claude` /login, never an
//    in-app login), and how often sessions ask (I106)
// 3. your first task: do it, or plan it first.
// Workspaces, PR reviews, fixing PR comments and plans come later as one tip at a time on the Wall (suggest.ts).
// Shows once (ui.onboarded); Settings → Show the intro brings it back.

const STEPS = ["Try it", "Connect", "Your first task"] as const;

export function Onboarding({ state, onDone, onStart }: { state: AppState; onDone: () => void; onStart: (kind: SessionKind) => void }) {
  const [step, setStep] = useState(0);
  // The kind you pick here is the kind you start with (remembered like the picker's own choice).
  const finish = (kind: SessionKind | null) => {
    void api.log("ui.onboarded", {}); onDone();
    if (kind) {
      try { localStorage.setItem("mr.mode", kind); } catch { /* convenience only */ }
      window.dispatchEvent(new CustomEvent("mr:start-kind", { detail: kind })); // the wall's start form is already mounted
      onStart(kind);
    }
  };
  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input, textarea, .xterm")) return;
      const key = keyOf(e);
      if (key === "ArrowRight") { e.preventDefault(); go(step + 1); }
      if (key === "ArrowLeft") { e.preventDefault(); go(step - 1); }
      if (key === "Escape") { e.preventDefault(); finish(null); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });

  return (
    <div role="dialog" className="mr-scrim" aria-label="Welcome to Cockpit" data-mr="Onboarding" data-mr-source={STEPS[step]}
      style={{ position: "fixed", inset: 0, zIndex: 40, background: "var(--mr-base)", display: "flex", flexDirection: "column" }}>
      <header className="mr-band mr-row" style={{ padding: "14px 28px", gap: 20 }}>
        <strong style={{ fontSize: 15 }}>Cockpit</strong>
        <nav aria-label="Intro steps" className="mr-row" style={{ gap: 4, flex: 1, maxWidth: 820 }}>
          {STEPS.map((s, i) => (
            <button key={s} type="button" onClick={() => go(i)} aria-current={i === step ? "step" : undefined}
              style={{ flex: 1, border: 0, background: "transparent", padding: 0, cursor: "pointer", display: "flex", flexDirection: "column", gap: 6, font: "inherit", textAlign: "left", color: i <= step ? "var(--mr-ink)" : "var(--mr-ink-3)" }}>
              <span style={{ height: 4, background: i < step ? "var(--mr-ink)" : i === step ? "var(--mr-needs)" : "var(--mr-well)", transition: "background .3s" }} />
              <span style={{ fontSize: 12, fontWeight: i === step ? 700 : 400, whiteSpace: "nowrap" }}><span className="mr-mono">{i + 1}</span> {s}</span>
            </button>
          ))}
        </nav>
        <span className="mr-grow" />
        <span className="mr-dim mr-mono" style={{ fontSize: 12 }}>About a minute · ← → to move</span>
        <Key k="esc" onClick={() => finish(null)}>Skip intro</Key>
      </header>

      <main key={step} className="mr-zoom-in mr-onb-main" style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {step === 0 && <WallStep onNext={() => go(1)} />}
        {step === 1 && <ConnectStep state={state} onNext={() => go(2)} />}
        {step === 2 && <GoStep onStart={(k) => finish(k)} />}
      </main>
    </div>
  );
}

function Title({ kicker, children, sub }: { kicker: string; children: React.ReactNode; sub: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 860 }}>
      <div className="mr-mono" style={{ color: "var(--mr-needs-ink)", fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase" }}>{kicker}</div>
      <h1 className="mr-onb-h1" style={{ margin: "6px 0 0", lineHeight: 1.1, letterSpacing: "-.01em" }}>{children}</h1>
      <p className="mr-dim mr-onb-sub" style={{ margin: "10px 0 0", lineHeight: 1.45 }}>{sub}</p>
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
      <Title kicker="Try it" sub={<>Four Claude Code sessions are running below. Grey means they're fine. <b>Amber</b> means one needs you. Everything else can wait.</>}>
        One of these sessions is about to <span style={{ background: "var(--mr-needs)", color: "var(--mr-needs-ink)", padding: "0 8px" }}>need you</span>.
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
          <div ref={(el) => el?.scrollIntoView({ block: "nearest", behavior: "smooth" })} className="mr-onb-rise" style={{ display: "flex", gap: 20, alignItems: "center", padding: 18, background: "var(--mr-tile)", boxShadow: "inset 4px 0 0 var(--mr-needs)", maxWidth: 860 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
              <strong>“Fix the login redirect” wants to run</strong>
              <code className="mr-code mr-mono" style={{ padding: 8 }}>git push --force origin main</code>
              <RiskMeter risk="high" why="Rewrites shared history on main." />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="mr-dim">Try it:</span>
              <Key k="D" tone="primary" onClick={() => answer(false)}>Deny</Key>
              <Key k="A" onClick={() => answer(true)}>Allow</Key>
            </div>
          </div>
        )}
        {(asked === "allowed" || asked === "denied") && (
          <div className="mr-onb-rise mr-row" style={{ gap: 14 }}>
            <Burst />
            <strong style={{ fontSize: 20 }}>{asked === "denied" ? "Denied. It's pushing to a branch instead." : "Done, in one keystroke."}</strong>
            <span className="mr-dim">That's the whole loop: anything that needs you shows up here, with what you need to decide. Press a key and the session keeps going. The transcript is one key away if you want it (<span className="mr-mono">{keyLabel("⌘R")}</span>).</span>
          </div>
        )}
        {(asked === "allowed" || asked === "denied") && <PlanPicture />}
        {asked === null && <span className="mr-dim">Watch the wall. One of these sessions is about to need you…</span>}
      </div>
      <Next onClick={onNext} ready={asked === "allowed" || asked === "denied"}>Next: connect</Next>
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

// A session's plan arrives as a picture, not a wall of text: shown once you've answered the card.
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

function PlanPicture() {
  const [shown, setShown] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setShown((n) => (n >= PICTURE.nodes.length ? n : n + 1)), 260);
    return () => clearInterval(t);
  }, []);
  const visible = PICTURE.nodes.slice(0, shown);
  const partial: Diagram = { ...PICTURE, nodes: visible, edges: PICTURE.edges.filter((e) => visible.some((n) => n.id === e.to)) };
  return (
    <div className="mr-onb-rise" style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
      <span className="mr-dim">And when a session explains itself, you get a picture, not a wall of text. Questions buried in prose come out as decisions:</span>
      <FlowDiagram d={partial} />
    </div>
  );
}

// ── 2. Connect: live checks, then how often sessions ask. ──
function ConnectStep({ state, onNext }: { state: AppState; onNext: () => void }) {
  const [signIn, setSignIn] = useState(false);
  const claude = state.sidecar.claude;
  const acct = state.account;
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);
  // The pick is logged right away, so skipping the intro after this step keeps it.
  const { pick, dialog } = usePermissionPick();
  useEffect(() => { if (!acct.checked) void api.refreshLimits().catch(() => {}); }, [acct.checked]);
  return (
    <>
      <Title kicker="Connect" sub={<>Cockpit drives the <span className="mr-mono">claude</span> you already have, signed in as you. Your skills, hooks and settings keep working. It never sees your login or tokens, and nothing leaves your machine.</>}>
        Uses your Claude Code, <span style={{ color: acct.signedIn ? "var(--mr-done)" : "inherit" }}>{acct.signedIn ? "and you're all set" : "signed in as you"}</span>.
      </Title>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--mr-gap)", maxWidth: 900 }}>
        <Check ok={claude ? true : state.sidecar.up ? false : null} title="Claude Code is installed"
          detail={claude ? claude : state.sidecar.up ? <NoClaude compact /> : "Looking…"} />
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
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 1100 }}>
        <strong style={{ fontSize: 16 }}>When should sessions stop and ask you?</strong>
        <PermissionOptions value={state.permissionMode} onPick={pick} />
        <span className="mr-dim">You can change this any time in Settings → Sessions.</span>
      </div>
      {dialog}
      <Next onClick={() => { if (state.permissionMode === null) void api.setPermissionMode("auto"); onNext(); }} ready={acct.signedIn}>Next: your first task</Next>
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

// ── 3. Your first task. ──
function GoStep({ onStart }: { onStart: (kind: SessionKind) => void }) {
  const kinds = [
    { id: "blank" as const, t: "Do it now", d: "Say what you want. It runs in its own git worktree, so your checkout stays clean.", k: "↵" },
    { id: "plan" as const, t: "Plan it first", d: "Claude writes a one-page plan you answer and mark up before any code.", k: "" },
  ];
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (keyOf(e) === "Enter") { e.preventDefault(); onStart("blank"); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <>
      <Title kicker="Your first task" sub="Pick a repo and say it in your own words. The session shows up on the Wall, and anything it needs from you lands in one queue at the top.">
        What do you want to get done?
      </Title>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--mr-gap)", maxWidth: 820 }}>
        {kinds.map((x, i) => (
          <button key={x.t} type="button" onClick={() => onStart(x.id)} className="mr-onb-rise mr-onb-lift"
            style={{ animationDelay: `${i * 80}ms`, border: 0, padding: 18, textAlign: "left", font: "inherit", color: "var(--mr-ink)", background: "var(--mr-tile)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, minHeight: 150 }}>
            <span className="mr-row" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: 18 }}>{x.t}</strong>{x.k && <kbd className="mr-mono mr-dim">{keyLabel(x.k)}</kbd>}</span>
            <span className="mr-dim">{x.d}</span>
          </button>
        ))}
      </div>
      <div className="mr-row" style={{ gap: 18, marginTop: "auto" }}>
        <span className="mr-dim">Or: <button type="button" className="mr-key" onClick={() => onStart("review")}>Review a PR</button> · <button type="button" className="mr-key" onClick={() => onStart("address")}>Fix PR comments</button>. The rest shows up one tip at a time as you go. <span className="mr-mono">{keyLabel("⌘K")}</span> starts anything, from anywhere.</span>
        <span className="mr-grow" />
        <span className="mr-onb-nudge"><Key k="↵" tone="primary" onClick={() => onStart("blank")}>Start</Key></span>
      </div>
    </>
  );
}
