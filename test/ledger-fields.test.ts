// ledger.html reads its data off the /api/board card objects and the /api/item detail
// object. Nothing type-checks that HTML against those shapes, so a field rename in the
// data layer leaves the UI reading `undefined` and silently rendering nothing.
//
// That is not hypothetical: the 2026-08-12 DCL adoption renamed ItemFile.owner to
// .assignee and the drawer was updated while the card badge was not, so every assigned
// card lost its badge. This test is the guard for that whole class - it
// asserts every field the UI reads is one the pipeline actually produces.
//
// The corpus is test/fixtures, never a live board. Deriving the
// contract from live data made the test a function of whatever the board happens to
// hold: a board with no blocked cards yields no `blockedReason`, an empty items/ has no
// cards at all, and either would fail this test against a UI that handles both fine.
// The fixture set is checked in, so it covers the optional fields deliberately - which
// is why the synthetic items carry `fit:`, a field the UI reads and no
// upstream DCL fixture exercises.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadItemsDir,
  loadArchiveDir,
  loadForDeliveryDir,
} from "decently-coordinated-loops/tools/parse.ts";
import { buildLedgerColumns } from "../src/ledger.ts";
import { buildItemDetail } from "../src/item-detail.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const LEDGER = readFileSync(join(import.meta.dir, "..", "public", "ledger.html"), "utf8");

/** `card` names a DOM element as well as a payload object in ledger.html - the click
 * handler does `const card = e.target.closest(".card")`. DOM reads off that binding are
 * not payload fields; anything genuinely on Element belongs here. */
const DOM_PROPS = new Set(["dataset"]);

/** Every property name the UI reads off `<base>`, e.g. `card.assignee`. Property
 * access only - `card["x"]` and destructuring are not used in ledger.html. */
function fieldsReadFrom(base: string): Set<string> {
  const names = new Set<string>();
  for (const m of LEDGER.matchAll(new RegExp(`\\b${base}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))) {
    if (!DOM_PROPS.has(m[1])) names.add(m[1]);
  }
  return names;
}

function unionOfKeys(objects: object[]): Set<string> {
  const keys = new Set<string>();
  for (const o of objects) for (const k of Object.keys(o)) keys.add(k);
  return keys;
}

const items = loadItemsDir(join(FIXTURES, "items"));
const forDelivery = loadForDeliveryDir(join(FIXTURES, "for-delivery"));
const archived = loadArchiveDir(join(FIXTURES, "archive"));

describe("ledger.html reads only fields the pipeline serves", () => {
  test("every card.<field> is present on a card the pipeline builds", () => {
    const cards = buildLedgerColumns(items, forDelivery, archived).flatMap((c) => c.cards);
    // The fixture set must keep exercising the optional fields, or this guard silently
    // narrows to whatever happens to be covered.
    const served = unionOfKeys(cards);
    for (const optional of ["blockedReason", "fit", "awaiting"]) {
      expect({ optional, coveredByFixtures: served.has(optional) })
        .toEqual({ optional, coveredByFixtures: true });
    }
    const unknown = [...fieldsReadFrom("card")].filter((f) => !served.has(f));
    expect(unknown).toEqual([]);
  });

  test("every detail.<field> is present on a detail the pipeline builds", () => {
    const details = items.map((i) =>
      buildItemDetail(i.path, readFileSync(join(FIXTURES, i.path.replace(/^items\//, "items/")), "utf8")),
    );
    const served = unionOfKeys(details);
    const unknown = [...fieldsReadFrom("detail")].filter((f) => !served.has(f));
    expect(unknown).toEqual([]);
  });

  test("the assignee badge reads the field the parser actually populates", () => {
    // The specific regression, pinned: .owner is gone from the data layer, so a
    // read of it here renders nothing for every assigned card.
    expect(LEDGER).not.toContain("card.owner");
    expect(LEDGER).not.toContain("detail.owner");
    expect(LEDGER).toContain("card.assignee");
  });
});

describe("payload shapes the contract test must not depend on", () => {
  test("an empty board still builds every column", () => {
    const columns = buildLedgerColumns([], [], []);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.flatMap((c) => c.cards)).toEqual([]);
  });

  test("an all-unblocked board omits blockedReason, which is valid", () => {
    const unblocked = items.filter((i) => i.state === "implemented" && i.dependsOn.length === 0);
    const cards = buildLedgerColumns(unblocked, [], []).flatMap((c) => c.cards);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => !c.blocked)).toBe(true);
    expect(cards.every((c) => c.blockedReason === undefined)).toBe(true);
  });
});
