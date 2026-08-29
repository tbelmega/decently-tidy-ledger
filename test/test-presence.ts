import type { Worker } from "../src/workers.ts";

export function buildPresenceFixture(now: Date = new Date()): Worker[] {
  const seen = now.toISOString();
  const older = new Date(now.getTime() - 95 * 60_000).toISOString();
  return [
    { name: "worker-a", reachable: true, lastSeenAt: seen, flags: ["cleared", "capable"], projects: ["alpha"], unreconciled: 0 },
    { name: "worker-b", reachable: true, lastSeenAt: seen, flags: ["cleared", "capable"], projects: ["beta"], unreconciled: 1 },
    { name: "worker-c", reachable: true, lastSeenAt: seen, flags: ["cleared", "capable"], projects: [], unreconciled: 0 },
    { name: "worker-d", reachable: true, lastSeenAt: seen, flags: ["cleared", "capable", "no-dispatch"], projects: ["alpha"], unreconciled: 0 },
    { name: "worker-e", reachable: true, lastSeenAt: seen, flags: ["cleared"], projects: [], unreconciled: 0 },
    { name: "worker-f", reachable: false, lastSeenAt: older, flags: ["cleared", "capable"], projects: ["beta"], unreconciled: 1 },
    { name: "worker-g", reachable: false, flags: ["cleared", "capable"], projects: [], unreconciled: 0 },
  ];
}
