import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

export function isDclDataRepo(root: string): boolean {
  return (
    isFile(resolve(root, "BOARD.md")) &&
    isFile(resolve(root, "OUTBOX.md")) &&
    isFile(resolve(root, "loops.json")) &&
    isDirectory(resolve(root, "items")) &&
    isDirectory(resolve(root, "for-delivery")) &&
    isDirectory(resolve(root, "archive"))
  );
}
