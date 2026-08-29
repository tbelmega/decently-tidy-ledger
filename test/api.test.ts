import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLedgerApiPayload,
  buildOutboxPayload,
  buildWorkersPayload,
  formatSnapshotDate,
} from "../src/api.ts";

const FIXTURES = join(import.meta.dir, "fixtures/items");
const FOR_DELIVERY_FIXTURES = join(import.meta.dir, "fixtures/for-delivery");
const ARCHIVE_FIXTURES = join(import.meta.dir, "fixtures/archive");
const OUTBOX_FIXTURE = join(import.meta.dir, "fixtures/OUTBOX.md");

describe("formatSnapshotDate", () => {
  test("formats a date as local YYYY-MM-DD, zero-padded", () => {
    // Given a date whose local calendar day is the 3rd of a single-digit month
    const date = new Date(2026, 6, 3, 14, 30); // 2026-07-03 local
    // Then it renders zero-padded, using the local day
    expect(formatSnapshotDate(date)).toBe("2026-07-03");
  });
});

describe("buildLedgerApiPayload", () => {
  const now = new Date(2026, 6, 10, 9, 0); // 2026-07-10 local
  const payload = buildLedgerApiPayload(FIXTURES, FOR_DELIVERY_FIXTURES, ARCHIVE_FIXTURES, now);

  test("carries the snapshot date the ledger derives relative labels against", () => {
    expect(payload.generated).toBe("2026-07-10");
  });

  test("serves the six lifecycle columns with for-delivery items folded in", () => {
    expect(payload.columns.map((c) => c.key)).toEqual([
      "idea",
      "spec-filed",
      "in-progress",
      "implemented",
      "merged-tested",
      "delivered",
    ]);
    const mergedTested = payload.columns.find((c) => c.key === "merged-tested");
    if (!mergedTested) throw new Error("merged and tested fixture column is missing");
    expect(mergedTested.cards.map((c) => c.slug)).toContain("alpha-tested");
  });

  test("resolves depends-on against the archive so satisfied targets don't block", () => {
    const cards = payload.columns.flatMap((c) => c.cards);
    const archivedDep = cards.find((c) => c.slug === "beta-in-progress");
    expect(archivedDep).toBeDefined();
    if (!archivedDep) throw new Error("synthetic dependent item is missing");
    expect(archivedDep.blocked).toBe(false);
  });

});

describe("synthetic Outbox fixture", () => {
  test("exposes one open and one answered entry through DCL's parser", () => {
    const payload = buildOutboxPayload(OUTBOX_FIXTURE, FIXTURES);
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries.filter((entry) => entry.answer === null)).toHaveLength(1);
    expect(payload.entries.filter((entry) => entry.answer !== null)).toHaveLength(1);
  });
});

describe("buildWorkersPayload", () => {
  const now = new Date("2026-08-10T12:00:00Z");
  const snapshot = join(import.meta.dir, "fixtures/fleet-presence.json");
  const payload = buildWorkersPayload(snapshot, now);

  test("refuses a snapshot whose unreconciled count is negative or fractional", () => {
    // The endpoint's whole contract is that it throws rather than return `source: "live"`
    // for anything it did not measure, so the rail can fall back to `not checked`. A count
    // that cannot exist means a broken writer, and must take that path too.
    for (const bad of [-1, 1.5]) {
      const broken = {
        schema: 1,
        sweptAt: "2026-08-10T11:30:00Z",
        sweptFrom: "dispatcher",
        hosts: [{ name: "worker-a", reachable: true, lastSeenAt: "2026-08-10T11:30:00Z", flags: [], projects: [], unreconciled: bad }],
      };
      const dir = mkdtempSync(join(tmpdir(), "fleet-endpoint-"));
      const path = join(dir, "fleet-presence.json");
      writeFileSync(path, JSON.stringify(broken));
      expect(() => buildWorkersPayload(path, now)).toThrow(/unreconciled/);
    }
  });

  test("records when the endpoint read the file, separately from when the sweep ran", () => {
    // the gap between the two is the only thing that makes a snapshot nobody is
    // rewriting visible  -  without it a stale fleet looks freshly loaded
    expect(payload.readAt).toBe("2026-08-10T12:00:00.000Z");
    expect(payload.sweptAt).toBe("2026-08-10T11:30:00Z");
    expect(payload.sweptFrom).toBe("dispatcher");
  });

  test("declares the presence as live, because something really did contact these machines", () => {
    expect(payload.source).toBe("snapshot");
  });

  test("serves the raw flags and timestamps so the view can re-derive on its own timer", () => {
    expect(payload.workers.length).toBeGreaterThan(0);
    for (const worker of payload.workers) {
      expect(typeof worker.reachable).toBe("boolean");
      expect(Array.isArray(worker.flags)).toBe(true);
    }
  });

  test("a missing snapshot throws rather than serving an empty fleet", () => {
    // the caller turns this into a 503 and the rail renders `not checked`; returning
    // `{workers: []}` here would read as "every machine is gone"
    expect(() => buildWorkersPayload("/nonexistent/fleet-presence.json", now)).toThrow();
  });
});
