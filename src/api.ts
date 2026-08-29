import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  loadArchiveDir,
  loadForDeliveryDir,
  loadItemsDir,
} from "decently-coordinated-loops/tools/parse.ts";
import { buildLedgerColumns, type LedgerColumn } from "./ledger.ts";
import { renderMarkdown, type KnownItems } from "./markdown.ts";
import {
  applyAnswer,
  parseOutbox,
  replaceResolvedIfUnchanged,
  resolvedOutboxIdentity,
  UnsupportedOutboxError,
  withOutboxLock,
  type OutboxAnomaly,
  type OutboxEntry,
  type OutboxPayload,
} from "decently-coordinated-loops/tools/outbox.ts";
import { readFleetSnapshot } from "./fleet-snapshot.ts";
import type { WorkersPayload } from "./presence.ts";
import type { Worker } from "./workers.ts";

export interface LedgerPayload {
  /** Snapshot date the view derives relative "Nd ago" labels against (YYYY-MM-DD). */
  generated: string;
  priorityProjects: string[];
  columns: LedgerColumn[];
}

/** Format a Date as YYYY-MM-DD using its local calendar day (not UTC), so the
 * snapshot date matches the wall-clock day the board was read. */
export function formatSnapshotDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Reads and parses items/*.md, for-delivery/*.md, and archive/*.md fresh on every
 * call  -  the single mechanism behind both "generate on startup" and the view's refresh
 * button. for-delivery/ becomes its own column and, with archive/, feeds depends-on
 * resolution against merged/verified/terminal targets. The column/blocked/order
 * derivation stays in ledger.ts; this only adds the snapshot date the view needs for
 * relative-date labels. */
export function buildLedgerApiPayload(
  itemsDir: string,
  forDeliveryDir: string,
  archiveDir: string,
  now: Date = new Date(),
  priorityProjects: string[] = [],
): LedgerPayload {
  const items = loadItemsDir(itemsDir);
  const forDelivery = loadForDeliveryDir(forDeliveryDir);
  const archived = loadArchiveDir(archiveDir);
  return {
    generated: formatSnapshotDate(now),
    priorityProjects,
    columns: buildLedgerColumns(items, forDelivery, archived),
  };
}

/** Fleet presence for the ledger sidebar's Workers section. Deliberately unrelated
 * to the board items  -  it shares only the project vocabulary, and is served from its
 * own endpoint so the two can move independently. Raw flags and timestamps go over the
 * wire so the view can re-derive readiness and staleness on a timer without refetching.
 *
 * THROWS when the snapshot is missing or malformed, and that is the whole contract: the
 * caller turns it into an error response, the rail renders its existing `not checked`
 * state, and nobody is shown a fleet that was not measured. Re-reads the file on every
 * call, like the board and outbox endpoints  -  the sweep rewrites it behind our back. */
export function buildWorkersPayload(
  snapshotPath: string,
  now: Date = new Date(),
): WorkersPayload {
  const snapshot = readFleetSnapshot(snapshotPath);
  return {
    readAt: now.toISOString(),
    sweptAt: snapshot.sweptAt,
    sweptFrom: snapshot.sweptFrom,
    source: "snapshot",
    workers: snapshot.hosts,
  };
}

/** An entry with its body rendered. The parser stays pure over strings; rendering is
 * composition, and it is the one place that needs the item payload. */
export interface OutboxApiEntry extends OutboxEntry {
  /** Server-rendered and sanitized. Rendering happens here, not in the browser: this
   * page carries a write endpoint, and agent-authored text pasted from elsewhere must
   * not become an injection surface. */
  bodyHtml: string;
}

export interface OutboxApiPayload {
  readAt: string;
  entries: OutboxApiEntry[];
  anomalies: OutboxAnomaly[];
}

/** Re-read and re-parse OUTBOX.md on every call, same contract as the board and worker
 * payloads  -  agents rewrite that file constantly, including during unattended dispatch,
 * so a cached outbox is a lying outbox.
 *
 * The items directory is read for two reasons: `[[wikilink]]` resolution, and the
 * lowest-confidence item-slug tier, which only accepts a backticked slug that names a
 * real item. */
/** Every slug the board knows, across all three state folders. Entries outlive the
 * items they reference  -  an accepted item moves to archive/ and a verified one to
 * for-delivery/  -  so resolving against items/ alone would drop the wikilink and the
 * item button exactly when the entry is oldest. Sibling folders are
 * derived from itemsDir so callers keep passing one path. */
function knownSlugsFor(itemsDir: string): Map<string, string> {
  const root = join(itemsDir, "..");
  return new Map([
    ...loadItemsDir(itemsDir),
    ...loadForDeliveryDir(join(root, "for-delivery")),
    ...loadArchiveDir(join(root, "archive")),
  ].map((item) => [item.slug, item.path] as const));
}

/** Attach the rendered HTML to a parsed payload. Split out so the write path can
 * render a payload it already parsed instead of re-reading the file. */
function toApiPayload(parsed: OutboxPayload, knownSlugs: KnownItems): OutboxApiPayload {
  return {
    readAt: parsed.readAt,
    anomalies: parsed.anomalies,
    entries: parsed.entries.map((entry) => ({
      ...entry,
      bodyHtml: renderMarkdown(entry.body, knownSlugs),
    })),
  };
}

export function buildOutboxPayload(
  outboxPath: string,
  itemsDir: string,
  now: Date = new Date(),
): OutboxApiPayload {
  const knownSlugs = knownSlugsFor(itemsDir);
  return toApiPayload(parseOutbox(readFileSync(outboxPath, "utf8"), knownSlugs, now), knownSlugs);
}

export type OutboxWriteResult =
  | { ok: true; payload: OutboxApiPayload }
  | { ok: false; status: 400; message: string }
  /** The file moved under us. The fresh payload goes back so the client can show what
   * changed WITHOUT discarding the draft the operator just typed. */
  | { ok: false; status: 409; message: string; payload?: OutboxApiPayload };

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Write one answer to OUTBOX.md, guarded against a concurrent rewrite.
 *
 * The guard is not theoretical: agents rewrite this file constantly, including during
 * unattended dispatch, including while an operator is composing an answer
 * by other sessions mid-life. `entryHash` is the entry's state when the payload was
 * served; if it no longer matches, somebody else got there first.
 *
 * The write goes to a temp file in the same directory and is then renamed over the
 * target, so a crash mid-write cannot leave OUTBOX.md truncated. Same-directory matters:
 * rename is only atomic within a filesystem. */
export function writeOutboxAnswer(
  outboxPath: string,
  itemsDir: string,
  id: number,
  text: string,
  entryHash: string,
  now: Date = new Date(),
  resolvePath: (path: string) => string = realpathSync,
  replaceResolved: typeof replaceResolvedIfUnchanged = replaceResolvedIfUnchanged,
): OutboxWriteResult {
  if (!text.trim()) {
    return { ok: false, status: 400, message: "an answer cannot be blank" };
  }

  // Every OUTBOX.md writer takes this lock, including `bun run board`'s orphan-row
  // append  -  a lock only one writer respects serializes nothing.
  let targetPath: string;
  try {
    targetPath = resolvePath(outboxPath);
  } catch {
    return {
      ok: false,
      status: 409,
      message: "OUTBOX.md became unavailable before this answer could be written; nothing was written; try again",
    };
  }
  let result: OutboxWriteResult | null;
  try {
    result = withOutboxLock(targetPath, (): OutboxWriteResult => {
    const expectedIdentity = resolvedOutboxIdentity(targetPath);
    // ONE read. Everything below verifies and transforms this exact snapshot, and the
    // rename replaces the file it came from.
    const snapshot = readFileSync(targetPath, "utf8");
    const knownSlugs = knownSlugsFor(itemsDir);
    const parsed = parseOutbox(snapshot, knownSlugs, now);
    const conflictPayload = (): OutboxApiPayload => {
      try {
        return buildOutboxPayload(outboxPath, itemsDir, now);
      } catch {
        return toApiPayload(parsed, knownSlugs);
      }
    };

    const matches = parsed.entries.filter((candidate) => candidate.id === id);
    if (matches.length === 0) {
      // 400, not 404: the documented contract is "unknown id, or an id not under
      // `## Open`"  -  both are bad requests against a payload the client already has
      return { ok: false, status: 400, message: `no entry ${id} under \`## Open\`` };
    }
    if (matches.length > 1) {
      // Duplicate ids survive as anomalies rather than being dropped, so an id is not a
      // unique address. Refusing is the honest answer: writing would silently answer an
      // entry nobody chose.
      return {
        ok: false,
        status: 409,
        message: `id ${id} appears ${matches.length} times in OUTBOX.md  -  fix the duplicate before answering`,
        payload: toApiPayload(parsed, knownSlugs),
      };
    }
    if (!matches[0].answerable) {
      // applyAnswer rewrites a `> A:` line; it does not invent one. Without this the
      // throw escaped as a 500.
      return {
        ok: false,
        status: 400,
        message: `entry ${id} has no \`> A:\` line to write to  -  add one in OUTBOX.md`,
      };
    }
    if (matches[0].entryHash !== entryHash) {
      return {
        ok: false,
        status: 409,
        message: `entry ${id} changed since it was loaded  -  another session rewrote OUTBOX.md`,
        payload: toApiPayload(parsed, knownSlugs),
      };
    }

    const next = applyAnswer(snapshot, id, text);

    let currentTarget: string;
    try {
      currentTarget = resolvePath(outboxPath);
    } catch {
      return {
        ok: false,
        status: 409,
        message: "OUTBOX.md became unavailable while this answer was being written; nothing was written; try again",
        payload: toApiPayload(parsed, knownSlugs),
      };
    }
    if (currentTarget !== targetPath) {
      return {
        ok: false,
        status: 409,
        message: "OUTBOX.md changed targets while this answer was being written; nothing was written; try again",
        payload: conflictPayload(),
      };
    }

    // This is a final comparison, not an atomic compare-and-swap. It detects every edit
    // that lands before the comparison, but a plain file cannot be conditionally replaced
    // against an editor that ignores DCL's lock. The HTTP route therefore calls this only
    // in an explicit exclusive session, where the operator has stopped those other writers.
    let replaced: boolean;
    try {
      replaced = replaceResolved(targetPath, snapshot, next, expectedIdentity);
    } catch (error) {
      if (isMissingFile(error)) {
        return {
          ok: false,
          status: 409,
          message: "OUTBOX.md became unavailable while this answer was being written; nothing was written; try again",
          payload: toApiPayload(parsed, knownSlugs),
        };
      }
      if (error instanceof UnsupportedOutboxError) {
        return {
          ok: false,
          status: 409,
          message: error.message,
          payload: conflictPayload(),
        };
      }
      throw error;
    }
    if (!replaced) {
      return {
        ok: false,
        status: 409,
        message: "OUTBOX.md changed while this answer was being written  -  nothing was written; try again",
        payload: conflictPayload(),
      };
    }

    return { ok: true, payload: toApiPayload(parseOutbox(next, knownSlugs, now), knownSlugs) };
    });
  } catch (error) {
    if (!isMissingFile(error) && !(error instanceof UnsupportedOutboxError)) throw error;
    return {
      ok: false,
      status: 409,
      message:
        error instanceof UnsupportedOutboxError
          ? error.message
          : "OUTBOX.md became unavailable before this answer could be written; nothing was written; try again",
    };
  }

  if (result) return result;
  let payload: OutboxApiPayload | undefined;
  try {
    payload = buildOutboxPayload(outboxPath, itemsDir, now);
  } catch {
    payload = undefined;
  }
  return {
    ok: false,
    status: 409,
    message: "another writer holds OUTBOX.md  -  nothing was written; try again",
    ...(payload ? { payload } : {}),
  };
}
