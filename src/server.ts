import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "decently-coordinated-loops/tools/config.ts";
import { buildLedgerApiPayload, buildOutboxPayload, writeOutboxAnswer } from "./api.ts";
import { buildItemDetail } from "./item-detail.ts";
import { PresenceProviderRegistry } from "./presence.ts";

/** Slugs are `items/*.md` filenames  -  restrict to that charset so `?slug=` can never
 * escape the items dir regardless of the existence/containment checks below. */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const LEDGER_HTML_PATH = join(PUBLIC_DIR, "ledger.html");
const FONTS_DIR = join(PUBLIC_DIR, "fonts");

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `/api/outbox/<id>/answer`  -  the board's only write endpoint. */
const ANSWER_ROUTE = /^\/api\/outbox\/(\d+)\/answer$/;

/** Interfaces on which the write route is served. Everything else is read-only. */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export interface ServerOptions {
  /** Writing is opt-in because the operator must keep every other OUTBOX.md writer
   * stopped for the lifetime of this server. */
  outboxWrites?: "disabled" | "exclusive";
  /** Hostnames accepted by a deliberately widened listener, without their port. */
  allowedHosts?: readonly string[];
}

function hostAtPort(hostname: string, port: number): string {
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`)
  );
}

/** Resolves a URL path to a regular file whose real target remains below `root`.
 * The lexical check blocks prefix siblings; the canonical check blocks symlinks. */
function readableFile(root: string, encodedPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
  const candidate = resolve(root, decoded.replace(/^\/+/, ""));
  if (!isContained(root, candidate)) return null;
  try {
    const direct = lstatSync(candidate);
    if (direct.isSymbolicLink() || !direct.isFile()) return null;
    const canonical = realpathSync(candidate);
    return isContained(root, canonical) ? canonical : null;
  } catch {
    return null;
  }
}

/** Starts the human-view server. `root` is the example-data repo root (so `/api/board`
 * can resolve `items/`, and item-file / spec links under the repo can be opened).
 *
 * `hostname` DEFAULTS TO LOOPBACK. It used to default to Bun's all-interfaces bind, with
 * the interface left as the caller's choice  -  but that predates
 * this server having a write endpoint. A caller that forgets the argument now publishes
 * a remotely writable private repo, so the safe value is the default and widening it is
 * the explicit act. */
export function startServer(
  root: string,
  port: number,
  hostname: string = "127.0.0.1",
  presenceProviders: PresenceProviderRegistry = new PresenceProviderRegistry(),
  options: ServerOptions = {},
) {
  const canonicalRoot = realpathSync(root);
  const canonicalFontsDir = realpathSync(FONTS_DIR);
  const itemsDir = join(canonicalRoot, "items");
  const forDeliveryDir = join(canonicalRoot, "for-delivery");
  const archiveDir = join(canonicalRoot, "archive");
  const writesEnabled = options.outboxWrites === "exclusive" && LOOPBACK.has(hostname);
  const writeToken = writesEnabled ? randomBytes(32).toString("base64url") : "";
  let allowedRequestHosts = new Set<string>();

  const server = Bun.serve({
    port,
    // Loopback unless a caller deliberately widens it. The generic handler below serves
    // any file under the repo root and /api/outbox/:id/answer writes one, so an exposed
    // listener publishes this private repo AND accepts writes to it.
    hostname,
    async fetch(req) {
      const url = new URL(req.url);
      const requestHost = req.headers.get("host")?.toLowerCase() ?? "";
      if (!allowedRequestHosts.has(requestHost)) {
        return new Response("Misdirected request", { status: 421 });
      }

      // The one mutating route. It needs a loopback listener, an explicit exclusive
      // session, an exact same-origin request, and the per-process token embedded in the
      // Ledger page. A widened listener remains read-only.
      const answerRoute = ANSWER_ROUTE.exec(url.pathname);
      if (answerRoute) {
        // Exclusive mode is the filesystem concurrency boundary. Origin and token are
        // the browser boundary; Host validation above blocks DNS-rebinding aliases.
        if (!writesEnabled) {
          return jsonError(403, "answer writes require an explicit exclusive session");
        }
        if (
          req.headers.get("origin") !== `http://${requestHost}` ||
          req.headers.get("x-ledger-write-token") !== writeToken
        ) {
          return jsonError(403, "answer writes require the Ledger's same-origin session token");
        }
        if (req.method !== "POST") {
          return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
        }
        let body: { text?: unknown; entryHash?: unknown } | null;
        try {
          body = await req.json();
        } catch {
          return jsonError(400, "body must be JSON");
        }
        // `null` and `[]` are valid JSON, so parsing succeeding does not mean there is
        // an object to read fields off
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return jsonError(400, "body must be a JSON object");
        }
        if (typeof body.text !== "string" || typeof body.entryHash !== "string") {
          return jsonError(400, "body must carry `text` and `entryHash` strings");
        }
        const result = writeOutboxAnswer(
          join(canonicalRoot, "OUTBOX.md"),
          itemsDir,
          Number(answerRoute[1]),
          body.text,
          body.entryHash,
        );
        if (result.ok) {
          return new Response(JSON.stringify(result.payload), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
        // a 409 carries the fresh payload so the client can show what changed without
        // throwing away the answer the operator just typed
        return new Response(
          JSON.stringify({ error: result.message, ...("payload" in result ? { payload: result.payload } : {}) }),
          { status: result.status, headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
      }

      if (url.pathname === "/") {
        const source = readFileSync(LEDGER_HTML_PATH, "utf8");
        const withPresence = presenceProviders.active()
          ? source.replace('id="sec-workers" hidden', 'id="sec-workers"')
          : source;
        const html = withPresence.replace(
          'name="ledger-write-token" content=""',
          `name="ledger-write-token" content="${writeToken}"`,
        );
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/api/board") {
        // re-read and re-parse items/*.md, for-delivery/*.md and archive/*.md on every
        // request  -  this IS the refresh mechanism. no-store keeps any HTTP cache from
        // ever serving a stale board to the Refresh button
        const payload = buildLedgerApiPayload(
          itemsDir,
          forDeliveryDir,
          archiveDir,
          new Date(),
          loadConfig(canonicalRoot).priorityProjects,
        );
        return new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }

      if (url.pathname === "/api/outbox") {
        // OUTBOX.md is rewritten by agents constantly, including during unattended
        // dispatch, so this re-reads and re-parses per request like the other two.
        const payload = buildOutboxPayload(join(canonicalRoot, "OUTBOX.md"), itemsDir);
        return new Response(JSON.stringify({ ...payload, writable: writesEnabled }), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }

      if (url.pathname === "/api/workers") {
        // fleet presence for the ledger sidebar  -  its own endpoint because it is
        // unrelated to board items, and no-store for the same reason /api/board is:
        // ↻ Refresh re-reads both, and a cached fleet is a lying fleet
        //
        // A missing or malformed snapshot is served as a FAILURE, not as an empty fleet:
        // the client's error path renders "not checked" and keeps the last values it saw,
        // which is the honest answer when nothing has measured the fleet. Serving 200 with
        // an empty list would read as "every machine is gone".
        try {
          const provider = presenceProviders.active();
          if (!provider) return jsonError(404, "no presence provider is configured");
          const payload = provider.read(new Date());
          return new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: errorMessage(err) }), {
            status: 503,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        }
      }

      if (url.pathname === "/api/item") {
        // one item's frontmatter + rendered markdown body, for the detail drawer.
        // The file may live in any of the three state folders (a for-delivery row
        // is clickable too), so resolve across them in board order.
        const slug = url.searchParams.get("slug") ?? "";
        if (!SLUG_PATTERN.test(slug)) return new Response("Bad slug", { status: 400 });
        const folders = ["items", "for-delivery", "archive"] as const;
        let found: readonly [string, string] | undefined;
        for (const prefix of folders) {
          const filePath = readableFile(canonicalRoot, `/${prefix}/${slug}.md`);
          if (filePath) {
            found = [filePath, prefix];
            break;
          }
        }
        if (!found) return new Response("Not found", { status: 404 });
        const [filePath, prefix] = found;
        const detail = buildItemDetail(`${prefix}/${slug}.md`, readFileSync(filePath, "utf8"));
        return new Response(JSON.stringify({ ...detail, absolutePath: filePath }), {
          headers: { "content-type": "application/json" },
        });
      }

      // vendored webfonts (woff2)  -  served with the right content-type so the browser
      // accepts them; the generic file handler below would mislabel them as text/plain.
      if (url.pathname.startsWith("/fonts/")) {
        const fontPath = readableFile(canonicalFontsDir, url.pathname.slice("/fonts/".length));
        if (fontPath) {
          return new Response(readFileSync(fontPath), {
            headers: { "content-type": "font/woff2", "cache-control": "max-age=86400" },
          });
        }
        return new Response("Not found", { status: 404 });
      }

      // serve repo-relative files so item-file / spec links from the view work
      // (e.g. /items/foo.md, /docs/specs/bar.md)  -  read-only, path-traversal-safe.
      const filePath = readableFile(canonicalRoot, url.pathname);
      if (filePath) {
        return new Response(readFileSync(filePath, "utf8"), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
  const listenerPort = server.port;
  if (listenerPort === undefined) {
    server.stop(true);
    throw new Error("Ledger server started without a listening port");
  }
  const acceptedNames = LOOPBACK.has(hostname)
    ? ["127.0.0.1", "::1", "localhost"]
    : [...(options.allowedHosts ?? [])];
  allowedRequestHosts = new Set(
    acceptedNames.map((name) => hostAtPort(name.toLowerCase(), listenerPort)),
  );
  return server;
}
