import { Component, type ReactNode } from "react";

// One broken component must never blank the app (found by the MR-40 walkthrough): show what broke,
// keep everything else usable, and offer the fix path (god mode marks it for a fix session).
export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" data-mr="ErrorPanel" data-mr-source={this.props.name} style={{ margin: 16, padding: 16, background: "var(--mr-tile)", boxShadow: "inset 4px 0 0 var(--mr-error)", display: "flex", flexDirection: "column", gap: 8 }}>
        <strong>The {this.props.name} view hit a bug</strong>
        <span className="mr-mono mr-dim" style={{ fontSize: 12, wordBreak: "break-word" }}>{String(this.state.error.message)}</span>
        <span className="mr-dim">Your sessions keep running. Right-click here and choose “Mark as wrong & fix” to have it repaired.</span>
        <span><button type="button" className="mr-key" onClick={() => this.setState({ error: null })}>Try again</button></span>
      </div>
    );
  }
}
