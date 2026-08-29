import { describe, expect, test } from "bun:test";
import { PresenceProviderRegistry, type PresenceProvider } from "../src/presence.ts";

const provider: PresenceProvider = {
  name: "example",
  read: (now) => ({
    readAt: now.toISOString(), sweptAt: "2026-08-29T00:00:00Z", sweptFrom: "dispatcher",
    source: "example", workers: [],
  }),
};

describe("PresenceProviderRegistry", () => {
  test("has no active provider until local configuration registers one", () => {
    const registry = new PresenceProviderRegistry();
    expect(registry.active()).toBeUndefined();
    registry.register(provider);
    expect(registry.active()).toBe(provider);
  });

  test("refuses ambiguous local configuration", () => {
    const registry = new PresenceProviderRegistry();
    registry.register(provider);
    expect(() => registry.register({ ...provider, name: "another" })).toThrow(/one presence provider/i);
  });
});
