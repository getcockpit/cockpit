import { expect, test } from "vitest";
import { parseTable, splitRow } from "./Markdown";
import { parseReport } from "../picker/report";

// The separator regex used to be [\s:-|] (a ':'..'|' range): it hid rows of plain words and
// showed the |---| line as a row of dashes.
test("tables: header, alignment, every body row kept", () => {
  const t = parseTable(["| Name | Size | Done |", "|:-----|-----:|:----:|", "| alpha | 12 | yes |", "| beta gamma | 3 | no |"]);
  expect(t.head).toEqual(["Name", "Size", "Done"]);
  expect(t.align).toEqual(["left", "right", "center"]);
  expect(t.rows).toEqual([["alpha", "12", "yes"], ["beta gamma", "3", "no"]]);
});

test("tables: no separator means no header", () => {
  const t = parseTable(["| a | b |", "| c | d |"]);
  expect(t.head).toBeNull();
  expect(t.rows).toHaveLength(2);
});

test("tables: pipes in inline code and escaped pipes don't split cells", () => {
  expect(splitRow("| `a | b` | c \\| d |")).toEqual(["`a | b`", "c | d"]);
});

test("reports: a table after a section's list stays after it", () => {
  const text = `## Options compared
Intro line.
- **One:** first option, about 5 min
- **Two:** second option
- **Three:** third option

| Option | Cost |
|---|---|
| One | low |

Next: "Pick one"`;
  const r = parseReport(text.padEnd(320, " "))!;
  const s = r.sections[0];
  expect(s.intro).toEqual(["Intro line."]);
  expect(s.items).toHaveLength(3);
  expect(s.outro).toEqual(["| Option | Cost |", "|---|---|", "| One | low |"]);
});
