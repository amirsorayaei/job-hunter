/** Istanbul is UTC+3 all year (no DST since 2016). */
export const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch ms of 00:00 Istanbul on the day containing `ms`. */
export function istanbulDayStart(ms: number): number {
  return Math.floor((ms + ISTANBUL_OFFSET_MS) / DAY_MS) * DAY_MS - ISTANBUL_OFFSET_MS;
}

/** "2026-11-10" for the Istanbul day containing `ms`. */
export function istanbulDate(ms: number): string {
  return new Date(ms + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}
