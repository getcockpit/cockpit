import { lazy, Suspense, useState } from "react";
import { Bar, Key, Lamp, Lamps, RiskMeter, StateMark } from "../components";
import { FlowDiagram } from "../components/FlowDiagram";
import { api } from "../state/store";
import type { AppState } from "../state/types";
const SignInPane = lazy(() => import("./Terminal").then((m) => ({ default: m.SignInPane })));

// First run (MR-37): what this is and why, a live check that Claude Code is installed and signed in
// (sign-in runs the official `claude` /login in a terminal, never an in-app login), then the first
// session. It shows once; Settings can bring it back.

const STEPS = ["What this is", "Connect", "Start"] as const;

export function Onboarding({ state, onDone, onStart }: { state: AppState; onDone: () => void; onStart: () => void }) {
  const [step, setStep] = useState(0);
  const [signIn, setSignIn] = useState(false);
  const finish = (start: boolean) => { void api.log("ui.onboarded", {}); onDone(); if (start) onStart(); };
  const claude = state.sidecar.claude;
  const acct = state.account;

  return (
    <div role="dialog" aria-label="Welcome" data-mr="Onboarding" style={{ position: "fixed", inset: 0, zIndex: 40, display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "56px 24px", background: "rgba(21,24,27,.45)", overflowY: "auto" }}>
      <div style={{ width: "100%", maxWidth: 920, background: "var(--mr-tile)", display: "flex", flexDirection: "column" }}>
        <div className="mr-band mr-row" style={{ padding: "12px 18px", gap: 18 }}>
          <strong>Minority report</strong>
          {STEPS.map((s, i) => (
            <button key={s} type="button" onClick={() => setStep(i)} className="mr-row" style={{ gap: 6, border: 0, background: "transparent", font: "inherit", cursor: "pointer", color: i === step ? "var(--mr-ink)" : "var(--mr-ink-3)", fontWeight: i === step ? 700 : 400 }}>
              <span className="mr-mono">{i + 1}</span>{s}
            </button>
          ))}
          <span className="mr-grow" />
          <Key onClick={() => finish(false)}>Skip</Key>
        </div>

        {step === 0 && (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 26 }}>Run Claude Code in parallel. Read pictures, not transcripts.</h1>
              <p className="mr-dim" style={{ margin: "8px 0 0", maxWidth: 700, fontSize: 15 }}>
                Claude Code is powerful but wordy. This app runs several sessions side by side on your own Claude plan and turns what they do into visuals, so you can see what needs you, decide in one keystroke and move on.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "var(--mr-gap)" }}>
              <Card title="The wall" text="Every session at a glance. Amber means it needs you, red means it broke, green means it's done.">
                <Lamps><Lamp value={1} label="Needs you" on="needs" /><Lamp value={3} label="Running" on="plain" /><Lamp value={0} label="Errors" /></Lamps>
                <div className="mr-row" style={{ gap: 8, padding: "8px 0 0" }}><StateMark s="working" /><span className="mr-grow">Fix login bug</span><span className="mr-mono mr-dim">Step 3 of 5</span></div>
                <Bar value={0.6} />
              </Card>
              <Card title="Decision cards" text="When Claude wants to run something, you get a card with the risk spelled out. A allows, D denies.">
                <div className="mr-code mr-mono" style={{ padding: 8, fontSize: 12 }}>git push --force origin main</div>
                <RiskMeter risk="high" why="Rewrites shared history." />
              </Card>
              <Card title="Plans as maps" text="Long plans and recaps become diagrams and working docs you can point at, annotate and decide on.">
                <div style={{ transform: "scale(.62)", transformOrigin: "top left", height: 70 }}>
                  <FlowDiagram d={{ nodes: [{ id: "a", label: "Reproduce", kind: "step" }, { id: "b", label: "Pick a fix?", kind: "decision" }, { id: "c", label: "Tests green", kind: "done" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] }} />
                </div>
              </Card>
            </div>
            <ul className="mr-dim" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
              <li><b>Right-click anything</b> to mark it wrong. A session then fixes the app itself (god mode).</li>
              <li><b>⌘-click</b> goes deeper. <b>⌥-click</b> asks a side session about it. <b>⌥Space</b> lets you talk to whatever is under the pointer.</li>
              <li>It uses only the official <span className="mr-mono">claude</span> app and your own login. It never sees your password or tokens.</li>
            </ul>
            <div className="mr-row"><span className="mr-grow" /><Key k="↵" tone="primary" onClick={() => setStep(1)}>Next: connect</Key></div>
          </div>
        )}

        {step === 1 && (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
            <Check ok={!!claude} title="Claude Code is installed" detail={claude ? claude : state.sidecar.up ? "Not found. Install it in a terminal: curl -fsSL https://claude.ai/install.sh | bash, then restart this app." : "Starting…"} />
            <Check ok={acct.checked ? acct.signedIn : null} title="You're signed in with a Claude plan"
              detail={!acct.checked ? "Checking…" : acct.signedIn ? `${(acct.plan ?? "").toUpperCase() || "Subscription"} plan. Usage: ${pct(state.usage.fiveHour)} of the 5-hour window, ${pct(state.usage.weekly)} of the week.` : "Not signed in, or using an API key. Sign in with the official claude app below."}
              action={acct.checked && !acct.signedIn && !signIn ? <Key tone="primary" onClick={() => setSignIn(true)}>Sign in</Key> : acct.signedIn ? null : <Key onClick={() => void api.refreshLimits()}>Check again</Key>} />
            {signIn && (
              <div style={{ background: "var(--mr-well)", padding: 8 }}>
                <Suspense fallback={<span className="mr-dim">Opening claude…</span>}>
                  <SignInPane workspace="personal" onExit={() => { setSignIn(false); void api.refreshLimits(); }} />
                </Suspense>
              </div>
            )}
            <Check ok={state.clef.calls > 0 ? true : null} optional title="Picker model (optional)"
              detail="Cloudflare's free Clef-flash model helps sort unclear messages. Everything works without it, and you can add it later in Settings (⌘,)." />
            <div className="mr-row"><Key onClick={() => setStep(0)}>Back</Key><span className="mr-grow" /><Key k="↵" tone="primary" onClick={() => setStep(2)}>Next: start</Key></div>
          </div>
        )}

        {step === 2 && (
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
            <h2 style={{ margin: 0 }}>The wall fills up as sessions run</h2>
            <p className="mr-dim" style={{ margin: 0, maxWidth: 700 }}>
              Every visual is built from a live session, so an empty wall is normal at first. Start one: pick a folder, then say what you want. Blank sessions get their own git worktree, so your checkout stays untouched.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "var(--mr-gap)" }}>
              {[["Blank", "Any task"], ["Plan", "A working doc first, code later"], ["Review", "Your /review on a PR, shown as findings"], ["Address", "Your /pr-address, one thread at a time"]].map(([t, d]) => (
                <div key={t} style={{ padding: 12, background: "var(--mr-well)" }}><strong>{t}</strong><div className="mr-dim">{d}</div></div>
              ))}
            </div>
            <div className="mr-row"><Key onClick={() => setStep(1)}>Back</Key><span className="mr-grow" /><span className="mr-dim">Later: <span className="mr-mono">⌘K</span> starts anything</span><Key k="↵" tone="primary" onClick={() => finish(true)}>Start my first session</Key></div>
          </div>
        )}
      </div>
    </div>
  );
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

function Card({ title, text, children }: { title: string; text: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: 14, background: "var(--mr-well)", display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <strong>{title}</strong>
      <div style={{ background: "var(--mr-tile)", padding: 10, display: "flex", flexDirection: "column", gap: 6, overflow: "hidden" }}>{children}</div>
      <span className="mr-dim">{text}</span>
    </div>
  );
}

function Check({ ok, title, detail, action, optional }: { ok: boolean | null; title: string; detail: string; action?: React.ReactNode; optional?: boolean }) {
  const mark = ok === true ? "✓" : ok === false ? "✕" : optional ? "○" : "…";
  const color = ok === true ? "var(--mr-done)" : ok === false ? "var(--mr-error)" : "var(--mr-ink-3)";
  return (
    <div className="mr-row" style={{ padding: 12, background: "var(--mr-well)", gap: 12 }}>
      <span className="mr-mono" style={{ color, fontSize: 18, width: 20, textAlign: "center" }}>{mark}</span>
      <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}><strong>{title}</strong><span className="mr-dim" style={{ wordBreak: "break-word" }}>{detail}</span></span>
      {action}
    </div>
  );
}
