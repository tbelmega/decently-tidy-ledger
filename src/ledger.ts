// Derivation for the Ledger's column view: the state-to-column rule, per-column card
// ordering, and the blocked treatment that applies in every column. Pure domain logic,
// no IO; the /api/board composition lives in api.ts, the presentation in ledger.html.
import type { ItemFile } from "decently-coordinated-loops/tools/types.ts";
import { unsatisfiedDependsOn } from "./bucket.ts";
import { validateItem } from "decently-coordinated-loops/tools/validate.ts";

export interface LedgerCard extends ItemFile {
  /** state `blocked`, an unsatisfied depends-on, or an anomalous state. */
  blocked: boolean;
  /** Tooltip for the ⛔ marker: "waiting on: <slugs>", the validation message
   * for an anomalous state, or plain "blocked". Only set when `blocked`. */
  blockedReason?: string;
  /** The unsatisfied depends-on targets, as slugs. Structured alongside the
   * tooltip because the drawer lists them as its own facts row, and the view
   * cannot recompute them: archived targets satisfy a dependency but are not
   * in the payload's columns, so a client-side rule would call them missing. */
  blockedBy: string[];
}

export interface LedgerColumn {
  key: string;
  label: string;
  cards: LedgerCard[];
}

/** The six lifecycle columns, left to right. `dropped`
 * is archived and never rendered; anything non-canonical falls into In progress
 * with the blocked treatment rather than being dropped silently. */
export const LEDGER_COLUMNS: ReadonlyArray<{ key: string; label: string; states: string[] }> = [
  { key: "idea", label: "Idea", states: ["idea"] },
  { key: "spec-filed", label: "Spec filed", states: ["spec-filed"] },
  { key: "in-progress", label: "In progress", states: ["in-progress", "blocked"] },
  { key: "implemented", label: "Implemented", states: ["implemented"] },
  { key: "merged-tested", label: "Merged & tested", states: ["merged", "tested"] },
  { key: "delivered", label: "Delivered", states: ["delivered", "accepted"] },
];

const COLUMN_BY_STATE = new Map(
  LEDGER_COLUMNS.flatMap((col) => col.states.map((state) => [state, col.key] as const)),
);

/** Column for a state, or null for `dropped` (excluded from render and counts). */
export function columnKeyFor(state: string): string | null {
  if (state === "dropped") return null;
  return COLUMN_BY_STATE.get(state) ?? "in-progress";
}

/** The human's side of next-actor. An item carrying it needs the owner's move.
 * ledger.html mirrors this test client-side for its chips/filters/counts. */
export const OWNER_NEXT_ACTOR = "owner";

/** Within a column: owner's move first, then most recently updated first. */
export function ledgerCompare(a: ItemFile, b: ItemFile): number {
  const ra = a.nextActor === OWNER_NEXT_ACTOR ? 0 : 1;
  const rb = b.nextActor === OWNER_NEXT_ACTOR ? 0 : 1;
  if (ra !== rb) return ra - rb;
  return b.updated.localeCompare(a.updated);
}

function toCard(item: ItemFile, bySlug: Map<string, ItemFile>): LedgerCard {
  const unsatisfied = unsatisfiedDependsOn(item, bySlug);
  // Every closed-set violation, not just a non-canonical state. This used to key off
  // the state alone, which was survivable while the deleted bucketing pass flagged the
  // rest; with that gone, the ledger is the only place malformed metadata can surface,
  // so an item missing its next-actor has to be visible here or nowhere.
  const violations = validateItem(item);
  const blocked = item.state === "blocked" || unsatisfied.length > 0 || violations.length > 0;
  if (!blocked) return { ...item, blocked, blockedBy: unsatisfied };
  const reasons: string[] = [];
  if (unsatisfied.length) reasons.push(`waiting on: ${unsatisfied.join(", ")}`);
  reasons.push(...violations);
  return {
    ...item,
    blocked,
    blockedBy: unsatisfied,
    blockedReason: reasons.length ? reasons.join("; ") : "blocked",
  };
}

/** Flatten items/ + for-delivery/ into the six ordered columns. `archivedItems`
 * feeds the depends-on lookup only and is never rendered  -  an accepted target that
 * already moved to archive/ still satisfies its dependents, so it has to be in the
 * lookup map even though it has no column. */
export function buildLedgerColumns(
  items: ItemFile[],
  forDeliveryItems: ItemFile[] = [],
  archivedItems: ItemFile[] = [],
): LedgerColumn[] {
  const bySlug = new Map(
    [...items, ...forDeliveryItems, ...archivedItems].map((i) => [i.slug, i]),
  );
  const columns: LedgerColumn[] = LEDGER_COLUMNS.map((col) => ({
    key: col.key,
    label: col.label,
    cards: [],
  }));
  const byKey = new Map(columns.map((col) => [col.key, col]));
  for (const item of [...items, ...forDeliveryItems]) {
    const key = columnKeyFor(item.state);
    if (key === null) continue;
    const column = byKey.get(key);
    if (!column) throw new Error(`no configured Ledger column for ${key}`);
    column.cards.push(toCard(item, bySlug));
  }
  for (const col of columns) col.cards.sort(ledgerCompare);
  return columns;
}
