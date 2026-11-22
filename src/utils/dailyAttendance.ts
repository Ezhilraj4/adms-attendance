import { zonedWallClockToUtc } from "../adms/timezone";

export interface ShiftSettings {
  timezone: string;
  shift1Start: string;
  shift1End: string;
  shift2Start: string;
  shift2End: string;
  earlyMinutes: number;
  afterMinutes: number;
  graceMinutes: number;
}

export function shiftWindow(
  date: string,
  shift: number,
  settings: ShiftSettings,
) {
  const startTime = shift === 2 ? settings.shift2Start : settings.shift1Start;
  const endTime = shift === 2 ? settings.shift2End : settings.shift1End;
  const startWall = new Date(`${date}T${startTime}:00Z`);
  const endWall = new Date(`${date}T${endTime}:00Z`);
  if (endTime <= startTime) endWall.setUTCDate(endWall.getUTCDate() + 1);
  const start = zonedWallClockToUtc(startWall, settings.timezone);
  const end = zonedWallClockToUtc(endWall, settings.timezone);
  return {
    start,
    end,
    from: new Date(start.getTime() - settings.earlyMinutes * 60000),
    to: new Date(end.getTime() + settings.afterMinutes * 60000),
  };
}

export function summarizeDay(
  times: Date[],
  window: ReturnType<typeof shiftWindow>,
  graceMinutes: number,
  now: Date,
  unavailable: boolean,
) {
  const punches = times
    .filter((t) => t >= window.from && t < window.to)
    .sort((a, b) => a.getTime() - b.getTime());
  const first = punches[0] ?? null;
  const last = punches.length > 1 ? punches[punches.length - 1] : null;
  return {
    status: first
      ? "present"
      : unavailable
        ? "unavailable"
        : now < window.to
          ? "pending"
          : "absent",
    firstPunch: first?.toISOString() ?? null,
    lastPunch: last?.toISOString() ?? null,
    lateMinutes: first
      ? Math.max(
          0,
          Math.floor((first.getTime() - window.start.getTime()) / 60000) -
            graceMinutes,
        )
      : 0,
    spanMinutes:
      first && last
        ? Math.floor((last.getTime() - first.getTime()) / 60000)
        : null,
  };
}
