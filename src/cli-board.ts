#!/usr/bin/env bun
// `bun run board`  -  starts the Decently Tidy Ledger server and opens the browser.
//
// Starting up mutates nothing. `bun run sync` (DCL's cli-sync.ts) is the sole writer of
// BOARD.md, the sole router of orphan rows to OUTBOX.md, and the sole mover of item
// files between items/, for-delivery/ and archive/. This command used to do all three
// as well, using a renderer frozen at 2026-07-11, so every run rewrote BOARD.md with a
// pre-migration header and an `Owner` column in place of `Assignee`  -  dropping every
// assignee value. Keep startup inert: the moment this file writes a generated artifact,
// two generators own it again.
//
// The server exposes its OUTBOX.md answer endpoint only when the operator explicitly
// requests an exclusive write session. Ordinary startup remains read-only.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startServer } from "./server.ts";
import { loadSettings } from "./settings.ts";

export function main(
  projectRoot: string = resolve(import.meta.dir, ".."),
): void {
  const settings = loadSettings(projectRoot);

// Loopback only. The server's generic handler serves any file under the repo root, so
// binding every interface publishes this private repo to the LAN/tailnet. server.ts made
// the interface a caller's choice but this  -  the only production
// caller  -  never pinned it. `bun run board` is a local operator tool; it has no reason to
// be reachable off-box, and the outbox write path lands on this same listener.
  startServer(settings.dataRepo, settings.port, "127.0.0.1", undefined, {
    outboxWrites: settings.outboxWrites,
  });
  const url = `http://localhost:${settings.port}/`;
  console.log(`\nServing human view at ${url}`);
  console.log(settings.outboxWrites === "exclusive"
    ? "OUTBOX writes are enabled exclusively. Stop other writers until this process exits."
    : "OUTBOX answers are read-only. Configure exclusive mode only when other writers are stopped.");

  openBrowser(url);
}

export interface BrowserProcess {
  once(event: "error", listener: (error: Error) => void): this;
  unref(): void;
}

export type BrowserSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: "ignore"; detached: true; windowsHide?: boolean },
) => BrowserProcess;

export function browserCommand(
  platform: NodeJS.Platform,
  target: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", target] };
  return { command: "xdg-open", args: [target] };
}

const spawnBrowser: BrowserSpawn = (command, args, options) =>
  spawn(command, [...args], options);

export function openBrowser(
  target: string,
  platform: NodeJS.Platform = process.platform,
  launch: BrowserSpawn = spawnBrowser,
  report: (message: string) => void = console.log,
): void {
  const opener = browserCommand(platform, target);
  try {
    const child = launch(opener.command, opener.args, {
      stdio: "ignore",
      detached: true,
      ...(platform === "win32" ? { windowsHide: true } : {}),
    });
    child.once("error", () => {
      report(`(could not auto-open a browser; visit ${target} manually)`);
    });
    child.unref();
  } catch {
    report(`(could not auto-open a browser; visit ${target} manually)`);
  }
}

if (import.meta.main) main();
