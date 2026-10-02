export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Manually controlled clock for tests and simulations. */
export class FakeClock implements Clock {
  private t: number;

  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.t);
  }

  set(d: Date | string): void {
    this.t = new Date(d).getTime();
  }

  advance(ms: number): void {
    this.t += ms;
  }

  /** A Sleep that advances this clock instead of waiting. */
  readonly sleep: Sleep = async (ms) => {
    this.advance(ms);
  };
}
