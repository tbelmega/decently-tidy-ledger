// The fleet-presence snapshot, as read by the board.
//
// This file's shape is an interface across a repository boundary. A locally configured
// provider may write it, and this module is the only shipped code that knows its format.
//
// EVERYTHING HERE THROWS RATHER THAN DEGRADES. The caller's fallback is the rail's existing
// "not checked" state, which is honest; a parser that returned a partial or empty fleet
// would turn a broken writer into a board that confidently shows nobody home.
import { readFileSync } from "node:fs";

/** The only schema this reader understands. A snapshot claiming a newer one is refused
 * rather than read optimistically  -  the writer is in another repository and may ship
 * ahead of this clone. */
export const FLEET_SNAPSHOT_SCHEMA = 1;

/** One host as the sweep saw it. `flags` are verbatim from the provider's local policy;
 * what they mean to the rail is workers.ts's business, not this module's. */
export interface FleetHost {
  name: string;
  /** Whether the sweep reached it on the run that wrote this snapshot. */
  reachable: boolean;
  /** The last sweep in which this host WAS reachable. Absent when it never has been  -
   * absent, not epoch-zero, so "never seen" and "seen long ago" stay distinguishable. */
  lastSeenAt?: string;
  flags: string[];
  /** Project slugs (not repo basenames) with a clone present, so the rail's chips share
   * the board's own vocabulary. */
  projects: string[];
  /** Repos on this host that are dirty or hold unpushed commits. Carried because the
   * sweep already computes it; the rail does not lead with it. */
  unreconciled: number;
}

export interface FleetSnapshot {
  schema: number;
  /** When the sweep that wrote this ran, ISO 8601. Staleness is measured against this and
   * nothing else  -  no host here keeps a heartbeat. */
  sweptAt: string;
  /** The host that swept. Only the dispatcher writes. */
  sweptFrom: string;
  hosts: FleetHost[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absent is fine and means "the writer does not send this yet"; present-but-wrong is not,
 * and is never quietly filtered down to the members that happen to be strings. A half-typed
 * array is a broken writer, and this file's whole contract is that a broken writer produces
 * `not checked` rather than a plausible-looking fleet. */
function stringArray(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${what} must be an array of strings`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${what} must be an array of strings`);
    return entry;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The one timestamp shape this contract uses, and the exact shape the sweep emits
 * (`date -u +%Y-%m-%dT%H:%M:%SZ`). */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** What a fleet host may be called: the roster's display column, which is one whitespace-free
 * token. Deliberately narrow  -  anything outside it did not come from that roster. */
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A timestamp is only a timestamp if it can be read as one, and `Date.parse` is far too
 * generous to be that test on its own: it takes `"Mon, 10 Aug 2026 11:30:00 GMT"`, and it
 * silently NORMALISES an impossible calendar date  -  `2026-02-30T00:00:00Z` becomes March 2nd
 * rather than failing. Both would sail through to the page as a measured sweep time.
 *
 * So the grammar is checked first, and then the value is round-tripped: a date that does not
 * come back as the string that produced it was not the date it claimed to be. Insisting on
 * one syntax also keeps the server and the browser agreeing, since the rail re-derives every
 * age client-side from the same strings. */
function timestamp(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${what} is missing`);
  }
  if (!ISO_INSTANT.test(value)) {
    throw new Error(`${what} is not a UTC instant like 2026-08-13T04:22:02Z: ${JSON.stringify(value)}`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace(".000Z", "Z") !== value) {
    throw new Error(`${what} is not a real date: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Pure: validate one snapshot's text. Throws with a message naming what was wrong, because
 * that message is what the rail shows the operator when the read fails. */
export function parseFleetSnapshot(text: string): FleetSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`not valid JSON (${errorMessage(err)})`);
  }
  if (!isRecord(raw)) throw new Error("expected a JSON object at the top level");

  if (raw.schema !== FLEET_SNAPSHOT_SCHEMA) {
    throw new Error(`unknown snapshot schema ${String(raw.schema)}, expected ${FLEET_SNAPSHOT_SCHEMA}`);
  }
  // Not merely present: READABLE. Staleness is measured against this and nothing else, and
  // an unparseable value would leave the rail showing a ready count under a header that
  // renders the raw string as if it were an age.
  const sweptAt = timestamp(raw.sweptAt, "sweptAt");
  // Required, but deliberately NOT checked against a host name. Which machine is the
  // Which machine is the dispatcher is the provider's business. Hard-coding one here
  // would put a local deployment fact into this generic reader. This field exists so the
  // rail can say where a reading came from, not so the Ledger can police it.
  if (typeof raw.sweptFrom !== "string" || raw.sweptFrom.length === 0) {
    throw new Error("sweptFrom is missing  -  a snapshot must say which host produced it");
  }
  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) {
    // An empty array is what a sweep with an unreadable roster would produce, and rendering
    // it would read as "every machine is gone" rather than "the sweep did not work".
    throw new Error("hosts is missing or empty  -  a fleet of nobody is a broken sweep, not a fact");
  }

  const hosts = raw.hosts.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`hosts[${index}] is not an object`);
    // A hostname, not merely a non-empty string. The sweep takes these from the roster's
    // whitespace-delimited display column, so it cannot produce `" worker-a "` or `"a b"`  -  and a
    // name that has picked up padding somewhere is a SECOND row for a machine that already
    // has one, which the rail counts as capacity that does not exist. Rejecting the shape
    // closes that off at the boundary instead of chasing each variant.
    if (typeof entry.name !== "string" || !HOSTNAME.test(entry.name)) {
      throw new Error(`hosts[${index}] has no usable name: ${JSON.stringify(entry.name)}`);
    }
    if (typeof entry.reachable !== "boolean") {
      throw new Error(`host ${entry.name} has no reachable flag`);
    }
    // A count of repositories, so the contract is a non-negative integer, not merely a
    // finite number. Finiteness alone admitted -1 and 1.5, which the endpoint then served
    // as `source: "live"`: a broken writer rendered as measured fleet data rather than as
    // `not checked`. Absent stays fine and defaults to 0 below; present-but-impossible is
    // the writer being wrong, and gets the same answer as a string would.
    //
    // `isSafeInteger` rather than `isInteger`, because the guard runs on the value JSON.parse
    // already rounded: 9007199254740993 arrives as ...992 and a fraction written as
    // 4500000000000000.1 arrives as an integer. Both are past the point where a repository
    // count means anything, and neither should read as measured.
    if (entry.unreconciled !== undefined
        && (typeof entry.unreconciled !== "number"
            || !Number.isSafeInteger(entry.unreconciled)
            || entry.unreconciled < 0)) {
      throw new Error(
        `host ${entry.name} has an unreconciled count that is not a non-negative integer`,
      );
    }
    const host: FleetHost = {
      name: entry.name,
      reachable: entry.reachable,
      flags: stringArray(entry.flags, `host ${entry.name} flags`),
      projects: stringArray(entry.projects, `host ${entry.name} projects`),
      unreconciled: typeof entry.unreconciled === "number" ? entry.unreconciled : 0,
    };
    // Assigned only when present, so `lastSeenAt` stays absent rather than becoming an
    // own-property holding undefined  -  the JSON round-trip must keep the two apart. Present
    // and unreadable is a different thing from absent, and is rejected: the writer carries
    // this value forward across sweeps, so one bad one would persist indefinitely.
    //
    // `null` counts as PRESENT and is therefore rejected too. It is tempting to read it as
    // "no value" and carry on, but the writer strips
    // nulls before it ever writes (`with_entries(select(.value != null))`), so a null here
    // means something other than that writer produced this file  -  which is precisely when
    // guessing is the wrong move. Omit the key.
    if (entry.lastSeenAt !== undefined) {
      host.lastSeenAt = timestamp(entry.lastSeenAt, `host ${entry.name} lastSeenAt`);
    }
    // A host the sweep REACHED was, by definition, seen. Omission is meaningful only for a
    // host it could not reach and has no older sighting of; on a reachable one it is a
    // contradiction, and would render as a green "never seen" row  -  a machine reported both
    // ready and never contacted. Note this constrains PRESENCE only, not the value: an
    // overlapping sweep may legitimately have preserved a newer sighting than this one.
    if (host.reachable && host.lastSeenAt === undefined) {
      throw new Error(`host ${entry.name} was reached but has no lastSeenAt`);
    }
    return host;
  });

  // The rail counts ready hosts, so a name appearing twice is capacity that does not exist  -
  // two `worker-a` rows read as two machines an operator could send work to. The roster is one
  // line per host, so a duplicate means it was edited wrong or the snapshot was assembled
  // wrong; either way it is not a fleet.
  // Case-folded, because `worker-a` and `WORKER-A` are one machine everywhere else in this system:
  // the roster is lowercase, DNS is case-insensitive, and the rail would otherwise offer two
  // dispatch targets for one host.
  const names = new Set<string>();
  for (const host of hosts) {
    const key = host.name.toLowerCase();
    if (names.has(key)) throw new Error(`host ${host.name} appears more than once`);
    names.add(key);
  }

  return { schema: raw.schema, sweptAt, sweptFrom: raw.sweptFrom, hosts };
}

/** Read and validate. Throws when the file is missing, unreadable or malformed  -  all three
 * mean the same thing to the caller: nothing is known about the fleet right now. */
export function readFleetSnapshot(path: string): FleetSnapshot {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read ${path}: ${errorMessage(err)}`);
  }
  try {
    return parseFleetSnapshot(text);
  } catch (err) {
    throw new Error(`${path}: ${errorMessage(err)}`);
  }
}
