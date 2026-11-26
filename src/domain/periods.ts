/** Add calendar months in UTC, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsUtc(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(anchor.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

export interface Period {
  start: Date;
  end: Date;
}

/** Monthly period `index` of a subscription anchored at `anchor`. Computed from the anchor so clamping never drifts. */
export function periodAt(anchor: Date, index: number): Period {
  return { start: addMonthsUtc(anchor, index), end: addMonthsUtc(anchor, index + 1) };
}
