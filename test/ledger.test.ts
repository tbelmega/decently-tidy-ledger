import { describe, expect, test } from "bun:test";
import type { ItemFile } from "decently-coordinated-loops/tools/types.ts";
import { LEDGER_COLUMNS, buildLedgerColumns, columnKeyFor } from "../src/ledger.ts";

function item(overrides: Partial<ItemFile> & { slug: string }): ItemFile {
  return {
    path: `items/${overrides.slug}.md`,
    title: overrides.slug,
    project: "alpha",
    state: "idea",
    assignee: "-",
    autonomy: "supervised",
    nextActor: "agent",
    dependsOn: [],
    nextStep: "do the thing",
    updated: "2026-08-01",
    links: {},
    ...overrides,
  };
}

function columnOf(columns: ReturnType<typeof buildLedgerColumns>, key: string) {
  const col = columns.find((c) => c.key === key);
  if (!col) throw new Error(`column missing: ${key}`);
  return col;
}

describe("columnKeyFor", () => {
  test("maps every canonical state to its lifecycle column", () => {
    expect(columnKeyFor("idea")).toBe("idea");
    expect(columnKeyFor("spec-filed")).toBe("spec-filed");
    expect(columnKeyFor("in-progress")).toBe("in-progress");
    expect(columnKeyFor("blocked")).toBe("in-progress");
    expect(columnKeyFor("implemented")).toBe("implemented");
    expect(columnKeyFor("merged")).toBe("merged-tested");
    expect(columnKeyFor("tested")).toBe("merged-tested");
    expect(columnKeyFor("delivered")).toBe("delivered");
    expect(columnKeyFor("accepted")).toBe("delivered");
  });

  test("dropped is archived  -  mapped to no column at all", () => {
    expect(columnKeyFor("dropped")).toBeNull();
  });

  test("a non-canonical state falls into In progress rather than vanishing", () => {
    expect(columnKeyFor("deployed")).toBe("in-progress");
  });
});

describe("buildLedgerColumns surfaces malformed metadata", () => {
  // The deleted bucketing pass used to be the thing that flagged a missing next-actor.
  // The ledger is now the only view, so a card is where it has to show up.
  test("a missing next-actor blocks the card and says so", () => {
    const cols = buildLedgerColumns([item({ slug: "no-actor", nextActor: "" })], [], []);
    const card = cols.flatMap((c) => c.cards).find((c) => c.slug === "no-actor");
    expect(card?.blocked).toBe(true);
    // Wording is DCL's ("required but empty"), not this repo's former "is missing"  -
    // validate.ts is adopted verbatim from DCL and held there by dcl-drift.test.ts.
    expect(card?.blockedReason).toContain("next-actor is required but empty");
  });

  test("a violation on an otherwise canonical state is not swallowed", () => {
    // `implemented` is canonical, so the old state-keyed check skipped validation here
    const cols = buildLedgerColumns(
      [item({ slug: "bad-autonomy", state: "implemented", autonomy: "supervized" })],
      [],
      [],
    );
    const card = cols.flatMap((c) => c.cards).find((c) => c.slug === "bad-autonomy");
    expect(card?.blocked).toBe(true);
    expect(card?.blockedReason).toContain("supervized");
  });

  test("a well-formed item is left alone", () => {
    const cols = buildLedgerColumns([item({ slug: "fine", nextActor: "owner" })], [], []);
    const card = cols.flatMap((c) => c.cards).find((c) => c.slug === "fine");
    expect(card?.blocked).toBe(false);
    expect(card?.blockedReason).toBeUndefined();
  });
});

describe("buildLedgerColumns", () => {
  test("always yields all six columns in lifecycle order, even when empty", () => {
    const columns = buildLedgerColumns([]);
    expect(columns.map((c) => c.key)).toEqual(LEDGER_COLUMNS.map((c) => c.key));
    expect(columns.map((c) => c.label)).toEqual([
      "Idea",
      "Spec filed",
      "In progress",
      "Implemented",
      "Merged & tested",
      "Delivered",
    ]);
    for (const col of columns) expect(col.cards).toEqual([]);
  });

  test("dropped items are never rendered and appear in no column", () => {
    const columns = buildLedgerColumns([item({ slug: "gone", state: "dropped" })]);
    expect(columns.flatMap((c) => c.cards)).toEqual([]);
  });

  test("for-delivery items land in the merged-tested and delivered columns naturally", () => {
    const columns = buildLedgerColumns(
      [],
      [
        item({ slug: "ship-tested", state: "tested" }),
        item({ slug: "ship-delivered", state: "delivered" }),
      ],
    );
    expect(columnOf(columns, "merged-tested").cards.map((c) => c.slug)).toEqual(["ship-tested"]);
    expect(columnOf(columns, "delivered").cards.map((c) => c.slug)).toEqual(["ship-delivered"]);
  });

  test("state blocked lands in In progress with the blocked treatment", () => {
    const columns = buildLedgerColumns([item({ slug: "stuck", state: "blocked" })]);
    const [card] = columnOf(columns, "in-progress").cards;
    expect(card.slug).toBe("stuck");
    expect(card.blocked).toBe(true);
    expect(card.blockedReason).toBe("blocked");
  });

  test("an anomalous state gets the blocked treatment with its validation message as the reason", () => {
    const columns = buildLedgerColumns([item({ slug: "odd", state: "deployed" })]);
    const [card] = columnOf(columns, "in-progress").cards;
    expect(card.blocked).toBe(true);
    expect(card.blockedReason).toMatch(/state "deployed" is not a canonical state/);
  });

  test("an unsatisfied depends-on blocks the card in ANY column", () => {
    const columns = buildLedgerColumns([
      item({ slug: "building", state: "in-progress", dependsOn: ["base"] }),
      item({ slug: "base", state: "implemented" }), // review requested ≠ landed
    ]);
    const card = columnOf(columns, "in-progress").cards.find((c) => c.slug === "building");
    if (!card) throw new Error("building fixture card is missing");
    expect(card.blocked).toBe(true);
    expect(card.blockedReason).toBe("waiting on: base");
    expect(card.blockedBy).toEqual(["base"]);
  });

  test("blockedBy carries the unsatisfied targets structurally, for the drawer's facts row", () => {
    const columns = buildLedgerColumns(
      [
        item({ slug: "waiting", state: "idea", dependsOn: ["landed", "pending", "gone"] }),
        item({ slug: "pending", state: "in-progress" }),
      ],
      [],
      [item({ slug: "landed", state: "accepted" })],
    );
    const [card] = columnOf(columns, "idea").cards;
    // the archived target satisfies; the in-flight and the missing one do not  -
    // exactly the case the view cannot recompute, since archived items are not
    // in the payload's columns at all
    expect(card.blockedBy).toEqual(["pending", "gone"]);
  });

  test("an unblocked card reports no blocking targets rather than omitting the field", () => {
    const columns = buildLedgerColumns([item({ slug: "clear", state: "idea" })]);
    const [card] = columnOf(columns, "idea").cards;
    expect(card.blocked).toBe(false);
    expect(card.blockedBy).toEqual([]);
  });

  test("a state-blocked card with satisfied dependencies has no blocking targets", () => {
    const columns = buildLedgerColumns(
      [item({ slug: "stuck", state: "blocked", dependsOn: ["landed"] })],
      [],
      [item({ slug: "landed", state: "accepted" })],
    );
    const [card] = columnOf(columns, "in-progress").cards;
    expect(card.blocked).toBe(true);
    expect(card.blockedReason).toBe("blocked");
    expect(card.blockedBy).toEqual([]);
  });

  test("a depends-on target missing from every folder is treated as unsatisfied", () => {
    const columns = buildLedgerColumns([
      item({ slug: "orphaned", state: "idea", dependsOn: ["no-such-item"] }),
    ]);
    const [card] = columnOf(columns, "idea").cards;
    expect(card.blocked).toBe(true);
    expect(card.blockedReason).toBe("waiting on: no-such-item");
  });

  test("a depends-on target satisfied via the archive lookup (accepted) does not block", () => {
    const columns = buildLedgerColumns(
      [item({ slug: "free", state: "idea", dependsOn: ["done-long-ago"] })],
      [],
      [item({ slug: "done-long-ago", state: "accepted" })],
    );
    const [card] = columnOf(columns, "idea").cards;
    expect(card.blocked).toBe(false);
    expect(card.blockedReason).toBeUndefined();
  });

  test("archived items feed the dependency lookup but are never rendered themselves", () => {
    const columns = buildLedgerColumns(
      [],
      [],
      [item({ slug: "done-long-ago", state: "accepted" })],
    );
    expect(columns.flatMap((c) => c.cards)).toEqual([]);
  });

  test("next-actor owner (the post-rename vocabulary) also counts as the human's move", () => {
    const columns = buildLedgerColumns([
      item({ slug: "agent-new", state: "idea", nextActor: "agent", updated: "2026-08-05" }),
      item({ slug: "owner-old", state: "idea", nextActor: "owner", updated: "2026-07-01" }),
    ]);
    expect(columnOf(columns, "idea").cards.map((c) => c.slug)).toEqual([
      "owner-old",
      "agent-new",
    ]);
  });

  test("cards order owner's move first, then most recently updated", () => {
    const columns = buildLedgerColumns([
      item({ slug: "agent-new", state: "idea", nextActor: "agent", updated: "2026-08-05" }),
      item({ slug: "owner-old", state: "idea", nextActor: "owner", updated: "2026-07-01" }),
      item({ slug: "agent-old", state: "idea", nextActor: "agent", updated: "2026-07-15" }),
      item({ slug: "owner-new", state: "idea", nextActor: "owner", updated: "2026-08-02" }),
    ]);
    expect(columnOf(columns, "idea").cards.map((c) => c.slug)).toEqual([
      "owner-new",
      "owner-old",
      "agent-new",
      "agent-old",
    ]);
  });
});
