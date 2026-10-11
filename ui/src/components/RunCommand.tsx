import { createContext, useContext } from "react";

// Where a Run button sends its command (MR-85): the Focus transcript provides it for its session.
// Outside a provider (docs, views) commands show as plain code.
export const RunCommand = createContext<((command: string) => void) | null>(null);

export function RunKey({ command, compact }: { command: string; compact?: boolean }) {
  const run = useContext(RunCommand);
  if (!run) return null;
  return (
    <button type="button" className="mr-key" data-mr="RunCommand" data-mr-source={command} title={`Run in the session's folder:\n${command}`} onClick={() => run(command)}
      style={compact ? { minHeight: 0, padding: "0 6px", marginLeft: 4, fontSize: 11, verticalAlign: "baseline" } : { minHeight: 26, padding: "0 10px", fontSize: 12 }}>
      ▶ Run
    </button>
  );
}
