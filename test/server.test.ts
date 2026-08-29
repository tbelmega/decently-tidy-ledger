import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type ServerOptions } from "../src/server.ts";
import { buildWorkersPayload } from "../src/api.ts";
import { PresenceProviderRegistry } from "../src/presence.ts";

const REPO_ROOT = join(import.meta.dir, "fixtures");

describe("startServer binding", () => {
  test("binds loopback by default, so a forgetful caller cannot publish the repo", () => {
    // The all-interfaces default was
    // defensible while the server was read-only; it is not now that one route writes.
    const server = startServer(REPO_ROOT, 0);
    try {
      expect(server.hostname).toBe("127.0.0.1");
    } finally {
      server.stop(true);
    }
  });

  test("widening the binding does NOT bring the write endpoint with it", async () => {
    // there is no authentication and none is planned; the interface IS the access
    // control, so a wider bind must degrade to read-only
    const server = startServer(
      REPO_ROOT,
      0,
      "0.0.0.0",
      new PresenceProviderRegistry(),
      { allowedHosts: ["127.0.0.1"] },
    );
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/outbox/1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "x", entryHash: "y" }),
      });
      expect(res.status).toBe(403);
      // and the read paths still work, so widening is still useful
      expect((await fetch(`http://127.0.0.1:${server.port}/api/outbox`)).status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("answer writes are disabled unless the operator opts into an exclusive session", async () => {
    const server = startServer(REPO_ROOT, 0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const res = await fetch(`${base}/api/outbox/1/answer`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ text: "x", entryHash: "y" }),
      });
      expect(res.status).toBe(403);
      expect((await (await fetch(`${base}/api/outbox`)).json()).writable).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("a caller can still widen it deliberately", () => {
    const server = startServer(REPO_ROOT, 0, "0.0.0.0");
    try {
      expect(server.hostname).toBe("0.0.0.0");
    } finally {
      server.stop(true);
    }
  });


});

describe("routes", () => {
  /** Runs `body` against a live loopback server on an ephemeral port. */
  async function withServer(
    body: (base: string) => Promise<void>,
    presenceProviders: PresenceProviderRegistry = new PresenceProviderRegistry(),
    options: ServerOptions = { outboxWrites: "exclusive" },
  ): Promise<void> {
    const server = startServer(REPO_ROOT, 0, "127.0.0.1", presenceProviders, options);
    try {
      await body(`http://127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  }

  async function writeHeaders(base: string): Promise<Record<string, string>> {
    const html = await (await fetch(`${base}/`)).text();
    const token = /name="ledger-write-token" content="([^"]+)"/.exec(html)?.[1];
    if (!token) throw new Error("server did not embed a write token");
    return {
      "content-type": "application/json",
      origin: base,
      "x-ledger-write-token": token,
    };
  }

  test("/ serves the ledger", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("Decently Tidy Ledger");
    });
  });

  test("rejects a request whose Host is not the listener origin", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/`, { headers: { host: "attacker.example" } });
      expect(res.status).toBe(421);
    });
  });

  test("the answer route requires same-origin and the per-process token", async () => {
    await withServer(async (base) => {
      const headers = await writeHeaders(base);
      const body = JSON.stringify({ text: "x", entryHash: "y" });
      expect((await fetch(`${base}/api/outbox/1/answer`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      })).status).toBe(403);
      expect((await fetch(`${base}/api/outbox/1/answer`, {
        method: "POST", headers: { ...headers, origin: "https://attacker.example" }, body,
      })).status).toBe(403);
      expect((await fetch(`${base}/api/outbox/1/answer`, {
        method: "POST", headers: { ...headers, "x-ledger-write-token": "wrong" }, body,
      })).status).toBe(403);
    });
  });

  test("never serves encoded prefix siblings or symlink targets outside the data repo", async () => {
    const parent = mkdtempSync(join(tmpdir(), "ledger-containment-"));
    const root = join(parent, "data");
    const sibling = join(parent, "data-private");
    mkdirSync(root);
    mkdirSync(join(root, "items"));
    mkdirSync(sibling);
    writeFileSync(join(sibling, "secret.txt"), "secret");
    writeFileSync(
      join(sibling, "external.md"),
      "---\ntitle: External\nproject: alpha\nstate: idea\nupdated: 2026-08-29\n---\n\nprivate\n",
    );
    symlinkSync(join(sibling, "secret.txt"), join(root, "leak.txt"));
    symlinkSync(join(sibling, "external.md"), join(root, "items", "external.md"));
    const server = startServer(root, 0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect((await fetch(`${base}/..%2Fdata-private%2Fsecret.txt`)).status).toBe(404);
      expect((await fetch(`${base}/leak.txt`)).status).toBe(404);
      expect((await fetch(`${base}/api/item?slug=external`)).status).toBe(404);
    } finally {
      server.stop(true);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("hides presence when no local provider is configured", async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}/api/workers`)).status).toBe(404);
      const html = await (await fetch(`${base}/`)).text();
      expect(html).toMatch(/id="sec-workers" hidden/);
    });
  });

  // `/api/workers` is the one route whose data comes from outside this repo, so it is the
  // one route that can be handed something the board did not write. The rule it has to keep
  // is the outbox's: a check that could not be made says so, and never resembles a check
  // that came back clear. A 200 with an empty list would read as "every machine is gone".
  describe("/api/workers with an unusable snapshot", () => {
    async function withSnapshotProvider(dir: string, body: (base: string) => Promise<void>): Promise<void> {
      const registry = new PresenceProviderRegistry();
      registry.register({
        name: "snapshot-fixture",
        read: (now) => buildWorkersPayload(join(dir, "runbook", "fleet-presence.json"), now),
      });
      await withServer(body, registry);
    }

    function snapshotDir(contents: string | null): string {
      const dir = mkdtempSync(join(tmpdir(), "fleet-server-"));
      mkdirSync(join(dir, "runbook"));
      if (contents !== null) writeFileSync(join(dir, "runbook", "fleet-presence.json"), contents);
      return dir;
    }

    const GOOD = JSON.stringify({
      schema: 1,
      sweptAt: "2026-08-13T04:22:02Z",
      sweptFrom: "worker-a",
      hosts: [{ name: "worker-a", reachable: true, lastSeenAt: "2026-08-13T04:22:02Z",
                flags: ["cleared", "capable"], projects: ["example-data"], unreconciled: 0 }],
    });

    test("a missing snapshot is a failure, not an empty fleet", async () => {
      await withSnapshotProvider(snapshotDir(null), async (base) => {
        const html = await (await fetch(`${base}/`)).text();
        expect(html).not.toMatch(/id="sec-workers" hidden/);
        const res = await fetch(`${base}/api/workers`);
        expect(res.status).toBe(503);
        const body = await res.json();
        expect(body.error).toContain("fleet-presence.json");
        expect(body.workers).toBeUndefined();
      });
    });

    test("a snapshot with an unreadable sweep time is a failure, not live data", async () => {
      const bad = JSON.stringify({ ...JSON.parse(GOOD), sweptAt: "not-a-date" });
      await withSnapshotProvider(snapshotDir(bad), async (base) => {
        const res = await fetch(`${base}/api/workers`);
        expect(res.status).toBe(503);
        expect((await res.json()).error).toContain("sweptAt");
      });
    });

    test("a half-written snapshot is a failure rather than partial fleet data", async () => {
      await withSnapshotProvider(snapshotDir('{"schema":1,"sweptAt":"2026'), async (base) => {
        expect((await fetch(`${base}/api/workers`)).status).toBe(503);
      });
    });

    // Duplicates get their own endpoint cases because they are the failure that does not look
    // like one: the file parses, every field is well formed, and the rail simply advertises a
    // machine that is not there. It has to reach `not checked` like any other bad snapshot.
    test("a host named twice reaches the endpoint as a failure, not as extra capacity", async () => {
      const host = JSON.parse(GOOD).hosts[0];
      const dup = JSON.stringify({ ...JSON.parse(GOOD), hosts: [host, { ...host }] });
      await withSnapshotProvider(snapshotDir(dup), async (base) => {
        const res = await fetch(`${base}/api/workers`);
        expect(res.status).toBe(503);
        expect((await res.json()).error).toContain("more than once");
      });
    });

    test("and the same holds when the duplicate differs only in case", async () => {
      const host = JSON.parse(GOOD).hosts[0];
      const dup = JSON.stringify({ ...JSON.parse(GOOD), hosts: [host, { ...host, name: "WORKER-A" }] });
      await withSnapshotProvider(snapshotDir(dup), async (base) => {
        expect((await fetch(`${base}/api/workers`)).status).toBe(503);
      });
    });

    test("and a good snapshot is served live, so the failures above mean something", async () => {
      await withSnapshotProvider(snapshotDir(GOOD), async (base) => {
        const res = await fetch(`${base}/api/workers`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.source).toBe("snapshot");
        expect(body.sweptFrom).toBe("worker-a");
        expect(body.workers).toHaveLength(1);
      });
    });
  });

  test("/api/board carries the columns the ledger renders", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/board`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const payload = await res.json();
      expect(Array.isArray(payload.columns)).toBe(true);
      expect(payload.priorityProjects).toEqual(["beta"]);
    });
  });

  test("/api/outbox serves the parsed entries, uncached", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/outbox`);
      expect(res.status).toBe(200);
      // agents rewrite OUTBOX.md constantly; a cached outbox is a lying outbox
      expect(res.headers.get("cache-control")).toBe("no-store");
      const payload = await res.json();
      expect(Array.isArray(payload.entries)).toBe(true);
      // retired-type entries are reported on purpose and still drain; a structural
      // anomaly against the live file would be a real parse failure
      expect(payload.anomalies.filter((a: { kind: string }) => a.kind !== "retired-type"))
        .toEqual([]);
    });
  });

  test("/api/outbox renders each body server-side", async () => {
    await withServer(async (base) => {
      const payload = await (await fetch(`${base}/api/outbox`)).json();
      // the page carries a write endpoint, so pasted agent text must never reach the
      // browser as markup it could execute
      for (const entry of payload.entries) {
        expect(typeof entry.bodyHtml).toBe("string");
        expect(entry.bodyHtml).not.toContain("<script>");
      }
    });
  });

  // Exercise the body validator through the HTTP boundary.
  test("the answer route rejects a non-object JSON body", async () => {
    await withServer(async (base) => {
      const headers = await writeHeaders(base);
      for (const body of ["null", "[]", '"text"']) {
        const res = await fetch(`${base}/api/outbox/1/answer`, {
          method: "POST",
          headers,
          body,
        });
        expect(res.status).toBe(400);
      }
    });
  });

  test("the answer route rejects a body missing its fields", async () => {
    await withServer(async (base) => {
      const headers = await writeHeaders(base);
      const res = await fetch(`${base}/api/outbox/1/answer`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(400);
    });
  });

  test("the answer route refuses anything but POST", async () => {
    await withServer(async (base) => {
      const headers = await writeHeaders(base);
      const res = await fetch(`${base}/api/outbox/1/answer`, { headers });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    });
  });

  test("/api/items is gone with the table view it fed", async () => {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/items`);
      expect(res.status).toBe(404);
    });
  });
});
