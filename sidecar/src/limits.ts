import type { Outbound } from "./protocol";
import type { QueryFn } from "./sessions";

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;

// Plan limits without running a turn: open a query whose prompt never arrives, ask Claude Code for
// its usage (the same data as /usage), close. Nothing is sent to the model, so it costs nothing.
// The SDK marks this API experimental; any failure just leaves the lamps at "—" until a session
// reports a rate_limit_event.
export async function limits(query: QueryFn, claudePath: string | undefined, env: Record<string, string> | undefined, emit: (o: Outbound) => void): Promise<void> {
  const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}) }) };
  const q = query({ prompt: idle, options: { pathToClaudeCodeExecutable: claudePath, settingSources: [], persistSession: false, tools: [], env: env ? { ...process.env, ...env } : undefined } }) as ReturnType<QueryFn> & {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<{ rate_limits_available: boolean; subscription_type: string | null; rate_limits: Record<string, Window> | null }>;
  };
  const win = (w: Window) => (w && w.utilization !== null ? { utilization: w.utilization / 100, resetsAt: w.resets_at ? Math.round(Date.parse(w.resets_at) / 1000) : null } : null);
  try {
    const ask = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (!ask) throw new Error("this SDK has no usage API");
    const r = await Promise.race([ask.call(q, { skipBehaviors: true }), new Promise<never>((_, no) => setTimeout(() => no(new Error("timed out")), 30000))]);
    emit({ type: "limits", available: r.rate_limits_available, plan: r.subscription_type, five_hour: win(r.rate_limits?.five_hour), seven_day: win(r.rate_limits?.seven_day) });
  } catch (e) {
    emit({ type: "limits", available: false, error: String(e) });
  } finally {
    q.close?.();
  }
}
