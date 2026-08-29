import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { browserCommand, openBrowser, type BrowserProcess } from "../src/cli-board.ts";

describe("browser opener", () => {
  test("uses cmd for Windows because start is not an executable", () => {
    expect(browserCommand("win32", "http://localhost:4173/")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "http://localhost:4173/"],
    });
  });

  test("handles an asynchronous launcher failure before detaching", () => {
    const events: string[] = [];
    class FakeProcess extends EventEmitter implements BrowserProcess {
      unref(): void {
        events.push("unref");
        this.emit("error", new Error("missing opener"));
      }
    }
    const messages: string[] = [];
    openBrowser(
      "http://localhost:4173/",
      "linux",
      () => new FakeProcess(),
      (message) => messages.push(message),
    );
    expect(events).toEqual(["unref"]);
    expect(messages).toEqual([
      "(could not auto-open a browser; visit http://localhost:4173/ manually)",
    ]);
  });
});
