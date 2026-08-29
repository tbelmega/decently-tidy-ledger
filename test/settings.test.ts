import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings.ts";

describe("loadSettings", () => {
  test("loads the local settings file and resolves its data repo from the project root", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ledger-project-"));
    const root = join(projectRoot, "data-repo");
    mkdirSync(root);
    for (const dir of ["items", "for-delivery", "archive"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, "BOARD.md"), "# Board\n");
    writeFileSync(join(root, "OUTBOX.md"), "# Outbox\n");
    writeFileSync(join(root, "loops.json"), "{}\n");
    writeFileSync(join(projectRoot, "settings.local.json"), JSON.stringify({
      dataRepo: "data-repo",
      port: 4317,
      outboxWrites: "exclusive",
    }));

    expect(loadSettings(projectRoot)).toEqual({
      dataRepo: root,
      port: 4317,
      outboxWrites: "exclusive",
    });
  });

  test("fails loudly when settings.local.json is missing", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ledger-project-"));
    expect(() => loadSettings(projectRoot)).toThrow(/settings\.local\.json.*settings\.template\.json/i);
  });

  test("rejects an invalid settings structure", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ledger-project-"));
    writeFileSync(join(projectRoot, "settings.local.json"), JSON.stringify({
      dataRepo: "/not/a/data/repo",
      port: 0,
      outboxWrites: "sometimes",
    }));
    expect(() => loadSettings(projectRoot)).toThrow(/invalid settings\.local\.json/i);
  });

  test("rejects malformed JSON and non-object roots", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "ledger-project-"));
    writeFileSync(join(projectRoot, "settings.local.json"), "{");
    expect(() => loadSettings(projectRoot)).toThrow(/invalid settings\.local\.json/i);
    writeFileSync(join(projectRoot, "settings.local.json"), "null\n");
    expect(() => loadSettings(projectRoot)).toThrow(/root value must be an object/i);
  });

  test("keeps the committed template aligned with the expected structure", () => {
    const template = JSON.parse(readFileSync(join(import.meta.dir, "..", "settings.template.json"), "utf8"));
    expect(template).toEqual({
      dataRepo: "/path/to/task-tracking",
      port: 4173,
      outboxWrites: "disabled",
    });
  });
});
