import { describe, expect, test } from "bun:test";
import type { ItemFile } from "decently-coordinated-loops/tools/types.ts";
import { makePriorityCompare } from "../src/bucket.ts";

function item(slug: string, project: string, updated = "2026-08-01"): ItemFile {
  return {
    path: `items/${slug}.md`, slug, title: slug, project, state: "idea", assignee: "-",
    autonomy: "-", nextActor: "agent", awaiting: "-", fit: "", dependsOn: [],
    nextStep: "next", updated, links: {},
  };
}

describe("makePriorityCompare", () => {
  test("ranks projects from loops.json configuration without a built-in project", () => {
    const compare = makePriorityCompare(["second", "first"]);
    const items = [item("a", "first"), item("b", "unlisted", "2026-08-29"), item("c", "second")];
    expect(items.sort(compare).map((entry) => entry.project)).toEqual(["second", "first", "unlisted"]);
  });
});
