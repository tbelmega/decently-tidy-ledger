import { describe, expect, test } from "bun:test";
import {
  FLEET_STALE_AFTER_MS,
  fleetIsStale,
  readyCount,
  relativeAgeLabel,
  workerReadiness,
  workerReadinessReason,
  type Worker,
} from "../src/workers.ts";
import { buildPresenceFixture } from "./test-presence.ts";

const NOW = new Date("2026-08-13T12:00:00Z");

function worker(overrides: Partial<Worker> & { name: string }): Worker {
  return {
    reachable: true,
    flags: ["cleared", "capable"],
    projects: [],
    unreconciled: 0,
    ...overrides,
  };
}

/** `minutes` before NOW, as an ISO 8601 string. */
function agoIso(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

describe("workerReadiness", () => {
  test("reachable, cleared and capable is the only way to be ready", () => {
    expect(workerReadiness(worker({ name: "worker-a" }))).toBe("ready");
  });

  test("not reachable at the last sweep outranks every flag", () => {
    // hollow-vs-filled is the primary reachability signal and must survive greyscale, so
    // an unreachable host is never coloured by its clearance
    const w = worker({ name: "worker-c", reachable: false, flags: ["cleared", "capable"] });
    expect(workerReadiness(w)).toBe("unreachable");
  });

  test("capable but not cleared is held, because clearance is owner's judgement", () => {
    expect(workerReadiness(worker({ name: "someone", flags: ["capable"] }))).toBe("held");
  });

  // Named synthetically rather than after a real host: the branch under test is the flag
  // combination, and a name borrowed from a live machine turns into a false claim about it
  // the moment that machine is provisioned.
  test("cleared but not capable is held  -  the toolchain gap", () => {
    expect(workerReadiness(worker({ name: "example-unprovisioned", flags: ["cleared"] }))).toBe("held");
  });

  test("no-dispatch holds a host that is otherwise fully ready", () => {
    const w = worker({ name: "worker-b", flags: ["cleared", "capable", "no-dispatch"] });
    expect(workerReadiness(w)).toBe("held");
  });

  test("a flag the board does not know about changes nothing", () => {
    // `partial` is the sweep's own concern; the rail must not start holding hosts back
    // because the roster grew a flag for some unrelated purpose
    const w = worker({ name: "worker-d", flags: ["cleared", "capable", "partial"] });
    expect(workerReadiness(w)).toBe("ready");
  });
});

describe("workerReadinessReason", () => {
  test("says which of the three conditions is missing, not merely that one is", () => {
    const reason = workerReadinessReason(worker({ name: "example-unprovisioned", flags: ["cleared"] }));
    expect(reason).toContain("toolchain");
    expect(reason).not.toContain("not cleared");
  });

  test("names every missing condition when more than one is", () => {
    const reason = workerReadinessReason(worker({ name: "bare", flags: [] }));
    expect(reason).toContain("not cleared");
    expect(reason).toContain("toolchain");
  });

  test("an unreachable host's reason is its unreachability, not its flags", () => {
    const reason = workerReadinessReason(worker({ name: "worker-c", reachable: false, flags: [] }));
    expect(reason).toContain("not reachable");
    expect(reason).not.toContain("toolchain");
  });

  test("a ready host says so plainly", () => {
    expect(workerReadinessReason(worker({ name: "worker-a" }))).toContain("could take a session");
  });
});

describe("readyCount", () => {
  test("counts only ready hosts  -  the header says N ready, never N online", () => {
    const workers = [
      worker({ name: "worker-a" }),
      worker({ name: "worker-b", flags: ["cleared", "capable", "no-dispatch"] }),
      worker({ name: "worker-c", reachable: false }),
    ];
    expect(readyCount(workers)).toBe(1);
  });

  test("an empty list has none ready", () => {
    expect(readyCount([])).toBe(0);
  });
});

describe("fleetIsStale", () => {
  test("a snapshot inside the window is current", () => {
    expect(fleetIsStale(agoIso(60), NOW)).toBe(false);
  });

  test("the boundary itself is still current  -  stale means strictly older", () => {
    const atThreshold = new Date(NOW.getTime() - FLEET_STALE_AFTER_MS).toISOString();
    expect(fleetIsStale(atThreshold, NOW)).toBe(false);
  });

  test("past six hours the whole picture is stale", () => {
    // roughly "you have not started a session since this morning", which is the real
    // signal that the sweep's answer is old  -  staleness is a property of the SNAPSHOT,
    // not of a host, because nothing here keeps a heartbeat
    expect(fleetIsStale(agoIso(6 * 60 + 1), NOW)).toBe(true);
  });

  test("an unreadable sweptAt is stale rather than fresh", () => {
    expect(fleetIsStale("whenever", NOW)).toBe(true);
  });

  test("a sweptAt a little ahead is ordinary clock skew, not staleness", () => {
    expect(fleetIsStale(agoIso(-2), NOW)).toBe(false);
  });

  test("a sweptAt further ahead than skew explains is stale", () => {
    // this test previously asserted the opposite for ANY future timestamp, which meant a
    // writer whose clock was years out made a months-old fleet read as freshly swept and
    // held the six-hour rule open until real time caught up
    expect(fleetIsStale(agoIso(-6), NOW)).toBe(true);
    expect(fleetIsStale("2050-01-01T00:00:00Z", NOW)).toBe(true);
  });
});

describe("relativeAgeLabel", () => {
  test("under a minute reads as just now", () => {
    expect(relativeAgeLabel(agoIso(0.5), NOW)).toBe("just now");
  });

  test("minutes, then hours, then days", () => {
    expect(relativeAgeLabel(agoIso(59), NOW)).toBe("59m ago");
    expect(relativeAgeLabel(agoIso(60), NOW)).toBe("1h ago");
    expect(relativeAgeLabel(agoIso(47 * 60), NOW)).toBe("47h ago");
    expect(relativeAgeLabel(agoIso(48 * 60), NOW)).toBe("2d ago");
  });

  test("a future timestamp reads as just now rather than a negative age", () => {
    expect(relativeAgeLabel(agoIso(-5), NOW)).toBe("just now");
  });

  test("an unparseable timestamp falls back to the raw value", () => {
    expect(relativeAgeLabel("whenever", NOW)).toBe("whenever");
  });

  test("an absent timestamp reads as never seen", () => {
    // a host the sweep has never reached carries no lastSeenAt at all
    expect(relativeAgeLabel(undefined, NOW)).toBe("never seen");
  });
});

describe("buildPresenceFixture", () => {
  test("exercises every readiness branch, which is what the UI suite needs of it", () => {
    const readiness = new Set(buildPresenceFixture(NOW).map((w) => workerReadiness(w)));
    expect(readiness).toEqual(new Set(["ready", "held", "unreachable"]));
  });

  test("every host satisfies the snapshot's host contract", () => {
    for (const w of buildPresenceFixture(NOW)) {
      expect(w.name).toBe(w.name.toLowerCase());
      expect(typeof w.reachable).toBe("boolean");
      expect(Array.isArray(w.flags)).toBe(true);
      expect(Array.isArray(w.projects)).toBe(true);
      expect(Number.isInteger(w.unreconciled)).toBe(true);
    }
  });

  test("at least one host has nothing checked out, so that empty state renders", () => {
    expect(buildPresenceFixture(NOW).some((w) => w.projects.length === 0)).toBe(true);
  });
});
