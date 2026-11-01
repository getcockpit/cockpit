import { lazy, Suspense, useEffect, useState } from "react";
import { NoClaude } from "../components/NoClaude";
import { PermissionOptions, usePermissionPick } from "../components/PermissionChoice";
import { Bar, Key, Lamp, Lamps, RiskMeter, StateMark } from "../components";
import { FlowDiagram } from "../components/FlowDiagram";
import { keyOf } from "../components/keys";
import { keyLabel, modKey } from "../platform";
import type { TileSpec } from "../picker/pick";
import { api } from "../state/store";
import type { AppState, Diagram, SessionKind } from "../state/types";
const SignInPane = lazy(() => import("./Terminal").then((m) => ({ default: m.SignInPane })));

// First run (MR-37, made full-screen and hands-on in MR-38, ordered by real usage in MR-190, decision 41).
// You learn by doing:
// 1. a live mock wall where you answer a real-looking decision card, then see a plan arrive as a picture
// 2. workspaces: switch with ⌘2, open the Overview with ⌘0, jump into a session from the map
// 3. review: note a finding, publish and approve; Address turns reviewer threads into fixes
// 4. plans: decide a doc's open question, then build from the doc
// 5. a live check that Claude Code is installed and signed in (the official `claude` /login, never an in-app login)
// 6. how often sessions ask for permission (I106)
// 7. your first session (pointing is a tip there: it's rarely used, decision 41).
// Shows once (ui.onboarded); Settings → Show the intro brings it back.

const STEPS = ["The wall", "Workspaces", "Review", "Plans", "Connect", "Permissions", "Go"] as const;

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
        <span className="mr-dim mr-mono" style={{ fontSize: 12 }}>← → to move</span>
        <Key k="esc" onClick={() => finish(null)}>Skip intro</Key>
      </header>

      <main key={step} className="mr-zoom-in mr-onb-main" style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {step === 0 && <WallStep onNext={() => go(1)} />}
        {step === 1 && <WorkspacesStep onNext={() => go(2)} />}
        {step === 2 && <ReviewStep onNext={() => go(3)} />}
        {step === 3 && <PlanStep onNext={() => go(4)} />}
        {step === 4 && <ConnectStep state={state} onNext={() => go(5)} />}
        {step === 5 && <PermissionStep state={state} onNext={() => go(6)} />}
        {step === 6 && <GoStep onStart={(k) => finish(k)} />}
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
            <strong style={{ fontSize: 20 }}>{asked === "denied" ? "Good call." : "Done, in one keystroke."}</strong>
            <span className="mr-dim">That's the loop: glance, decide, move on. Real cards work the same way: <span className="mr-mono">J/K</span> to move, <span className="mr-mono">A/D</span> to answer, <span className="mr-mono">{keyLabel("⌘K")}</span> to start a session, <span className="mr-mono">{keyLabel("⇧⌘D")}</span> to mark one done.</span>
          </div>
        )}
        {(asked === "allowed" || asked === "denied") && <PlanPicture />}
        {asked === null && <span className="mr-dim">Watch the wall. One of these sessions is about to need you…</span>}
      </div>
      <Next onClick={onNext} ready={asked === "allowed" || asked === "denied"}>Next: workspaces</Next>
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

// A small "done it" checklist the new steps share.
function Tasks({ items }: { items: { done: boolean; text: React.ReactNode }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {items.map((t, i) => (
        <div key={i} className="mr-row" style={{ gap: 12, padding: "8px 12px", background: t.done ? "var(--mr-tile)" : "var(--mr-well)", transition: "background .3s" }}>
          <span key={String(t.done)} className={t.done ? "mr-onb-pop mr-mono" : "mr-mono"} style={{ width: 18, color: t.done ? "var(--mr-done)" : "var(--mr-ink-3)", fontSize: 16 }}>{t.done ? "✓" : "○"}</span>
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── 2. Workspaces: one per client, and the Overview of all of them. ──
type DemoItem = { t: string; s: TileSpec["state"] };
const DEMO_WS: { name: string; items: DemoItem[] }[] = [
  { name: "Personal", items: [{ t: "Fix the login redirect", s: "working" }, { t: "Bump dependencies", s: "almost" }] },
  { name: "Client A", items: [{ t: "Migrate billing to Stripe", s: "needs_you" }, { t: "Review PR #482", s: "working" }, { t: "Q4 export plan", s: "review" }] },
];

function WorkspacesStep({ onNext }: { onNext: () => void }) {
  const [at, setAt] = useState(0);
  const [overview, setOverview] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [mapped, setMapped] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const pick = (i: number) => { setAt(i); setOverview(false); if (i !== 0) setSwitched(true); };
  const showMap = () => { setOverview(true); setMapped(true); };
  // The app's own ⌘0 / ⌘1–9 stand down while a dialog is open (appKey), so the intro handles them here.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!modKey(e) || e.shiftKey || e.altKey) return;
      const key = keyOf(e);
      if (key === "0") { e.preventDefault(); showMap(); }
      if (key === "1" || key === "2") { e.preventDefault(); pick(Number(key) - 1); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const needs = (w: (typeof DEMO_WS)[number]) => w.items.filter((x) => x.s === "needs_you").length;
  return (
    <>
      <Title kicker="One window per client" sub="Each workspace keeps its own Claude sign-in, memory and history, and shares your skills and settings. The Overview shows every workspace at once, so nothing waits unseen in another tab.">
        Every project, <span style={{ background: "var(--mr-needs)", color: "var(--mr-needs-ink)", padding: "0 8px" }}>one glance</span>.
      </Title>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 28, alignItems: "start", maxWidth: 1100 }}>
        <Tasks items={[
          { done: switched, text: <>Switch to <b>Client A</b>: press <span className="mr-mono">{keyLabel("⌘2")}</span> or click its tab</> },
          { done: mapped, text: <>Open the <b>Overview</b>: <span className="mr-mono">{keyLabel("⌘0")}</span></> },
          { done: opened !== null, text: <>Click a session on the map to jump straight in</> },
        ]} />
        <div data-mr="DemoWorkspaces" data-mr-source={overview ? "overview" : DEMO_WS[at].name} style={{ background: "var(--mr-well)", display: "flex", flexDirection: "column" }}>
          <div className="mr-row" style={{ gap: 2, padding: 3, background: "var(--mr-ink)" }}>
            {DEMO_WS.map((w, i) => (
              <button key={w.name} type="button" data-mr="DemoTab" data-mr-source={w.name} aria-pressed={!overview && at === i} onClick={() => pick(i)}
                style={{ border: 0, padding: "6px 12px", font: "inherit", cursor: "pointer", background: !overview && at === i ? "var(--mr-tile)" : "transparent", color: !overview && at === i ? "var(--mr-ink)" : "var(--mr-tile)", display: "flex", gap: 8, alignItems: "center" }}>
                {w.name}<span className="mr-mono" style={{ fontSize: 11, opacity: 0.6 }}>{keyLabel(`⌘${i + 1}`)}</span>
                {needs(w) > 0 && <span style={{ background: "var(--mr-needs)", color: "var(--mr-needs-ink)", padding: "0 5px", fontSize: 12, fontWeight: 700 }}>{needs(w)}</span>}
              </button>
            ))}
            <span className="mr-grow" />
            <button type="button" data-mr="DemoTab" data-mr-source="Overview" aria-pressed={overview} onClick={showMap}
              className={switched && !mapped ? "mr-onb-nudge" : undefined}
              style={{ border: 0, padding: "6px 12px", font: "inherit", cursor: "pointer", background: overview ? "var(--mr-tile)" : "transparent", color: overview ? "var(--mr-ink)" : "var(--mr-tile)" }}>
              Overview <span className="mr-mono" style={{ fontSize: 11, opacity: 0.6 }}>{keyLabel("⌘0")}</span>
            </button>
          </div>
          <div key={overview ? "map" : at} className="mr-onb-rise" style={{ padding: 14, minHeight: 210 }}>
            {overview ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {DEMO_WS.map((w, i) => (
                  <div key={w.name} style={{ background: "var(--mr-base)", padding: 10, display: "flex", flexDirection: "column", gap: 6, boxShadow: needs(w) > 0 ? "inset 3px 0 0 var(--mr-needs)" : undefined }}>
                    <span className="mr-row" style={{ gap: 8 }}><strong>{w.name}</strong>{needs(w) > 0 && <span className="mr-dim" style={{ fontSize: 12 }}>⚠ {needs(w)} needs you</span>}</span>
                    {w.items.map((x) => (
                      <button key={x.t} type="button" data-mr="DemoBlock" data-mr-source={x.t} onClick={() => { setOpened(x.t); setAt(i); setOverview(false); }}
                        style={{ border: 0, padding: "6px 8px", font: "inherit", fontSize: 13, textAlign: "left", cursor: "pointer", background: "var(--mr-tile)", color: "var(--mr-ink)", display: "flex", flexDirection: "column", gap: 2 }}>
                        <span>{x.t}</span><StateMark s={x.s} />
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
                {DEMO_WS[at].items.map((x) => (
                  <div key={x.t} style={{ padding: 12, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 6, boxShadow: opened === x.t ? "inset 0 0 0 3px var(--mr-selected)" : x.s === "needs_you" ? "inset 0 0 0 3px var(--mr-needs)" : undefined }}>
                    <StateMark s={x.s} /><strong style={{ fontSize: 14 }}>{x.t}</strong>
                    {opened === x.t && <span className="mr-onb-rise mr-dim" style={{ fontSize: 12 }}>Opened from the map</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {opened !== null && (
        <div className="mr-onb-rise mr-row" style={{ gap: 14 }}>
          <Burst />
          <strong style={{ fontSize: 20 }}>Straight there.</strong>
          <span className="mr-dim">{keyLabel("⌘1–9 jump to a workspace; ⌘0 is the map of all of them, and where Cockpit opens when you have several.")}</span>
        </div>
      )}
      <Next onClick={onNext} ready={opened !== null}>Next: review</Next>
    </>
  );
}

// ── 3. Review a PR one finding at a time; Address turns reviewer threads into fixes. ──
function ReviewStep({ onNext }: { onNext: () => void }) {
  const [noted, setNoted] = useState(false);
  const [published, setPublished] = useState(false);
  const [fix, setFix] = useState<string | null>(null);
  const note = () => setNoted(true);
  const publish = () => { if (noted) setPublished(true); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const key = keyOf(e);
      if (key === "n" && !modKey(e)) { e.preventDefault(); note(); }
      if (key === "Enter" && modKey(e)) { e.preventDefault(); publish(); }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <>
      <Title kicker="Review, one finding at a time" sub={<>Start a review from <span className="mr-mono">{keyLabel("⌘K")}</span> and your <span className="mr-mono">/review</span> comes back as findings, riskiest first, each with its snippet. Note the ones that matter and publish them as one GitHub review.</>}>
        Read the <span style={{ background: "var(--mr-needs)", color: "var(--mr-needs-ink)", padding: "0 8px" }}>risk</span>, not the whole diff.
      </Title>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 28, alignItems: "start", maxWidth: 1100 }}>
        <Tasks items={[
          { done: noted, text: <>Note the finding: press <span className="mr-mono">N</span></> },
          { done: published, text: <>Publish and approve: <span className="mr-mono">{keyLabel("⌘↵")}</span></> },
        ]} />
        <div data-mr="DemoReview" data-mr-source={published ? "published" : noted ? "noted" : "finding"} style={{ background: "var(--mr-tile)", padding: 16, display: "flex", flexDirection: "column", gap: 10, boxShadow: "inset 4px 0 0 var(--mr-error)" }}>
          <span className="mr-dim mr-mono" style={{ fontSize: 12 }}>PR #482 · Retry the billing export · finding 1 of 3 · riskiest first</span>
          <strong style={{ fontSize: 17 }}>Retries forever, with no backoff</strong>
          <code className="mr-code mr-mono" style={{ padding: 8, whiteSpace: "pre", fontSize: 12 }}>{"billing/export.ts:42\n  while (!ok) ok = await send(batch);"}</code>
          <span className="mr-dim">A provider outage turns into a tight loop that hammers it and never gives up.</span>
          {noted && <span className="mr-onb-rise" style={{ padding: "6px 10px", background: "var(--mr-well)", fontSize: 13 }}>Your note on line 42: “Cap the retries and back off.”</span>}
          <div className="mr-row" style={{ gap: 8 }}>
            {!noted && <Key k="N" tone="primary" onClick={note}>Note it</Key>}
            {noted && !published && <span className="mr-onb-nudge"><Key k="⌘↵" tone="primary" onClick={publish}>Publish and approve</Key></span>}
            {published && <span className="mr-onb-rise mr-row" style={{ gap: 10 }}><Burst /><strong>Published: 1 comment, approved.</strong></span>}
          </div>
        </div>
      </div>
      {published && (
        <div className="mr-onb-rise" style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 1100 }}>
          <span className="mr-dim">On your own PRs it runs the other way. <b>Address</b> takes each reviewer thread and asks how to answer it; the session makes the fix:</span>
          <div className="mr-row" style={{ gap: 12, padding: 14, background: "var(--mr-tile)", boxShadow: "inset 4px 0 0 var(--mr-needs)", flexWrap: "wrap" }}>
            <span className="mr-grow">Reviewer: “Can this reuse the shared backoff helper?”</span>
            {["Fix it", "Reply", "Skip"].map((o) => <Key key={o} tone={fix === o ? "primary" : undefined} pressed={fix === o} onClick={() => setFix(o)}>{o}</Key>)}
          </div>
        </div>
      )}
      <Next onClick={onNext} ready={published}>Next: plans</Next>
    </>
  );
}

// ── 4. Plans: a working doc you decide on before any code. ──
function PlanStep({ onNext }: { onNext: () => void }) {
  const [where, setWhere] = useState<string | null>(null);
  const [built, setBuilt] = useState(false);
  const blocks = [
    { h: "Goal", b: "Finance gets a monthly CSV of every invoice, without asking an engineer." },
    { h: "Scope", b: "In: invoices, refunds. Out: payouts, tax reports." },
    { h: "Risk", b: "Large months may time out the API. Mitigation: stream rows." },
  ];
  return (
    <>
      <Title kicker="Plan first, code later" sub={<>Pick <b>Plan</b> when you start and Claude writes a working doc before touching code: goal, scope, design, risks and open questions, each drawn the way it reads best. Decide the questions, leave notes, then build from it.</>}>
        A plan you can read in <span style={{ background: "var(--mr-needs)", color: "var(--mr-needs-ink)", padding: "0 8px" }}>ten seconds</span>.
      </Title>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)", gap: 28, alignItems: "start", maxWidth: 1100 }}>
        <Tasks items={[
          { done: where !== null, text: <>Decide the open question</> },
          { done: built, text: <>Build from the doc</> },
        ]} />
        <div data-mr="DemoPlan" data-mr-source={built ? "built" : where ?? "open"} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <strong style={{ fontSize: 17 }}>Plan: billing export</strong>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
            {blocks.map((x) => (
              <div key={x.h} style={{ padding: 12, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="mr-mono mr-dim" style={{ fontSize: 11, textTransform: "uppercase" }}>{x.h}</span>
                <span style={{ fontSize: 14 }}>{x.b}</span>
              </div>
            ))}
          </div>
          <div className={where === null ? "mr-onb-pulse" : undefined} style={{ padding: 12, background: "var(--mr-tile)", display: "flex", flexDirection: "column", gap: 8 }}>
            <span className="mr-mono mr-dim" style={{ fontSize: 11, textTransform: "uppercase" }}>Open question</span>
            <strong>Where does the export run?</strong>
            <div className="mr-row" style={{ gap: 8, flexWrap: "wrap" }}>
              {[["Nightly job", "Ready each morning; one more cron to watch"], ["On demand", "Always fresh; slow for big months"]].map(([o, d]) => (
                <button key={o} type="button" aria-pressed={where === o} onClick={() => setWhere(o)}
                  style={{ border: 0, padding: "8px 12px", font: "inherit", textAlign: "left", cursor: "pointer", background: "var(--mr-well)", color: "var(--mr-ink)", boxShadow: where === o ? "inset 3px 0 0 var(--mr-selected)" : undefined, display: "flex", flexDirection: "column", gap: 2 }}>
                  <strong>{o}</strong><span className="mr-dim" style={{ fontSize: 12 }}>{d}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mr-row" style={{ gap: 10 }}>
            <span className="mr-grow" />
            {!built ? <span className={where !== null ? "mr-onb-nudge" : undefined}><Key tone="primary" disabled={where === null} onClick={() => setBuilt(true)}>Build from doc</Key></span>
              : <span className="mr-onb-rise mr-row" style={{ gap: 10 }}><Burst /><strong>A build session starts from the doc.</strong></span>}
          </div>
        </div>
      </div>
      {built && <span className="mr-onb-rise mr-dim" style={{ maxWidth: 1100 }}>Its progress tracks the doc's steps, and the doc stays the reference: open it any time from the session or the Wall.</span>}
      <Next onClick={onNext} ready={built}>Next: connect</Next>
    </>
  );
}

// ── 5. Connect: live checks. ──
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
        <Check ok={null} optional title="Picker model (optional)"
          detail={keyLabel("Cloudflare's free Clef-flash model helps sort unclear messages. Everything works without it. Add it any time in Settings (⌘,).")} />
      </div>
      <Next onClick={onNext} ready={acct.signedIn}>Next: permissions</Next>
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

// ── 6. How often sessions ask. ──
function PermissionStep({ state, onNext }: { state: AppState; onNext: () => void }) {
  // The pick is logged right away, so skipping the intro after this step keeps it.
  const { pick, dialog } = usePermissionPick();
  return (
    <>
      <Title kicker="Fewer interruptions" sub="Every tool a session uses can stop and wait for your Allow. Pick how often. You can change it any time in Settings → Sessions.">
        How often should sessions <span style={{ background: "var(--mr-needs)", color: "var(--mr-needs-ink)", padding: "0 8px" }}>ask</span>?
      </Title>
      <div style={{ maxWidth: 1100 }}><PermissionOptions value={state.permissionMode} onPick={pick} /></div>
      {dialog}
      <Next onClick={() => { if (state.permissionMode === null) void api.setPermissionMode("auto"); onNext(); }}>Next: go</Next>
    </>
  );
}

// ── 7. Go. ──
function GoStep({ onStart }: { onStart: (kind: SessionKind) => void }) {
  const kinds = [
    { id: "blank" as const, t: "Blank", d: "Any task. Gets its own git worktree, so your checkout stays clean.", k: "⌘1" },
    { id: "plan" as const, t: "Plan", d: "A working doc first: a map you annotate and decide on before any code.", k: "⌘2" },
    { id: "review" as const, t: "Review", d: "Your /review on a PR, as findings you step through.", k: "⌘3" },
    { id: "address" as const, t: "Address", d: "Your /pr-address, one reviewer thread at a time.", k: "⌘4" },
  ];
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (keyOf(e) === "Enter") { e.preventDefault(); onStart("blank"); } };
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
          <button key={x.t} type="button" onClick={() => onStart(x.id)} className="mr-onb-rise mr-onb-lift"
            style={{ animationDelay: `${i * 80}ms`, border: 0, padding: 18, textAlign: "left", font: "inherit", color: "var(--mr-ink)", background: "var(--mr-tile)", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8, minHeight: 150 }}>
            <span className="mr-row" style={{ justifyContent: "space-between" }}><strong style={{ fontSize: 18 }}>{x.t}</strong><kbd className="mr-mono mr-dim">{keyLabel(x.k)}</kbd></span>
            <span className="mr-dim">{x.d}</span>
          </button>
        ))}
      </div>
      <div className="mr-row" style={{ gap: 18, marginTop: "auto" }}>
        <span className="mr-dim">Any time: <span className="mr-mono">{keyLabel("⌘K")}</span> start · <span className="mr-mono">{keyLabel("⌘,")}</span> settings · <span className="mr-mono">{keyLabel("⌘⇧G")}</span> god mode · right-click anything that's wrong · <span className="mr-mono">{keyLabel("⌥-click")}</span> to ask about it</span>
        <span className="mr-grow" />
        <span className="mr-onb-nudge"><Key k="↵" tone="primary" onClick={() => onStart("blank")}>Start my first session</Key></span>
      </div>
    </>
  );
}
