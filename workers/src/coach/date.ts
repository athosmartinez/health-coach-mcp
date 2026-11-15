// Local calendar days and the zone that defines them (Go: internal/coach/date.go).

/** A calendar day, YYYY-MM-DD, in the configured time zone. Validate with {@link parseDate}. */
export type LocalDate = string;

/** JSON schema pattern of a LocalDate. Calendar validity (no Feb 30) is checked by {@link parseDate}. */
export const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Epoch milliseconds of a UTC civil time. Unlike Date.UTC, years below 100 stay as given. */
function utcMs(year: number, month: number, day: number): number {
  const t = new Date(0);
  t.setUTCFullYear(year, month - 1, day);
  return t.getTime();
}

function formatDay(ms: number): LocalDate {
  const t = new Date(ms);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The civil day of `s` as UTC midnight, or undefined when `s` is not a real calendar date. */
function civil(s: string): number | undefined {
  const match = DATE.exec(s);
  if (!match) return undefined;
  const ms = utcMs(Number(match[1]), Number(match[2]), Number(match[3]));
  // A day that does not exist (Feb 30, month 13) rolls over to another date.
  return formatDay(ms) === s ? ms : undefined;
}

/** Returns `s` when it is a real calendar date, else undefined. */
export function parseDate(s: string): LocalDate | undefined {
  return civil(s) === undefined ? undefined : s;
}

/** An IANA time zone. `new Zone(name)` throws a RangeError for an unknown name. */
export class Zone {
  // UTC needs no zone data, and building an Intl formatter is the costly part
  // of a zone: UTC is used on every profile update and at module load.
  private readonly format: Intl.DateTimeFormat | undefined;

  constructor(readonly name: string) {
    if (name === "UTC") return;
    this.format = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  /** The wall clock of the instant in this zone, read as if it were UTC. */
  private wall(ms: number): number {
    if (!this.format) return Math.floor(ms / 1000) * 1000;
    const part: Record<string, number> = {};
    for (const { type, value } of this.format.formatToParts(ms)) part[type] = Number(value);
    return (
      utcMs(part.year ?? 0, part.month ?? 1, part.day ?? 1) +
      ((part.hour ?? 0) * 3600 + (part.minute ?? 0) * 60 + (part.second ?? 0)) * 1000
    );
  }

  /** Offset from UTC at the instant, in milliseconds (zone offsets are whole seconds). */
  offsetMs(ms: number): number {
    return this.wall(ms) - Math.floor(ms / 1000) * 1000;
  }

  /** The local calendar day the instant falls on. */
  dateOf(ms: number): LocalDate {
    return formatDay(this.wall(ms));
  }
}

export const UTC = new Zone("UTC");

/** The local calendar day that `t` falls on. */
export function dateOf(t: Date, zone: Zone): LocalDate {
  return zone.dateOf(t.getTime());
}

/** The local day at instant `now`. */
export const today = dateOf;

/** A sleep session belongs to the local day it ends on. */
export const sleepDay = dateOf;

/**
 * The first instant of a local day. When DST starts at 00:00 that midnight does
 * not exist and the offset lookup can land on 23:00 of the day before, so step
 * forward to the transition (zone changes fall on minute boundaries).
 */
function startOfDay(dayMs: number, zone: Zone): number {
  let t = dayMs - zone.offsetMs(dayMs);
  // The first offset was read at the wall time taken as UTC; near a transition
  // the instant found belongs to another offset.
  const offset = zone.offsetMs(t);
  if (dayMs - offset !== t) t = dayMs - offset;
  const want = formatDay(dayMs);
  for (let i = 0; i < 24 * 60 && zone.dateOf(t) !== want; i++) t += 60_000;
  return t;
}

/**
 * [start, end) of the day in `zone`, or undefined when `d` is not a real date.
 * Local midnights are used instead of adding 24 h, so a DST day is 23 h or 25 h
 * long and consecutive days never overlap.
 */
export function bounds(d: LocalDate, zone: Zone): { start: Date; end: Date } | undefined {
  const day = civil(d);
  if (day === undefined) return undefined;
  return { start: new Date(startOfDay(day, zone)), end: new Date(startOfDay(day + 86_400_000, zone)) };
}

/**
 * The instant of the wall time `hour`:`minute` on the local day `d`, or
 * undefined when `d` is not a real date or the time is not on a 24-hour clock.
 *
 * On the day of a DST change a wall time can be missing, or can happen twice.
 * A time that the change skips reads as the first instant after the gap: the
 * rule of the start of a day whose midnight does not exist (startOfDay). A
 * time that happens twice reads as the first of its two instants, as the
 * start of a day is its first instant.
 */
export function instantOf(d: LocalDate, hour: number, minute: number, zone: Zone): Date | undefined {
  const day = civil(d);
  if (day === undefined) return undefined;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  const wall = day + (hour * 60 + minute) * 60_000;
  // A zone is at most 14 hours from UTC, so the instant lies within a day of
  // `wall` read as UTC. The offsets a day before and a day after it are the
  // ones on each side of a change near it.
  const candidates = [wall - zone.offsetMs(wall - 86_400_000), wall - zone.offsetMs(wall + 86_400_000)];
  const real = candidates.filter((t) => t + zone.offsetMs(t) === wall);
  if (real.length > 0) return new Date(Math.min(...real));
  // No instant shows this wall time. The earlier candidate lies before the
  // change: step forward to it (zone changes fall on minute boundaries).
  let t = Math.min(...candidates);
  const before = zone.offsetMs(t);
  for (let i = 0; i < 24 * 60 && zone.offsetMs(t) === before; i++) t += 60_000;
  return new Date(t);
}

/** The date `n` days later (negative `n` goes back), or undefined when `d` is not a real date. */
export function addDays(d: LocalDate, n: number): LocalDate | undefined {
  const day = civil(d);
  return day === undefined ? undefined : formatDay(day + n * 86_400_000);
}
