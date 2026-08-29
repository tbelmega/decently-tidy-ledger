import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFleetSnapshot, readFleetSnapshot } from "../src/fleet-snapshot.ts";

const VALID = {
  schema: 1,
  sweptAt: "2026-08-13T04:13:16Z",
  sweptFrom: "worker-a",
  hosts: [
    {
      name: "worker-a",
      reachable: true,
      lastSeenAt: "2026-08-13T04:13:16Z",
      flags: ["cleared", "capable"],
      projects: ["example-data", "dcl"],
      unreconciled: 1,
    },
    { name: "worker-c", reachable: false, flags: ["cleared", "capable", "no-dispatch"], projects: [], unreconciled: 0 },
  ],
};

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "fleet-snapshot-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("parseFleetSnapshot", () => {
  test("accepts what the sweep writes", () => {
    const snapshot = parseFleetSnapshot(JSON.stringify(VALID));
    expect(snapshot.sweptFrom).toBe("worker-a");
    expect(snapshot.hosts).toHaveLength(2);
    expect(snapshot.hosts[0]?.flags).toEqual(["cleared", "capable"]);
    expect(snapshot.hosts[0]?.projects).toEqual(["example-data", "dcl"]);
  });

  test("an absent lastSeenAt stays absent rather than becoming a value", () => {
    // the writer omits the key for a host it has never reached; inventing a timestamp
    // here would put "just now" beside a machine nobody has ever contacted
    const snapshot = parseFleetSnapshot(JSON.stringify(VALID));
    expect(snapshot.hosts[1]?.lastSeenAt).toBeUndefined();
  });

  // Every case below must THROW rather than degrade, because the caller's fallback is the
  // "not checked" state. A parser that quietly returns a partial fleet turns a broken
  // writer into a confident-looking board  -  the failure this whole rail is careful about.
  test("rejects text that is not JSON", () => {
    expect(() => parseFleetSnapshot("{ not json")).toThrow();
  });

  test("rejects a future schema rather than guessing at its shape", () => {
    expect(() => parseFleetSnapshot(JSON.stringify({ ...VALID, schema: 2 }))).toThrow(/schema/);
  });

  test("rejects a snapshot with no sweptAt  -  the staleness rule has nothing to stand on", () => {
    const { sweptAt, ...rest } = VALID;
    expect(() => parseFleetSnapshot(JSON.stringify(rest))).toThrow(/sweptAt/);
  });

  test("rejects a hosts field that is not an array", () => {
    expect(() => parseFleetSnapshot(JSON.stringify({ ...VALID, hosts: {} }))).toThrow(/hosts/);
  });

  test("rejects a name that is not a hostname", () => {
    // padding makes a SECOND row for a machine that already has one, and the rail counts
    // rows; the sweep reads names from a whitespace-delimited roster column, so neither of
    // these can have come from it
    for (const name of [" worker-a ", "a b", "worker-a/../etc", ""]) {
      const bad = { ...VALID, hosts: [{ ...VALID.hosts[0], name }] };
      expect(() => parseFleetSnapshot(JSON.stringify(bad))).toThrow(/name/);
    }
  });

  test("rejects a host missing its name or its reachability", () => {
    const noName = { ...VALID, hosts: [{ reachable: true, flags: [], projects: [], unreconciled: 0 }] };
    expect(() => parseFleetSnapshot(JSON.stringify(noName))).toThrow(/name/);
    const noReach = { ...VALID, hosts: [{ name: "worker-b", flags: [], projects: [], unreconciled: 0 }] };
    expect(() => parseFleetSnapshot(JSON.stringify(noReach))).toThrow(/reachable/);
  });

  test("an empty fleet is malformed, not an empty board", () => {
    // a roster the sweep could not read produces no hosts; rendering that as a fleet of
    // nobody would read as "every machine is gone" instead of "the sweep did not work"
    expect(() => parseFleetSnapshot(JSON.stringify({ ...VALID, hosts: [] }))).toThrow(/hosts/);
  });

  test("tolerates missing flags/projects/unreconciled by defaulting them", () => {
    // absent means "this writer does not send it", which a host that was or was not
    // reachable survives; present-but-wrong is a different thing and is rejected below
    // lastSeenAt is not among them: a reachable host must carry one, asserted below
    const sparse = {
      ...VALID,
      hosts: [{ name: "worker-a", reachable: true, lastSeenAt: "2026-08-13T04:13:16Z" }],
    };
    const host = parseFleetSnapshot(JSON.stringify(sparse)).hosts[0];
    expect(host?.flags).toEqual([]);
    expect(host?.projects).toEqual([]);
    expect(host?.unreconciled).toBe(0);
  });

  // A value that is present and off-contract means the writer is broken, and the caller's
  // answer to a broken writer is `not checked`. Filtering the bad members out instead would
  // turn a broken writer into a board that looks measured  -  the one outcome the whole rail
  // is careful about, and the one an operator would act on.
  test("rejects an unreconciled count that is negative or fractional", () => {
    // The field is documented as a count of dirty or unpushed repositories, so -1 and 1.5
    // are off-contract in the same way a string would be. Finiteness alone let them through
    // and the endpoint published them as measured fleet data, which is the one outcome this
    // rail is careful about: a broken writer must read as `not checked`, never as a count.
    // 9007199254740993 is included deliberately: JSON.parse rounds it to ...992, past
    // MAX_SAFE_INTEGER, so only a safe-integer guard rejects it. A fraction that rounds into a
    // *safe* integer (4500000000000000.1) is not here, because no value-level guard can reject
    // it - JSON.parse discards the fractional part before any check sees the number.
    for (const bad of [-1, 1.5, 9007199254740993]) {
      const snapshot = {
        ...VALID,
        hosts: [{ name: "worker-b", reachable: true, lastSeenAt: "2026-08-13T04:13:16Z", flags: [], projects: [], unreconciled: bad }],
      };
      expect(() => parseFleetSnapshot(JSON.stringify(snapshot))).toThrow(/unreconciled/);
    }
  });

  test("rejects a sweptAt that is not a readable timestamp", () => {
    // it passes straight to the staleness rule and to the header's age label, so an
    // unparseable value renders as its own raw text beside hosts shown ready
    expect(() => parseFleetSnapshot(JSON.stringify({ ...VALID, sweptAt: "not-a-date" })))
      .toThrow(/sweptAt/);
  });

  test("rejects a missing or non-string sweptFrom", () => {
    const { sweptFrom, ...rest } = VALID;
    expect(() => parseFleetSnapshot(JSON.stringify(rest))).toThrow(/sweptFrom/);
    expect(() => parseFleetSnapshot(JSON.stringify({ ...VALID, sweptFrom: 7 }))).toThrow(/sweptFrom/);
  });

  test("rejects a timestamp that Date.parse would accept but the contract does not", () => {
    // Date.parse is far too generous to be this test on its own: it takes RFC-1123 dates,
    // and it silently NORMALISES an impossible calendar date rather than failing
    expect(() => parseFleetSnapshot(JSON.stringify({ ...VALID, sweptAt: "Mon, 10 Aug 2026 11:30:00 GMT" })))
      .toThrow(/sweptAt/);
    expect(() => parseFleetSnapshot(JSON.stringify({ ...VALID, sweptAt: "2026-02-30T00:00:00Z" })))
      .toThrow(/not a real date/);
  });

  test("rejects a lastSeenAt of null  -  present is not absent", () => {
    // the writer strips nulls before writing, so a null here means some other producer
    // made this file, which is exactly when guessing at its meaning is the wrong move
    const nulled = { ...VALID, hosts: [{ ...VALID.hosts[0], lastSeenAt: null }] };
    expect(() => parseFleetSnapshot(JSON.stringify(nulled))).toThrow(/lastSeenAt/);
  });

  test("rejects a host lastSeenAt that is not a readable timestamp", () => {
    // the writer carries this value forward across sweeps, so one bad one persists
    // indefinitely rather than being corrected by the next run
    const poisoned = { ...VALID, hosts: [{ ...VALID.hosts[0], lastSeenAt: "z" }] };
    expect(() => parseFleetSnapshot(JSON.stringify(poisoned))).toThrow(/lastSeenAt/);
  });

  test("rejects flags or projects that are not arrays of strings", () => {
    const badFlags = { ...VALID, hosts: [{ ...VALID.hosts[0], flags: ["cleared", 3] }] };
    expect(() => parseFleetSnapshot(JSON.stringify(badFlags))).toThrow(/flags/);
    const badProjects = { ...VALID, hosts: [{ ...VALID.hosts[0], projects: "dcl" }] };
    expect(() => parseFleetSnapshot(JSON.stringify(badProjects))).toThrow(/projects/);
  });

  test("rejects a reachable host that carries no sighting", () => {
    // omission means "never reached", so on a host the sweep DID reach it is a
    // contradiction  -  and would render as a green row reading "never seen"
    const seenless = { ...VALID, hosts: [{ name: "worker-a", reachable: true, flags: ["cleared"] }] };
    expect(() => parseFleetSnapshot(JSON.stringify(seenless))).toThrow(/lastSeenAt/);
  });

  test("rejects a host that appears twice  -  the rail would count it as two machines", () => {
    const twice = { ...VALID, hosts: [VALID.hosts[0], { ...VALID.hosts[0] }] };
    expect(() => parseFleetSnapshot(JSON.stringify(twice))).toThrow(/more than once/);
  });

  test("a duplicate is a duplicate regardless of case  -  one machine, one row", () => {
    // the roster is lowercase and DNS does not distinguish them, so uppercase is not a
    // second machine that could take a session
    const cased = { ...VALID, hosts: [VALID.hosts[0], { ...VALID.hosts[0], name: "WORKER-A" }] };
    expect(() => parseFleetSnapshot(JSON.stringify(cased))).toThrow(/more than once/);
  });

  test("rejects a non-numeric unreconciled count", () => {
    const bad = { ...VALID, hosts: [{ ...VALID.hosts[0], unreconciled: "two" }] };
    expect(() => parseFleetSnapshot(JSON.stringify(bad))).toThrow(/unreconciled/);
  });
});

describe("readFleetSnapshot", () => {
  test("reads a snapshot from disk", () => {
    const path = tempFile("fleet-presence.json", JSON.stringify(VALID));
    expect(readFleetSnapshot(path).sweptFrom).toBe("worker-a");
  });

  test("a missing file throws, naming the path so the failure is actionable", () => {
    expect(() => readFleetSnapshot("/nonexistent/fleet-presence.json"))
      .toThrow(/fleet-presence\.json/);
  });

  test("a half-written file throws rather than returning part of a fleet", () => {
    const path = tempFile("fleet-presence.json", '{"schema":1,"sweptAt":"2026');
    expect(() => readFleetSnapshot(path)).toThrow();
  });
});
