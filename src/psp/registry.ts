import type { PspAdapter } from './types.js';

/** Lookup of configured PSP adapters, for services that talk to PSPs outside the router. */
export class PspRegistry {
  private readonly adapters: Map<string, PspAdapter>;

  constructor(adapters: PspAdapter[]) {
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
  }

  get(id: string): PspAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown PSP ${id}`);
    return a;
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }
}
