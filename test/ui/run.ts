#!/usr/bin/env bun
// `bun run test:ui`  -  the opt-in browser suite.
//
// Kept OUT of `bun test` on purpose: that gate must stay hermetic, because every agent on
// every host runs it and Chrome is not a repo dependency. This one needs a browser, so it
// is opt-in and says plainly when it cannot find one.
import { join } from "node:path";
import { Checks, startSession } from "./harness.ts";
import { runFleetFailureChecks, runFleetReadinessChecks, runLedgerChecks } from "./ledger-checks.ts";
import {
  runOutboxAnswerChecks,
  runOutboxChecks,
  runOutboxFailureChecks,
  runOutboxInteractionChecks,
  runOutboxOrderingChecks,
  runOutboxAnswerFlowChecks,
  runOutboxRegressionChecks,
  runOutboxSendRaceCheck,
} from "./outbox-checks.ts";

const REPO_ROOT = join(import.meta.dir, "..", "fixtures");

const session = await startSession(REPO_ROOT).catch((err) => {
  console.error(`\ncannot start the UI suite: ${err.message}\n`);
  process.exit(2);
});

const checks = new Checks();
let cleanupError: unknown = null;
try {
  await runLedgerChecks(session.page, session.baseUrl, checks);
  await runFleetReadinessChecks(session.page, session.baseUrl, checks);
  await runFleetFailureChecks(session.page, session.baseUrl, checks);
  await runOutboxChecks(session.page, session.baseUrl, checks);
  await runOutboxInteractionChecks(session.page, session.baseUrl, checks);
  await runOutboxAnswerChecks(session.page, session.baseUrl, checks);
  await runOutboxOrderingChecks(session.page, session.baseUrl, checks);
  await runOutboxSendRaceCheck(session.page, session.baseUrl, checks);
  await runOutboxRegressionChecks(session.page, session.baseUrl, checks);
  await runOutboxAnswerFlowChecks(session.page, session.baseUrl, checks);
  await runOutboxFailureChecks(session.page, session.baseUrl, checks);
} finally {
  // a browser we could not reap is a failed run, not a footnote under passing checks
  await session.close().catch((err) => { cleanupError = err; });
}

console.log(checks.report());
console.log(`\n${checks.summary}`);
if (cleanupError) {
  const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  console.error(`\ncleanup failed: ${message}`);
}
process.exit(checks.failed || cleanupError ? 1 : 0);
