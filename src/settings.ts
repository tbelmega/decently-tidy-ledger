import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDclDataRepo } from "./data-repo.ts";

export interface LedgerSettings {
  dataRepo: string;
  port: number;
  outboxWrites: "disabled" | "exclusive";
}

interface SettingsFile {
  dataRepo?: unknown;
  port?: unknown;
  outboxWrites?: unknown;
}

function invalidSettings(reason: string): Error {
  return new Error(`Invalid settings.local.json: ${reason}`);
}

export function loadSettings(projectRoot: string): LedgerSettings {
  const settingsPath = resolve(projectRoot, "settings.local.json");
  let parsed: SettingsFile;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw invalidSettings(error.message);
    }
    throw new Error(
      `Could not read ${settingsPath}. Copy settings.template.json to settings.local.json and configure it.`,
      { cause: error },
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidSettings("the root value must be an object");
  }
  if (typeof parsed.dataRepo !== "string" || parsed.dataRepo.length === 0) {
    throw invalidSettings("dataRepo must be a non-empty string");
  }
  if (!Number.isInteger(parsed.port) || (parsed.port as number) < 1 || (parsed.port as number) > 65535) {
    throw invalidSettings("port must be an integer from 1 to 65535");
  }
  if (parsed.outboxWrites !== "disabled" && parsed.outboxWrites !== "exclusive") {
    throw invalidSettings('outboxWrites must be "disabled" or "exclusive"');
  }

  const dataRepo = isAbsolute(parsed.dataRepo)
    ? resolve(parsed.dataRepo)
    : resolve(projectRoot, parsed.dataRepo);
  if (!isDclDataRepo(dataRepo)) {
    throw invalidSettings(`dataRepo is not a DCL data repo: ${dataRepo}`);
  }

  return {
    dataRepo,
    port: parsed.port as number,
    outboxWrites: parsed.outboxWrites,
  };
}
