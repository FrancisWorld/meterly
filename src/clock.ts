export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Test clock that only moves when told to. */
export class ManualClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current);
  }

  set(next: Date): void {
    this.current = new Date(next);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
