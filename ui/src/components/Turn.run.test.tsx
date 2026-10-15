import { expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportView, parseReport } from "./Turn";
import { RunCommand } from "./RunCommand";

// God-mode mark: a "Blocked" section said "Run this in your terminal" over an unlabelled
// `gcloud …` fence and showed no Run button; the user had to copy it to a terminal.
test("a command a report section says to run gets a Run button", () => {
  const text = `## Where things stand
- **Harness:** heal flow wired, about 5 min left
- **Tests:** unit tests pass
- **Firestore:** not reached yet

## Blocked: Google Cloud login has expired
Run this in your terminal (about 1 min):
\`\`\`
gcloud auth application-default login
\`\`\`
Every heal harness reads Firestore, and the read-only \`TestWhichPending\` just failed with \`invalid_grant (invalid_rapt)\`. Nothing has been read from Firestore or written to it.`;
  const html = renderToStaticMarkup(<RunCommand.Provider value={() => {}}><ReportView r={parseReport(text)!} onReply={() => {}} live /></RunCommand.Provider>);
  expect(html).toContain('data-mr="ReportSection"');
  expect(html).toContain('data-mr="RunCommand" data-mr-source="gcloud auth application-default login"');
});
