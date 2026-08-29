import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  loadArchiveDir,
  loadForDeliveryDir,
  loadItemsDir,
  parseItemFileText,
} from "decently-coordinated-loops/tools/parse.ts";

const FIXTURES = join(import.meta.dir, "fixtures/items");
const ARCHIVE_FIXTURES = join(import.meta.dir, "fixtures/archive");
const FOR_DELIVERY_FIXTURES = join(import.meta.dir, "fixtures/for-delivery");

describe("parseItemFileText", () => {
  test("parses core fields from frontmatter", () => {
    const text = `---
title: "Alpha needs approve"
project: alpha
state: spec-filed
owner: "-"
autonomy: supervised
next-actor: owner
awaiting: approve
next-step: "owner: approve the spec"
updated: 2026-07-01
---
Body text.
`;
    const item = parseItemFileText("items/alpha-needs-approve.md", text);
    expect(item.slug).toBe("alpha-needs-approve");
    expect(item.title).toBe("Alpha needs approve");
    expect(item.project).toBe("alpha");
    expect(item.state).toBe("spec-filed");
    expect(item.nextActor).toBe("owner");
    expect(item.awaiting).toBe("approve");
    expect(item.updated).toBe("2026-07-01");
    expect(item.dependsOn).toEqual([]);
  });

  test("parses depends-on array and links block", () => {
    const text = `---
title: "Delivery slice"
project: example
state: spec-filed
owner: "-"
autonomy: auto
next-actor: agent
depends-on: [example-foundation, example-other]
next-step: "Build it"
updated: 2026-07-06
links:
  spec: docs/specs/2026-07-08-thing.md
  pr: https://github.com/example/pr/1
---
Body.
`;
    const item = parseItemFileText("items/delivery-slice.md", text);
    expect(item.dependsOn).toEqual(["example-foundation", "example-other"]);
    expect(item.links.spec).toBe("docs/specs/2026-07-08-thing.md");
    expect(item.links.pr).toBe("https://github.com/example/pr/1");
  });

  test("omits awaiting when absent", () => {
    const text = `---
title: "Agent item"
project: example
state: spec-filed
owner: "-"
autonomy: auto
next-actor: agent
next-step: "Build it"
updated: 2026-07-06
---
Body.
`;
    const item = parseItemFileText("items/agent-item.md", text);
    expect(item.awaiting).toBeUndefined();
  });

  test("throws on missing frontmatter block", () => {
    expect(() => parseItemFileText("items/broken.md", "no frontmatter here")).toThrow();
  });
});

describe("loadItemsDir", () => {
  test("loads and sorts all fixture item files by slug", () => {
    const items = loadItemsDir(FIXTURES);
    expect(items.length).toBe(6);
    const slugs = items.map((i) => i.slug);
    expect(slugs).toEqual([...slugs].sort());
    const one = items.find((i) => i.slug === "beta-in-progress");
    expect(one?.dependsOn).toEqual(["alpha-accepted"]);
  });
});

describe("loadArchiveDir", () => {
  test("loads and sorts all fixture archive files by slug, with archive/ paths", () => {
    const items = loadArchiveDir(ARCHIVE_FIXTURES);
    expect(items.length).toBe(2);
    const slugs = items.map((i) => i.slug);
    expect(slugs).toEqual(["alpha-accepted", "alpha-dropped"]);
    const accepted = items.find((i) => i.slug === "alpha-accepted");
    expect(accepted?.path).toBe("archive/alpha-accepted.md");
    expect(accepted?.state).toBe("accepted");
  });

  test("returns an empty array for a directory that doesn't exist yet", () => {
    expect(loadArchiveDir(join(import.meta.dir, "fixtures/no-such-archive-dir"))).toEqual([]);
  });
});

describe("loadForDeliveryDir", () => {
  test("loads for-delivery files by slug, with for-delivery/ paths", () => {
    const items = loadForDeliveryDir(FOR_DELIVERY_FIXTURES);
    const slugs = items.map((i) => i.slug);
    expect(slugs).toEqual(["alpha-delivered", "alpha-tested"]);
    const tested = items.find((i) => i.slug === "alpha-tested");
    expect(tested?.path).toBe("for-delivery/alpha-tested.md");
    expect(tested?.state).toBe("tested");
  });

  test("returns an empty array for a directory that doesn't exist yet", () => {
    expect(loadForDeliveryDir(join(import.meta.dir, "fixtures/no-such-dir"))).toEqual([]);
  });
});
