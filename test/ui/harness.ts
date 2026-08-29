// Test harness for the opt-in browser suite (`bun run test:ui`).
//
// Deliberately NOT named *.test.ts: `bun test` must stay hermetic, because every agent on
// every host runs it and Chrome is not a repo dependency. The suite starts its own board
// server so it never collides with a board the owner has open.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startServer } from "../../src/server.ts";

interface CdpResponse {
  id?: number;
  result?: {
    exceptionDetails?: { exception?: { description?: string } };
    result?: { value?: unknown };
  };
}

interface CdpTarget {
  type: string;
  webSocketDebuggerUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCdpTarget(value: unknown): value is CdpTarget {
  return isRecord(value) && value.type === "page" && typeof value.webSocketDebuggerUrl === "string";
}

function isCdpResponse(value: unknown): value is CdpResponse {
  return isRecord(value) && (value.id === undefined || typeof value.id === "number");
}

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => typeof path === "string" && path.length > 0);

export function findChrome(): string {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "no Chrome binary found. Set CHROME_BIN, or install Chrome/Chromium.\n" +
        `Looked in: ${CHROME_CANDIDATES.join(", ")}`,
    );
  }
  return found;
}

export interface Page {
  /** Evaluate in the page and return the value. Throws on an in-page exception. */
  evaluate(expression: string): Promise<string>;
  send(method: string, params?: Record<string, unknown>): Promise<CdpResponse>;
  navigate(url: string): Promise<void>;
  /** Override the viewport; pass null to clear the override. */
  setViewport(size: { width: number; height: number } | null): Promise<void>;
}

export interface Session {
  page: Page;
  baseUrl: string;
  close(): Promise<void>;
}

/** Chrome writes its real port here once it is listening. Asking for port 0 and reading
 * back the answer avoids the race in picking a "free" port ourselves and then hoping it
 * is still free by the time Chrome binds it. */
function readDevToolsPort(profileDir: string): number | null {
  const marker = join(profileDir, "DevToolsActivePort");
  if (!existsSync(marker)) return null;
  const port = Number(readFileSync(marker, "utf8").split("\n")[0]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/** How long any single CDP command may take before the suite gives up on it. A socket
 * can stay open while the browser stops answering; without this the suite hangs rather
 * than failing, which is indistinguishable from a slow test run. */
const CDP_TIMEOUT_MS = 30_000;
/** Bound and dialled explicitly: "localhost" can resolve to ::1 while the listener is
 * on 127.0.0.1, which would fail for reasons that look nothing like the cause. */
const LOOPBACK = "127.0.0.1";
const TERM_GRACE_MS = 5_000;
/** Generous, because SIGKILL is uncatchable  -  only a process wedged in uninterruptible
 * I/O outlives it, and that is pathological rather than routine. */
const KILL_GRACE_MS = 15_000;

/** SIGTERM, then SIGKILL, reporting whether the child was actually reaped.
 *
 * The caller needs the answer rather than a bare promise: deleting the profile directory
 * under a still-running Chrome is worse than leaving a temp directory behind, so an
 * unconfirmed exit must suppress the removal rather than race it. */
async function terminate(child: ChildProcess | null): Promise<boolean> {
  if (!child) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  try { child.kill("SIGTERM"); } catch { return true; } // already gone
  if (await Promise.race([exited, Bun.sleep(TERM_GRACE_MS).then(() => false)])) return true;
  try { child.kill("SIGKILL"); } catch { return true; }
  return await Promise.race([exited, Bun.sleep(KILL_GRACE_MS).then(() => false)]);
}

/** Boots the board server and a headless Chrome attached over CDP. Every resource is
 * acquired inside the cleanup boundary, so no failure path can leak a browser, a profile
 * directory or a listening server. */
export async function startSession(repoRoot: string): Promise<Session> {
  const chromeBin = findChrome(); // throws before anything is acquired
  let board: Server<unknown> | null = null;
  let profileDir: string | null = null;
  let chrome: ChildProcess | null = null;
  let socket: WebSocket | null = null;

  const pending = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }>();
  const failPending = (reason: string) => {
    for (const [, waiter] of pending) waiter.reject(new Error(reason));
    pending.clear();
  };

  const cleanup = async () => {
    failPending("the session was closed");
    try { socket?.close(); } catch { /* already gone */ }
    const reaped = await terminate(chrome);
    try { board?.stop(true); } catch { /* already stopped */ }
    // Removal is gated on an observed exit, and an unreaped browser is reported rather
    // than swallowed. Rounds 1 and 3 pulled opposite ways here  -  the directory must not
    // survive, and must not be deleted under a live process. Both hold only if the
    // pathological branch is a loud failure instead of a silent choice either way.
    if (profileDir) {
      if (reaped) {
        try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* reported below */ }
        if (existsSync(profileDir)) {
          throw new Error(`could not remove the Chrome profile at ${profileDir}`);
        }
      } else {
        throw new Error(
          `Chrome did not exit after SIGKILL; left ${profileDir} in place rather than ` +
          "deleting it under a live process. Kill that process and remove the directory.",
        );
      }
    }
  };

  try {
    // port 0 lets the OS assign; the server reports what it actually got, so nothing is
    // reserved-then-released and no other process can take it in between
    board = startServer(repoRoot, 0, LOOPBACK, undefined, {
      outboxWrites: "exclusive",
    }); // never reachable off-box
    profileDir = mkdtempSync(join(tmpdir(), "board-ui-"));
    const dir = profileDir;

    chrome = spawn(chromeBin, [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      `--user-data-dir=${dir}`,
      "about:blank",
    ], { stdio: "ignore" });
    const child = chrome;

    // a ChildProcess 'error' with no listener is an unhandled error event that would take
    // the process down before cleanup could run
    const launchFailed = new Promise<never>((_, reject) => {
      child.once("error", (err) => reject(new Error(`could not launch Chrome: ${err.message}`)));
      child.once("exit", (code) =>
        reject(new Error(`Chrome exited before the suite attached (code ${code})`)));
    });

    const discover = (async () => {
      let debugPort: number | null = null;
      for (let i = 0; i < 80 && debugPort === null; i++) {
        await Bun.sleep(250);
        debugPort = readDevToolsPort(dir);
      }
      if (debugPort === null) throw new Error("Chrome never reported a debugging port");
      for (let i = 0; i < 80; i++) {
        try {
          const targets: unknown = await (await fetch(`http://${LOOPBACK}:${debugPort}/json/list`, {
            signal: AbortSignal.timeout(2_000), // a live but unresponsive endpoint must not hang the loop
          })).json();
          const target = Array.isArray(targets) ? targets.find(isCdpTarget) : undefined;
          if (target) return target.webSocketDebuggerUrl;
        } catch { /* not serving yet */ }
        await Bun.sleep(250);
      }
      throw new Error("Chrome never exposed a debuggable page");
    })();

    const wsUrl = await Promise.race([discover, launchFailed]);

    socket = new WebSocket(wsUrl);
    const ws = socket;
    // a socket that closes during the handshake settles nothing without the close arm,
    // so startup would hang rather than fail
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out attaching to Chrome")), CDP_TIMEOUT_MS);
      const settle = (fn: () => void) => { clearTimeout(timer); fn(); };
      ws.onopen = () => settle(resolve);
      ws.onerror = () => settle(() => reject(new Error("could not attach to Chrome over CDP")));
      ws.onclose = () => settle(() => reject(new Error("Chrome closed the CDP connection during attach")));
    });

    let nextId = 0;
    ws.onmessage = (event) => {
      const parsed: unknown = JSON.parse(String(event.data));
      if (!isCdpResponse(parsed)) return;
      const msg = parsed;
      const id = msg.id;
      if (id === undefined) return;
      const waiter = pending.get(id);
      if (waiter) {
        pending.delete(id);
        waiter.resolve(msg);
      }
    };
    ws.onclose = () => failPending("the CDP connection closed mid-run");
    ws.onerror = () => failPending("the CDP connection errored mid-run");

    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<CdpResponse>((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} did not answer within ${CDP_TIMEOUT_MS}ms`));
        }, CDP_TIMEOUT_MS);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });

    const page: Page = {
      send,
      async evaluate(expression: string) {
        const res = await send("Runtime.evaluate", {
          expression, returnByValue: true, awaitPromise: true,
        });
        const details = res.result?.exceptionDetails;
        if (details) {
          throw new Error(details.exception?.description ?? JSON.stringify(details));
        }
        const value = res.result?.result?.value;
        if (value === undefined) return "";
        return typeof value === "string" ? value : JSON.stringify(value) ?? "";
      },
      async navigate(url: string) {
        await send("Page.navigate", { url });
        await Bun.sleep(2200); // the board fetches and renders on load
      },
      async setViewport(size) {
        if (size === null) {
          await send("Emulation.clearDeviceMetricsOverride");
        } else {
          await send("Emulation.setDeviceMetricsOverride", {
            ...size, deviceScaleFactor: 1, mobile: false,
          });
        }
        await Bun.sleep(400);
      },
    };

    await send("Page.enable");
    await send("Runtime.enable");

    return { page, baseUrl: `http://${LOOPBACK}:${board.port}`, close: cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Collects assertions so one failure doesn't hide the rest. */
export class Checks {
  private readonly results: Array<{ state: "pass" | "fail" | "skip"; name: string; detail: unknown }> = [];

  check(name: string, ok: boolean, detail: unknown = undefined): void {
    this.results.push({ state: ok ? "pass" : "fail", name, detail });
  }

  /** A check that could not run, recorded as SKIP and never as PASS.
   *
   * The distinction is the same one the outbox itself insists on: "not checked" is not
   * "clear". A check that quietly passes because there was nothing on screen to assert
   * reports coverage this run does not have, and the reader cannot tell it apart from a
   * check that actually held. Skips are excluded from the pass ratio for that reason. */
  skip(name: string, reason: string, detail: unknown = undefined): void {
    this.results.push({ state: "skip", name: `${name} - SKIPPED: ${reason}`, detail });
  }

  get failed(): boolean {
    return this.results.some((r) => r.state === "fail");
  }

  report(): string {
    return this.results
      .map((r) => {
        const detail = r.state !== "fail" || r.detail === undefined ? "" : `   -  ${JSON.stringify(r.detail)}`;
        const label = r.state === "pass" ? "PASS" : r.state === "fail" ? "FAIL" : "SKIP";
        return `${label}  ${r.name}${detail}`;
      })
      .join("\n");
  }

  get summary(): string {
    const passed = this.results.filter((r) => r.state === "pass").length;
    const skipped = this.results.filter((r) => r.state === "skip").length;
    const ran = this.results.length - skipped;
    return skipped > 0 ? `${passed}/${ran} passed, ${skipped} skipped` : `${passed}/${ran} passed`;
  }
}
