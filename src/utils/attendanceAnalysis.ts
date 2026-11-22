import { ShiftSettings, shiftWindow } from "./dailyAttendance";

export interface AttendancePunch {
  id: string;
  time: string;
  status: number;
  device: string;
}
export type DutyKind = "SHIFT1" | "SHIFT2" | "DOUBLE" | "OFF" | "LEAVE";
type Interval = { start: number; end: number };
const minute = 60000;
function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const i of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = result[result.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else result.push({ ...i });
  }
  return result;
}
function overlap(intervals: Interval[], bounds: Interval[]) {
  let total = 0;
  for (const a of union(intervals))
    for (const b of union(bounds))
      total += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return Math.floor(total / minute);
}

export function analyzeAttendance(input: {
  date: string;
  baseShift: number;
  kind: DutyKind;
  punches: AttendancePunch[];
  settings: ShiftSettings;
  now: Date;
  unavailable: boolean;
  nextStart?: number;
  approvedOvertimeMinutes?: number | null;
  note?: string;
}) {
  const { date, settings, kind, baseShift, now } = input;
  const windows = [
    shiftWindow(date, 1, settings),
    shiftWindow(date, 2, settings),
  ];
  const selected =
    kind === "DOUBLE"
      ? windows
      : kind === "SHIFT1"
        ? [windows[0]]
        : kind === "SHIFT2"
          ? [windows[1]]
          : [];
  const base = windows[baseShift - 1];
  const start = Math.min(
    ...(selected.length ? selected : [base]).map((w) => w.start.getTime()),
  );
  const end = Math.max(
    ...(selected.length ? selected : [base]).map((w) => w.end.getTime()),
  );
  const cap = (settings.maxOvertimeMinutes ?? 480) * minute;
  const from = Math.min(...windows.map((w) => w.from.getTime()));
  const dayEnd = Math.max(...windows.map((w) => w.end.getTime()));
  const closeAt =
    input.nextStart ??
    Math.max(dayEnd + Math.max(cap, settings.afterMinutes * minute), end);
  const unique = new Map(
    input.punches
      .filter((p) => Date.parse(p.time) >= from && Date.parse(p.time) < closeAt)
      .map((p) => [`${p.time}:${p.status}`, p]),
  );
  const all = [...unique.values()].sort(
    (a, b) => Date.parse(a.time) - Date.parse(b.time),
  );
  const punches = all.filter((p) => Date.parse(p.time) <= now.getTime());
  const reasons: string[] = [];
  if (all.length !== punches.length) reasons.push("Future-dated device punch");
  const sessions: Interval[] = [];
  let open: number | null = null;
  let unpaired = false;
  for (const p of punches) {
    const t = Date.parse(p.time);
    if (p.status === 0) {
      if (open !== null) unpaired = true;
      else open = t;
    } else if (p.status === 1 && open !== null) {
      if (t > open) sessions.push({ start: open, end: t });
      open = null;
    } else unpaired = true;
  }
  if (open !== null) unpaired = true;
  const first = punches[0] ?? null;
  const last = punches.length > 1 ? punches[punches.length - 1] : null;
  const span =
    first && last
      ? { start: Date.parse(first.time), end: Date.parse(last.time) }
      : null;
  let estimated = false;
  let intervals = sessions;
  if (settings.overtimeMode === "span" || (!sessions.length && span)) {
    intervals = span ? [span] : [];
    estimated = !!span;
  }
  if (unpaired && punches.length)
    reasons.push("Missing or unclear IN/OUT pair");
  if (estimated)
    reasons.push(
      "Hours estimated from first/last punch; breaks may be included",
    );
  const bounds = selected.map((w) => ({
    start: w.start.getTime(),
    end: w.end.getTime(),
  }));
  const workedMinutes = intervals.length
    ? overlap(intervals, [{ start: from, end: closeAt }])
    : null;
  const coveredMinutes = overlap(intervals, bounds);
  const coverage = windows.map((w) =>
    overlap(intervals, [{ start: w.start.getTime(), end: w.end.getTime() }]),
  );
  const minCoverage = settings.doubleShiftMinMinutes ?? 240;
  const sharedCoverage = overlap(intervals, [
    {
      start: Math.max(...windows.map((w) => w.start.getTime())),
      end: Math.min(...windows.map((w) => w.end.getTime())),
    },
  ]);
  const doubleShiftWorked = coverage.every((n) => n - sharedCoverage >= minCoverage);
  const possibleDoubleShift = kind !== "DOUBLE" && doubleShiftWorked;
  if (kind === "DOUBLE" && punches.length && !doubleShiftWorked) reasons.push("Scheduled double duty is not yet supported by enough punch coverage");
  const expectedShift =
    kind === "SHIFT2" ? 2 : kind === "SHIFT1" ? 1 : baseShift;
  const opposite = expectedShift === 1 ? 2 : 1;
  const oppositeWindow = windows[opposite - 1];
  const firstTime = first ? Date.parse(first.time) : 0;
  const firstInOtherShift =
    first &&
    first.status !== 1 &&
    firstTime >= oppositeWindow.start.getTime() &&
    firstTime < oppositeWindow.end.getTime() &&
    (firstTime < start - settings.earlyMinutes * minute ||
      firstTime > end + settings.graceMinutes * minute);
  const detectedShift =
    kind.startsWith("SHIFT") &&
    ((coverage[opposite - 1] >= 60 &&
      coverage[opposite - 1] > coverage[expectedShift - 1] &&
      coverage[expectedShift - 1] < minCoverage) ||
      firstInOtherShift) &&
    coverage[expectedShift - 1] < minCoverage
      ? opposite
      : null;
  if (possibleDoubleShift)
    reasons.push("Possible double shift; confirm this date's duty");
  if (detectedShift)
    reasons.push(
      `Different duty detected: shift ${detectedShift}; estimates use its times`,
    );
  if (first && !selected.length)
    reasons.push("Worked on a scheduled day off or leave");
  // Early arrivals are not automatically overtime. For two duties, exclude
  // each scheduled interval and any gap between them; only post-duty time counts.
  const actualEnd = detectedShift
    ? windows[detectedShift - 1].end.getTime()
    : end;
  const outsideAfter = selected.length
    ? overlap(intervals, [{ start: actualEnd, end: closeAt }])
    : (workedMinutes ?? 0);
  if (outsideAfter > (settings.maxOvertimeMinutes ?? 480))
    reasons.push("Overtime exceeds the configured daily limit");
  const overtimeMinutes =
    outsideAfter < (settings.overtimeThresholdMinutes ?? 30)
      ? 0
      : Math.min(outsideAfter, settings.maxOvertimeMinutes ?? 480);
  const status = first
    ? "present"
    : kind === "OFF"
      ? "off"
      : kind === "LEAVE"
        ? "leave"
        : input.unavailable
          ? "unavailable"
          : now.getTime() < dayEnd
            ? "pending"
            : "leave";
  const finalized = now.getTime() >= closeAt;
  if (!finalized && first)
    reasons.push("Shift/overtime recording window is still open");
  return {
    date,
    shift: kind === "SHIFT2" ? 2 : kind === "DOUBLE" ? 3 : baseShift,
    dutyKind: kind,
    baseShift,
    status,
    finalized,
    firstPunch: first?.time ?? null,
    lastPunch: last?.time ?? null,
    shiftStart: new Date(start).toISOString(),
    shiftEnd: new Date(end).toISOString(),
    closeAt: new Date(closeAt).toISOString(),
    punches,
    lateMinutes:
      first && selected.length
        ? Math.max(
            0,
            Math.floor(
              (Date.parse(first.time) -
                (detectedShift
                  ? windows[detectedShift - 1].start.getTime()
                  : start)) /
                minute,
            ) - settings.graceMinutes,
          )
        : 0,
    spanMinutes: span ? Math.floor((span.end - span.start) / minute) : null,
    workedMinutes,
    coveredMinutes,
    overtimeMinutes,
    approvedOvertimeMinutes: input.approvedOvertimeMinutes ?? null,
    estimatedHours: estimated,
    doubleShiftWorked,
    possibleDoubleShift,
    detectedShift,
    dutyChanged:
      !!detectedShift ||
      (kind === "SHIFT1" && baseShift !== 1) ||
      (kind === "SHIFT2" && baseShift !== 2) ||
      kind === "DOUBLE",
    reviewReasons: reasons,
    needsReview: reasons.length > 0,
    note: input.note ?? "",
  };
}
