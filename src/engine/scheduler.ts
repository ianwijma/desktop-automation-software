import type { Schedule } from "../shared/types";

interface CivilDate {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function civil(date: Date, timezone: string): CivilDate {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  return Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as unknown as CivilDate;
}
function epoch(parts: CivilDate): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

/** Resolve wall time using the offsets around the day. Missing DST wall times are skipped;
 * repeated wall times fire once, at their first occurrence. */
function wallInstant(parts: CivilDate, timezone: string): Date | null {
  const wall = epoch(parts);
  const offsets = new Set<number>();
  for (let hour = -48; hour <= 48; hour += 6) {
    const probe = wall + hour * 3600000;
    offsets.add(epoch(civil(new Date(probe), timezone)) - probe);
  }
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => epoch(civil(new Date(instant), timezone)) === wall)
    .sort((a, b) => a - b);
  return candidates.length ? new Date(candidates[0]) : null;
}

/** The next occurrence strictly after `after`. No missed occurrence is replayed. */
export function nextRunAt(
  schedule: Schedule,
  after: Date = new Date(),
): Date | null {
  if (!schedule.enabled || !Number.isFinite(after.getTime())) return null;
  if (schedule.kind === "once") {
    const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
      schedule.time,
    );
    let at: Date | null;
    if (local) {
      const parts = {
        year: Number(local[1]),
        month: Number(local[2]),
        day: Number(local[3]),
        hour: Number(local[4]),
        minute: Number(local[5]),
        second: Number(local[6] ?? 0),
      };
      const normalized = new Date(epoch(parts));
      if (
        normalized.getUTCFullYear() !== parts.year ||
        normalized.getUTCMonth() + 1 !== parts.month ||
        normalized.getUTCDate() !== parts.day ||
        parts.hour > 23 ||
        parts.minute > 59 ||
        parts.second > 59
      )
        throw new Error("Invalid schedule date and time");
      at = wallInstant(parts, schedule.timezone);
    } else {
      if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(schedule.time))
        throw new Error("Once schedule needs a date and time");
      at = new Date(schedule.time);
    }
    return !schedule.lastRunAt &&
      at &&
      Number.isFinite(at.getTime()) &&
      at > after
      ? at
      : null;
  }
  if (schedule.kind === "interval") {
    const duration = schedule.intervalMinutes * 60000;
    if (!Number.isFinite(duration) || duration < 60000)
      throw new Error("Schedule interval must be at least one minute");
    const anchor = new Date(
      schedule.lastRunAt ?? schedule.nextRunAt ?? after.toISOString(),
    ).getTime();
    if (!Number.isFinite(anchor))
      throw new Error("Invalid schedule interval anchor");
    const elapsed = Math.max(
      0,
      Math.floor((after.getTime() - anchor) / duration) + 1,
    );
    return new Date(anchor + elapsed * duration);
  }
  if (schedule.kind !== "daily" && schedule.kind !== "weekly")
    throw new Error("Unsupported schedule kind");
  const match = /^(\d{2}):(\d{2})$/.exec(schedule.time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error("Schedule time must be HH:mm");
  if (
    schedule.kind === "weekly" &&
    (!schedule.weekdays.length ||
      schedule.weekdays.some(
        (day) => !Number.isInteger(day) || day < 0 || day > 6,
      ))
  )
    throw new Error(
      "Weekly schedule needs weekdays from 0 (Sunday) through 6 (Saturday)",
    );
  const today = civil(after, schedule.timezone);
  for (let offset = 0; offset < 370; offset++) {
    const day = new Date(
      Date.UTC(today.year, today.month - 1, today.day + offset),
    );
    if (
      schedule.kind === "weekly" &&
      !schedule.weekdays.includes(day.getUTCDay())
    )
      continue;
    const result = wallInstant(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour: Number(match[1]),
        minute: Number(match[2]),
        second: 0,
      },
      schedule.timezone,
    );
    if (result && result > after) return result;
  }
  return null;
}

export interface DueScheduleResult {
  due: Schedule[];
  /** Updated schedule copies to persist, including skipped occurrences. */
  schedules: Schedule[];
  skipped: {
    scheduleId: string;
    reason: "missed" | "overlapping" | "invalid";
  }[];
}
/** Poll helper. Passing lastCheckAt=now on startup skips offline occurrences.
 * A gap longer than 60 seconds is treated as suspension, with no catch-up runs. */
export function collectDueSchedules(
  schedules: Schedule[],
  activeFlowIds: ReadonlySet<string> | readonly string[],
  now: Date = new Date(),
  lastCheckAt: Date = now,
): DueScheduleResult {
  const active = new Set(activeFlowIds);
  const due: Schedule[] = [];
  const skipped: DueScheduleResult["skipped"] = [];
  const updated = schedules.map((original) => {
    const schedule = structuredClone(original);
    if (!schedule.enabled) return schedule;
    try {
      if (!schedule.nextRunAt) {
        schedule.nextRunAt = nextRunAt(schedule, now)?.toISOString();
        if (schedule.kind === "once" && !schedule.nextRunAt) {
          schedule.enabled = false;
          skipped.push({ scheduleId: schedule.id, reason: "missed" });
        }
        return schedule;
      }
      const at = new Date(schedule.nextRunAt).getTime();
      if (!Number.isFinite(at)) throw new Error("Invalid next occurrence");
      if (at > now.getTime()) return schedule;
      const missed =
        at <= lastCheckAt.getTime() ||
        now.getTime() - lastCheckAt.getTime() > 60000 ||
        now.getTime() - at > 60000;
      if (missed) skipped.push({ scheduleId: schedule.id, reason: "missed" });
      else if (active.has(schedule.flowId))
        skipped.push({ scheduleId: schedule.id, reason: "overlapping" });
      else {
        due.push(structuredClone(schedule));
        active.add(schedule.flowId);
        schedule.lastRunAt = now.toISOString();
      }
      if (schedule.kind === "once") {
        schedule.enabled = false;
        schedule.nextRunAt = undefined;
      } else schedule.nextRunAt = nextRunAt(schedule, now)?.toISOString();
    } catch {
      skipped.push({ scheduleId: schedule.id, reason: "invalid" });
      schedule.enabled = false;
      schedule.nextRunAt = undefined;
    }
    return schedule;
  });
  return { due, schedules: updated, skipped };
}
