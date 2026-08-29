// Fleet presence for the Ledger sidebar's Workers rail.
//
// The rail answers ONE question: which host could take a session now. Not who is up, not
// where work is stranded  -  dispatch readiness. That question needs two
// independent facts, and the whole shape here follows from them: reachability, which a
// sweep proves, and local policy, which the provider supplies as flags.
//
// Deliberately unrelated to board items  -  it shares only the project vocabulary. Pure domain
// logic, no IO; the snapshot reader is fleet-snapshot.ts and the /api/workers composition is
// api.ts. ledger.html mirrors the derivations below client-side, because the relative labels
// must keep ticking on a timer without a refetch.
import type { FleetHost } from "./fleet-snapshot.ts";

/** One worker computer, exactly as the snapshot describes it. The rail derives everything
 * it shows; nothing is precomputed server-side, so the client can re-derive on a timer. */
export type Worker = FleetHost;

/** What the status dot shows: filled green, filled amber, or hollow.
 *
 * `unreachable` is hollow and outranks every flag, so hollow-vs-filled stays the primary
 * reachability signal and survives greyscale  -  the same rule the rail shipped with. */
export type WorkerReadiness = "ready" | "held" | "unreachable";

/** Beyond this, the whole rail dims and the header says so.
 *
 * Staleness is a property of the SNAPSHOT, not of a host: a provider is not required to
 * keep a heartbeat, and a sweep may fire at session boundaries rather than on a timer, so a
 * per-host freshness budget would be fiction. Six hours is roughly "no session has started
 * since this morning". */
export const FLEET_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** How far ahead of this machine a sweep may legitimately claim to have run.
 *
 * Hosts disagree about the time by seconds, so a small lead is ordinary and must not be
 * reported as a fault. A large one is not skew, it is a wrong clock on the writing host  -
 * and clamping it to "just now" would make a months-old fleet look freshly swept and hold
 * the six-hour rule open until real time caught up. */
export const FLEET_CLOCK_SKEW_MS = 5 * 60 * 1000;

function hasFlag(worker: Worker, flag: string): boolean {
  return worker.flags.includes(flag);
}

/** Green requires all three: the sweep reached it, the owner cleared it, and the toolchain is
 * there. `no-dispatch` is separate from the other two on purpose: a host can be fully
 * provisioned and cleared and still be deliberately excluded from dispatch. */
export function workerReadiness(worker: Worker): WorkerReadiness {
  if (!worker.reachable) return "unreachable";
  if (!hasFlag(worker, "cleared")) return "held";
  if (!hasFlag(worker, "capable")) return "held";
  if (hasFlag(worker, "no-dispatch")) return "held";
  return "ready";
}

/** The row's tooltip. States which condition is missing rather than only that one is  -
 * "held" alone would send an operator to the roster to find out why. */
export function workerReadinessReason(worker: Worker): string {
  if (!worker.reachable) return "not reachable at the last sweep";
  const held: string[] = [];
  if (!hasFlag(worker, "cleared")) held.push("not cleared for worker duty");
  if (!hasFlag(worker, "capable")) held.push("toolchain not installed");
  if (hasFlag(worker, "no-dispatch")) held.push("deliberately not a dispatch target");
  if (held.length === 0) return "reachable, cleared and capable  -  could take a session";
  return `reachable; ${held.join("; ")}`;
}

/** The header summary's number. Counts readiness, not reachability: "N online" implied a
 * liveness this data has never had, and an operator acts on the count. */
export function readyCount(workers: Worker[]): number {
  return workers.filter((worker) => workerReadiness(worker) === "ready").length;
}

/** Milliseconds since `iso`, signed, or null when it can't be read. Negative means the
 * timestamp is ahead of this machine. */
function ageMs(iso: string, now: Date): number | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return now.getTime() - at;
}

/** Whether the whole picture is old enough to distrust.
 *
 * Three ways to be stale, and the last two are both "this reading cannot be placed in time":
 * older than the window, unreadable, or dated further ahead than clock skew explains. */
export function fleetIsStale(sweptAt: string, now: Date): boolean {
  const age = ageMs(sweptAt, now);
  if (age === null) return true;
  if (age < -FLEET_CLOCK_SKEW_MS) return true;
  return age > FLEET_STALE_AFTER_MS;
}

/** `just now` (<1m) · `Nm ago` (<60m) · `Nh ago` (<48h) · `Nd ago` beyond.
 *
 * Falls back to the raw value when the timestamp can't be read, so a bad source value stays
 * visible instead of being rendered as a plausible age; an absent one reads as never seen,
 * which is the honest label for a host the sweep has never reached. */
export function relativeAgeLabel(iso: string | undefined, now: Date): string {
  if (!iso) return "never seen";
  const signed = ageMs(iso, now);
  if (signed === null) return iso;
  // Clamped for DISPLAY only: a reading a few seconds ahead is skew and reads as "just now".
  // A materially future one still reads that way, which is why `fleetIsStale` judges it
  // separately and the header says "stale" beside it  -  the label is not the safety rule.
  const age = Math.max(0, signed);
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
