import type { Worker } from "./workers.ts";

export interface WorkersPayload {
  readAt: string;
  sweptAt: string;
  sweptFrom: string;
  source: string;
  workers: Worker[];
}

export interface PresenceProvider {
  readonly name: string;
  read(now: Date): WorkersPayload;
}

export class PresenceProviderRegistry {
  #provider?: PresenceProvider;

  register(provider: PresenceProvider): void {
    if (this.#provider) {
      throw new Error("only one presence provider may be configured");
    }
    this.#provider = provider;
  }

  active(): PresenceProvider | undefined {
    return this.#provider;
  }
}
