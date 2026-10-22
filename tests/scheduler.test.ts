import { describe, expect, it } from "vitest";
import { collectDueSchedules, nextRunAt } from "../src/engine/scheduler";
import type { Schedule } from "../src/shared/types";
const schedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  id: "s1",
  flowId: "flow",
  name: "Schedule",
  enabled: true,
  kind: "daily",
  time: "09:00",
  timezone: "Australia/Sydney",
  intervalMinutes: 15,
  weekdays: [1],
  inputs: {},
  ...overrides,
});

describe("timezone-aware schedule calculations", () => {
  it("handles Sydney daylight saving changes in civil time", () => {
    expect(
      nextRunAt(schedule(), new Date("2026-10-03T00:00:00Z"))?.toISOString(),
    ).toBe("2026-10-03T22:00:00.000Z");
    expect(
      nextRunAt(schedule(), new Date("2026-06-01T00:00:00Z"))?.toISOString(),
    ).toBe("2026-06-01T23:00:00.000Z");
  });
  it("skips missing local times and does not duplicate a repeated local time", () => {
    const early = schedule({ time: "02:30" });
    expect(
      nextRunAt(early, new Date("2026-10-03T16:00:00Z"))?.toISOString(),
    ).toBe("2026-10-04T15:30:00.000Z");
    expect(
      nextRunAt(early, new Date("2026-04-04T14:00:00Z"))?.toISOString(),
    ).toBe("2026-04-04T15:30:00.000Z");
    expect(
      nextRunAt(early, new Date("2026-04-04T15:31:00Z"))?.toISOString(),
    ).toBe("2026-04-05T16:30:00.000Z");
  });
  it("supports weekly weekdays, intervals, once and disabled schedules", () => {
    expect(
      nextRunAt(
        schedule({ kind: "weekly" }),
        new Date("2026-10-20T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-10-25T22:00:00.000Z");
    expect(
      nextRunAt(
        schedule({ kind: "interval", lastRunAt: "2026-10-20T00:00:00Z" }),
        new Date("2026-10-20T01:03:00Z"),
      )?.toISOString(),
    ).toBe("2026-10-20T01:15:00.000Z");
    expect(
      nextRunAt(
        schedule({ kind: "once", time: "2026-10-22T00:00:00Z" }),
        new Date("2026-10-21T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-10-22T00:00:00.000Z");
    expect(nextRunAt(schedule({ enabled: false }))).toBeNull();
    expect(() => nextRunAt(schedule({ timezone: "Mars/Crater" }))).toThrow();
  });
  it("interprets once datetime-local input in the selected timezone, independent of the host", () => {
    expect(
      nextRunAt(
        schedule({ kind: "once", time: "2026-10-22T09:30" }),
        new Date("2026-10-21T00:00:00Z"),
      )?.toISOString(),
    ).toBe("2026-10-21T22:30:00.000Z");
    expect(
      nextRunAt(
        schedule({ kind: "once", time: "2026-10-04T02:30" }),
        new Date("2026-10-01T00:00:00Z"),
      ),
    ).toBeNull();
    expect(() =>
      nextRunAt(schedule({ kind: "once", time: "2026-02-30T09:30" })),
    ).toThrow("Invalid schedule date");
  });
});

describe("due schedules", () => {
  const now = new Date("2026-10-21T00:00:05Z");
  const previous = new Date("2026-10-20T23:59:55Z");
  const due = schedule({ kind: "interval", nextRunAt: "2026-10-21T00:00:00Z" });
  it("submits current occurrences once and advances their persisted cursor", () => {
    const result = collectDueSchedules([due], [], now, previous);
    expect(result.due).toHaveLength(1);
    expect(result.schedules[0].lastRunAt).toBe(now.toISOString());
    expect(
      collectDueSchedules(
        result.schedules,
        [],
        new Date("2026-10-21T00:00:10Z"),
        now,
      ).due,
    ).toEqual([]);
    expect(due.lastRunAt).toBeUndefined();
  });
  it("skips missed occurrences after startup/sleep, and active flow overlaps", () => {
    expect(collectDueSchedules([due], [], now, now).skipped[0].reason).toBe(
      "missed",
    );
    expect(
      collectDueSchedules([due], [], now, new Date("2026-10-20T20:00:00Z")).due,
    ).toEqual([]);
    expect(
      collectDueSchedules([due], ["flow"], now, previous).skipped[0].reason,
    ).toBe("overlapping");
    const two = collectDueSchedules(
      [due, { ...due, id: "s2" }],
      [],
      now,
      previous,
    );
    expect(two.due).toHaveLength(1);
    expect(two.skipped[0].reason).toBe("overlapping");
  });
  it("disables once occurrences after execution or a miss", () => {
    const once = { ...due, kind: "once" as const, time: due.nextRunAt! };
    expect(
      collectDueSchedules([once], [], now, previous).schedules[0].enabled,
    ).toBe(false);
    expect(collectDueSchedules([once], [], now, now).schedules[0].enabled).toBe(
      false,
    );
  });
});
