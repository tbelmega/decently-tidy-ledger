import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOutboxPayload, writeOutboxAnswer } from "../src/api.ts";
import {
  replaceResolvedIfUnchanged,
  withOutboxLock,
} from "decently-coordinated-loops/tools/outbox.ts";

// Never against the real OUTBOX.md: these tests write, and that file is live
// coordination data that agents on several machines are reading.
let dir = "";
let outboxPath = "";
let itemsDir = "";

const FILE = `# Outbox

**Entry contract:** do not touch this header.

## Open

### 41 — question · gamma · a title

the ask

> A:

### 46 — decision · example-data · another

more prose

> A:
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-write-"));
  outboxPath = join(dir, "OUTBOX.md");
  itemsDir = join(dir, "items");
  mkdirSync(itemsDir);
  writeFileSync(outboxPath, FILE);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function hashOf(id: number): string {
  const entry = buildOutboxPayload(outboxPath, itemsDir).entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`fixture Outbox entry ${id} is missing`);
  return entry.entryHash;
}

describe("writeOutboxAnswer", () => {
  test("writes the answer and returns the re-parsed payload", () => {
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.entries.find((e) => e.id === 41)?.answer).toBe("(a)");
    expect(readFileSync(outboxPath, "utf8")).toContain("> A: (a)");
  });

  test("leaves every other entry alone", () => {
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    const payload = buildOutboxPayload(outboxPath, itemsDir);
    expect(payload.entries.find((e) => e.id === 46)?.answer).toBeNull();
    expect(payload.anomalies).toEqual([]);
  });

  test("never touches the contract header above ## Open", () => {
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    expect(readFileSync(outboxPath, "utf8")).toContain("do not touch this header");
  });

  test("never deletes the entry  -  it is awaiting routing, not done", () => {
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    const text = readFileSync(outboxPath, "utf8");
    expect(text).toContain("### 41 — question · gamma · a title");
    expect(text).toContain("the ask");
  });

  test("409s when the entry changed since the payload was served", () => {
    const stale = hashOf(41);
    // another agent rewrites the file while the operator is composing an answer
    // to two live entries mid-life, so the guard is not theoretical
    writeFileSync(outboxPath, FILE.replace("the ask", "the ask, amended by another session"));
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", stale);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });

  test("a 409 carries the fresh payload, so the client can keep the draft", () => {
    const stale = hashOf(41);
    writeFileSync(outboxPath, FILE.replace("the ask", "amended"));
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", stale);
    expect(result.ok).toBe(false);
    if (result.ok || result.status !== 409) return;
    expect(result.payload?.entries.find((e) => e.id === 41)?.body).toContain("amended");
  });

  test("a 409 leaves the file untouched", () => {
    const stale = hashOf(41);
    const amended = FILE.replace("the ask", "amended");
    writeFileSync(outboxPath, amended);
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", stale);
    expect(readFileSync(outboxPath, "utf8")).toBe(amended);
  });

  test("400s on a blank answer  -  empty means never answered", () => {
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "   ", hashOf(41));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  // 400, not 404: the documented contract calls an unknown id  -  or one that is not
  // under `## Open`  -  a bad request against a payload the client already holds. This
  // The contract treats an unknown or non-open id as a malformed request.
  test("400s on an id that is not under ## Open", () => {
    const result = writeOutboxAnswer(outboxPath, itemsDir, 999, "(a)", "whatever");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  test("refuses to answer a duplicated id rather than answering both", () => {
    // duplicates survive as anomalies rather than being dropped, so an id is not a
    // unique address; writing would silently answer an entry nobody chose
    writeFileSync(outboxPath, FILE + "\n### 41 — question · gamma · a twin\n\nother\n\n> A:\n");
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", "whatever");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.message).toMatch(/appears 2 times/);
  });

  test("a refused duplicate write leaves both entries unanswered", () => {
    const doubled = FILE + "\n### 41 — question · gamma · a twin\n\nother\n\n> A:\n";
    writeFileSync(outboxPath, doubled);
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", "whatever");
    expect(readFileSync(outboxPath, "utf8")).toBe(doubled);
  });

  test("refuses to write while another writer holds the lock", () => {
    // the lock is what closes the read-verify-write gap; without it a concurrent agent's
    // edit could be replaced while this request still answered 200
    writeFileSync(outboxPath + ".lock", "");
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.message).toMatch(/another writer/);
    rmSync(outboxPath + ".lock");
  });

  test("releases the lock after a successful write", () => {
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    const { existsSync } = require("node:fs");
    expect(existsSync(outboxPath + ".lock")).toBe(false);
  });

  test("releases the lock after a refused write", () => {
    writeOutboxAnswer(outboxPath, itemsDir, 999, "(a)", "whatever");
    const { existsSync } = require("node:fs");
    expect(existsSync(outboxPath + ".lock")).toBe(false);
  });

  test("never edits an entry under a later section", () => {
    // `## Open` is not guaranteed to be the last section
    const withArchive = FILE + "\n## Answered\n\n### 41 — question · gamma · archived twin\n\nold\n\n> A: settled\n";
    writeFileSync(outboxPath, withArchive);
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    const text = readFileSync(outboxPath, "utf8");
    expect(text).toContain("> A: settled");
    expect(text).toContain("## Answered");
  });

  test("a lock held by a LIVE process is never swept, however old", () => {
    // age alone is not liveness: sweeping a paused writer's lock would let a second
    // writer rename a stale snapshot over newer content
    writeFileSync(outboxPath + ".lock", String(process.pid));
    const recent = new Date(Date.now() - 20_000);
    utimesSync(outboxPath + ".lock", recent, recent);
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    expect(result.ok).toBe(false);
    rmSync(outboxPath + ".lock");
  });

  test("a lock is never reclaimed automatically, however old", () => {
    // Three attempts at automatic reclamation produced three different data-loss races
    //. A crashed writer's lock is a visible file a person
    // deletes in one command; every scheme for guessing when that is safe was worse.
    writeFileSync(outboxPath + ".lock", String(process.pid));
    const ancient = new Date(Date.now() - 60 * 60_000);
    utimesSync(outboxPath + ".lock", ancient, ancient);
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    rmSync(outboxPath + ".lock");
  });

  test("the lock records the pid that left it", () => {
    // so whoever finds a stale one can tell what to look for before deleting it
    let seen = "";
    withOutboxLock(outboxPath, () => { seen = readFileSync(outboxPath + ".lock", "utf8"); });
    expect(seen).toBe(String(process.pid));
  });

  test("builds from the snapshot it read, so an unrelated edit is not clobbered", () => {
    const theirs = FILE.replace("more prose", "another session edited entry 46");
    writeFileSync(outboxPath, theirs);
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    expect(result.ok).toBe(true);
    const after = readFileSync(outboxPath, "utf8");
    expect(after).toContain("another session edited entry 46"); // their edit survives
    expect(after).toContain("> A: (a)"); // and ours landed
  });

  test("leaves no temp file behind", () => {
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    const { readdirSync } = require("node:fs");
    expect(readdirSync(dir).filter((f: string) => f.includes(".tmp"))).toEqual([]);
  });

  test("writes through an OUTBOX.md symlink without replacing it", () => {
    const target = join(dir, "shared-outbox.md");
    writeFileSync(target, FILE);
    rmSync(outboxPath);
    symlinkSync(target, outboxPath);
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    expect(result.ok).toBe(true);
    expect(lstatSync(outboxPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("> A: (a)");
  });

  test("refuses a symlink retargeted after locking", () => {
    const first = join(dir, "first-outbox.md");
    const second = join(dir, "second-outbox.md");
    writeFileSync(first, FILE);
    writeFileSync(second, FILE);
    rmSync(outboxPath);
    symlinkSync(first, outboxPath);
    let resolutions = 0;
    const resolveWithRetarget = (path: string): string => {
      resolutions += 1;
      if (resolutions === 2) {
        rmSync(outboxPath);
        symlinkSync(second, outboxPath);
      }
      return realpathSync(path);
    };
    const result = writeOutboxAnswer(
      outboxPath,
      itemsDir,
      41,
      "(a)",
      hashOf(41),
      new Date(),
      resolveWithRetarget,
    );
    expect(result.ok).toBe(false);
    expect(readFileSync(first, "utf8")).toBe(FILE);
    expect(readFileSync(second, "utf8")).toBe(FILE);
  });

  test("falls back to the snapshot when a retargeted alias is unreadable", () => {
    const target = join(dir, "shared-outbox.md");
    const missing = join(dir, "missing-outbox.md");
    writeFileSync(target, FILE);
    rmSync(outboxPath);
    symlinkSync(target, outboxPath);
    let resolutions = 0;
    const resolveWithDanglingRetarget = (path: string): string => {
      resolutions += 1;
      if (resolutions === 1) return realpathSync(path);
      rmSync(outboxPath);
      symlinkSync(missing, outboxPath);
      return missing;
    };
    const result = writeOutboxAnswer(
      outboxPath,
      itemsDir,
      41,
      "(a)",
      hashOf(41),
      new Date(),
      resolveWithDanglingRetarget,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    if (result.status !== 409) return;
    expect(result.payload?.entries.find((entry) => entry.id === 41)?.answer).toBeNull();
    expect(readFileSync(target, "utf8")).toBe(FILE);
  });

  test("returns a conflict when the outbox alias disappears after locking", () => {
    const target = join(dir, "shared-outbox.md");
    writeFileSync(target, FILE);
    rmSync(outboxPath);
    symlinkSync(target, outboxPath);
    let resolutions = 0;
    const resolveWithRemoval = (path: string): string => {
      resolutions += 1;
      if (resolutions === 2) rmSync(outboxPath);
      return realpathSync(path);
    };
    const result = writeOutboxAnswer(
      outboxPath,
      itemsDir,
      41,
      "(a)",
      hashOf(41),
      new Date(),
      resolveWithRemoval,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    if (result.status !== 409) return;
    expect(result.payload?.entries.find((entry) => entry.id === 41)?.answer).toBeNull();
    expect(readFileSync(target, "utf8")).toBe(FILE);
  });

  test("returns a conflict when the alias is gone before locking", () => {
    const target = join(dir, "shared-outbox.md");
    writeFileSync(target, FILE);
    rmSync(outboxPath);
    symlinkSync(target, outboxPath);
    const entryHash = hashOf(41);
    rmSync(outboxPath);
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", entryHash);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result).not.toHaveProperty("payload");
    expect(readFileSync(target, "utf8")).toBe(FILE);
  });

  test("returns a conflict when the target disappears before the snapshot read", () => {
    const target = join(dir, "shared-outbox.md");
    writeFileSync(target, FILE);
    rmSync(outboxPath);
    symlinkSync(target, outboxPath);
    const entryHash = hashOf(41);
    const resolveWithTargetRemoval = (path: string): string => {
      const resolved = realpathSync(path);
      rmSync(resolved);
      return resolved;
    };
    const result = writeOutboxAnswer(
      outboxPath,
      itemsDir,
      41,
      "(a)",
      entryHash,
      new Date(),
      resolveWithTargetRemoval,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result).not.toHaveProperty("payload");
    expect(existsSync(target)).toBe(false);
  });

  test("returns the snapshot when the target disappears before replacement", () => {
    const target = join(dir, "shared-outbox.md");
    writeFileSync(target, FILE);
    rmSync(outboxPath);
    symlinkSync(target, outboxPath);
    let resolutions = 0;
    const resolveWithLateTargetRemoval = (path: string): string => {
      const resolved = realpathSync(path);
      resolutions += 1;
      if (resolutions === 2) rmSync(resolved);
      return resolved;
    };
    const result = writeOutboxAnswer(
      outboxPath,
      itemsDir,
      41,
      "(a)",
      hashOf(41),
      new Date(),
      resolveWithLateTargetRemoval,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    if (result.status !== 409) return;
    expect(result.payload?.entries.find((entry) => entry.id === 41)?.answer).toBeNull();
    expect(existsSync(target)).toBe(false);
  });

  test("refuses a canonical target swapped to a symlink before replacement", () => {
    const target = join(dir, "shared-outbox.md");
    const other = join(dir, "other-outbox.md");
    writeFileSync(target, FILE);
    writeFileSync(other, FILE);
    rmSync(outboxPath);
    symlinkSync(target, outboxPath);
    const replaceAfterSwap: typeof replaceResolvedIfUnchanged = (path, snapshot, next, expected, read) => {
      rmSync(path);
      symlinkSync(other, path);
      return replaceResolvedIfUnchanged(path, snapshot, next, expected, read);
    };
    const result = writeOutboxAnswer(
      outboxPath,
      itemsDir,
      41,
      "(a)",
      hashOf(41),
      new Date(),
      realpathSync,
      replaceAfterSwap,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(readFileSync(other, "utf8")).toBe(FILE);
  });

  test("refuses a canonical target swapped to a same-content file before replacement", () => {
    const target = join(dir, "shared-outbox.md");
    writeFileSync(target, FILE);
    rmSync(outboxPath);
    symlinkSync(target, outboxPath);
    const replaceAfterSwap: typeof replaceResolvedIfUnchanged = (path, snapshot, next, expected, read) => {
      const replacement = join(dir, "replacement-outbox.md");
      writeFileSync(replacement, FILE);
      renameSync(replacement, path);
      return replaceResolvedIfUnchanged(path, snapshot, next, expected, read);
    };
    const result = writeOutboxAnswer(
      outboxPath,
      itemsDir,
      41,
      "(a)",
      hashOf(41),
      new Date(),
      realpathSync,
      replaceAfterSwap,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(readFileSync(target, "utf8")).toBe(FILE);
  });

  test("returns an actionable conflict for a hard-linked OUTBOX.md", () => {
    linkSync(outboxPath, join(dir, "outbox-alias.md"));
    const before = readFileSync(outboxPath, "utf8");
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(result.message).toMatch(/hard links/);
    expect(readFileSync(outboxPath, "utf8")).toBe(before);
  });

  test("a second answer to the same entry replaces the first", () => {
    writeOutboxAnswer(outboxPath, itemsDir, 41, "(a)", hashOf(41));
    // the hash changed with the write, which is the point  -  the client re-reads
    const result = writeOutboxAnswer(outboxPath, itemsDir, 41, "(b)", hashOf(41));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.entries.find((e) => e.id === 41)?.answer).toBe("(b)");
    expect(readFileSync(outboxPath, "utf8").match(/> A:/g)).toHaveLength(2); // one per entry
  });
});
