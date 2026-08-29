import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadItemsDir } from "decently-coordinated-loops/tools/parse.ts";
import { loadArchiveDir, loadForDeliveryDir } from "decently-coordinated-loops/tools/parse.ts";
import { loadConfig } from "decently-coordinated-loops/tools/config.ts";
import { runPreflight } from "decently-coordinated-loops/tools/preflight.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixtures");
const FIXTURES = join(FIXTURE_ROOT, "items");

const HEADER = `| Item | Project | State | Next-actor | Awaiting | Auto | Assignee | Updated |
| --- | --- | --- | --- | --- | --- | --- | --- |
`;

describe("runPreflight", () => {
  const items = loadItemsDir(FIXTURES);
  const terminalItems = [
    ...loadForDeliveryDir(join(FIXTURE_ROOT, "for-delivery")),
    ...loadArchiveDir(join(FIXTURE_ROOT, "archive")),
  ];
  const preflight = (boardText: string) =>
    runPreflight(boardText, items, terminalItems, loadConfig(FIXTURE_ROOT));

  test("detects an orphan row (board row with no matching item file)", () => {
    const boardText =
      HEADER +
      "| [Ghost row](items/does-not-exist.md) | alpha | idea | owner | decide | - | - | 2026-07-01 |\n";
    const report = preflight(boardText);
    expect(report.orphanRows.length).toBe(1);
    expect(report.orphanRows[0].path).toBe("items/does-not-exist.md");
  });

  test("detects a missing row (item file with no board row) for auto-add self-heal", () => {
    const boardText = HEADER; // no rows at all
    const report = preflight(boardText);
    expect(report.missingRows).toContain("alpha-spec-filed");
    expect(report.missingRows.length).toBe(items.length);
  });

  test("detects a field mismatch and reports item-file value as canonical", () => {
    const boardText =
      HEADER +
      "| [Spec example](items/alpha-spec-filed.md) | alpha | spec-filed | owner | decide | - | - | 2026-08-01 |\n";
    const report = preflight(boardText);
    const mismatch = report.mismatches.find((m) => m.slug === "alpha-spec-filed" && m.field === "awaiting");
    expect(mismatch).toBeDefined();
    if (!mismatch) throw new Error("expected the synthetic awaiting mismatch");
    expect(mismatch.boardValue).toBe("decide");
    expect(mismatch.fileValue).toBe("approve");
  });

  test("reports an assignee mismatch by its canonical field name", () => {
    const boardText =
      HEADER +
      "| [Spec example](items/alpha-spec-filed.md) | alpha | spec-filed | owner | approve | - | codex/default | 2026-08-01 |\n";
    const report = preflight(boardText);
    expect(report.mismatches).toContainEqual({
      slug: "alpha-spec-filed",
      field: "assignee",
      boardValue: "codex/default",
      fileValue: "-",
    });
  });

  test("no mismatch when board row matches the item file exactly", () => {
    const boardText =
      HEADER +
      "| [Spec example](items/alpha-spec-filed.md) | alpha | spec-filed | owner | approve | - | - | 2026-08-01 |\n";
    const report = preflight(boardText);
    expect(report.mismatches.length).toBe(0);
    expect(report.orphanRows.length).toBe(0);
  });

  test("ignores the Done section table (different column shape)", () => {
    const boardText =
      HEADER +
      "\n## Done\n\n| Item | Project | Finished |\n| --- | --- | --- |\n" +
      "| [Some done item](items/somewhere.md) | example | 2026-07-01 |\n";
    const report = preflight(boardText);
    expect(report.orphanRows.length).toBe(0);
  });

  test("parses a row whose title itself contains a bracketed fragment (regression: naive [^\\]]+ regex breaks on this)", () => {
    const boardText =
      HEADER +
      "| [Example [S6] title](items/alpha-spec-filed.md) | alpha | spec-filed | owner | approve | - | - | 2026-08-01 |\n";
    const report = preflight(boardText);
    expect(report.orphanRows.length).toBe(0);
    expect(report.missingRows).not.toContain("alpha-spec-filed");
    expect(report.mismatches.length).toBe(0);
  });
});
