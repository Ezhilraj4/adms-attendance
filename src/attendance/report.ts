import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { zonedWallClockNow, zonedWallClockToUtc } from "../adms/timezone";
import { ShiftSettings, shiftWindow } from "../utils/dailyAttendance";
import {
  analyzeAttendance,
  AttendancePunch,
  DutyKind,
} from "../utils/attendanceAnalysis";
import { getOrCreatePlatformSettings } from "../utils/retention";

export const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
export const nextDate = (date: string, days = 1) =>
  new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
export const localDate = (timezone: string, now = new Date()) =>
  zonedWallClockNow(timezone, now).toISOString().slice(0, 10);
export const normalizeSettings = (
  s: ShiftSettings,
): Required<ShiftSettings> => ({
  timezone: s.timezone,
  shift1Start: s.shift1Start,
  shift1End: s.shift1End,
  shift2Start: s.shift2Start,
  shift2End: s.shift2End,
  earlyMinutes: s.earlyMinutes,
  afterMinutes: s.afterMinutes,
  graceMinutes: s.graceMinutes,
  overtimeThresholdMinutes: s.overtimeThresholdMinutes ?? 30,
  maxOvertimeMinutes: s.maxOvertimeMinutes ?? 480,
  doubleShiftMinMinutes: s.doubleShiftMinMinutes ?? 240,
  overtimeMode: s.overtimeMode ?? "paired",
});
export const settingsFor = (companyId: string) =>
  prisma.attendanceSettings.upsert({
    where: { companyId },
    create: { companyId },
    update: {},
  });
export async function settingsAt(companyId: string, date: string) {
  const base = await settingsFor(companyId);
  const version = await prisma.attendanceSettingVersion.findFirst({
    where: { companyId, effectiveFrom: { lte: date } },
    orderBy: { effectiveFrom: "desc" },
  });
  return normalizeSettings(
    version ? (version.config as unknown as ShiftSettings) : base,
  );
}

export async function attendanceRows(
  companyId: string,
  dates: string[],
  employeeId?: string,
  persist = true,
) {
  const now = new Date();
  const base = await settingsFor(companyId);
  const first = dates[0],
    last = dates[dates.length - 1];
  const from = new Date(Date.parse(first) - 2 * 86400000),
    to = new Date(Date.parse(last) + 3 * 86400000);
  const [employees, versions, records, platform, snapshots] = await Promise.all(
    [
      prisma.employee.findMany({
        where: { companyId, ...(employeeId ? { id: employeeId } : {}) },
        include: {
          assignments: { orderBy: { effectiveFrom: "desc" } },
          duties: { where: { date: { gte: first, lte: nextDate(last) } } },
        },
        orderBy: [{ name: "asc" }, { pin: "asc" }],
      }),
      prisma.attendanceSettingVersion.findMany({
        where: { companyId },
        orderBy: { effectiveFrom: "desc" },
      }),
      prisma.punchRecord.findMany({
        where: {
          device: { companyId },
          OR: [
            { punchTimeUtc: { gte: from, lt: to } },
            { punchTimeUtc: null, punchTime: { gte: from, lt: to } },
          ],
        },
        select: {
          id: true,
          devicePin: true,
          punchTime: true,
          punchTimeUtc: true,
          status: true,
          device: {
            select: { label: true, serialNumber: true, timezone: true },
          },
        },
      }),
      getOrCreatePlatformSettings(prisma),
      prisma.attendanceDay.findMany({
        where: {
          employee: { companyId, ...(employeeId ? { id: employeeId } : {}) },
          date: { gte: first, lte: last },
        },
      }),
    ],
  );
  const configAt = (date: string) =>
    normalizeSettings(
      (versions.find((v) => v.effectiveFrom <= date)
        ?.config as unknown as ShiftSettings) ?? base,
    );
  const snapshotMap = new Map(
    snapshots.map((s) => [`${s.employeeId}:${s.date}`, s]),
  );
  const byPin = new Map<string, AttendancePunch[]>();
  for (const p of records) {
    const list = byPin.get(p.devicePin) ?? [];
    list.push({
      id: p.id,
      time: (
        p.punchTimeUtc ?? zonedWallClockToUtc(p.punchTime, p.device.timezone)
      ).toISOString(),
      status: p.status,
      device: p.device.label ?? p.device.serialNumber,
    });
    byPin.set(p.devicePin, list);
  }
  const rows = [];
  const archive: { employeeId: string; date: string; data: unknown }[] = [];
  for (const e of employees)
    for (const date of dates) {
      const settings = configAt(date);
      const assignment = e.assignments.find((a) => a.effectiveFrom <= date);
      const baseShift = assignment?.shift ?? e.shift;
      const active = assignment?.active ?? e.active;
      const duty = e.duties.find((d) => d.date === date);
      const kind = (duty?.kind ??
        (baseShift === 2 ? "SHIFT2" : "SHIFT1")) as DutyKind;
      const next = nextDate(date);
      // A later duty starts ownership of its own punches. This prevents a night
      // checkout or next-day arrival being counted twice across work dates.
      const nextSettings = configAt(next);
      const nextWindows = [
        shiftWindow(next, 1, nextSettings),
        shiftWindow(next, 2, nextSettings),
      ];
      const nextStart = Math.min(...nextWindows.map((w) => w.from.getTime()));
      const saved = snapshotMap.get(`${e.id}:${date}`)?.data as unknown as
        | { punches?: AttendancePunch[] }
        | undefined;
      const savedPunches = Array.isArray(saved?.punches) ? saved.punches : [];
      const punches = [...savedPunches, ...(byPin.get(e.pin) ?? [])];
      const unavailable =
        !saved &&
        (Date.parse(date) <
          now.getTime() - platform.dataRetentionDays * 86400000 ||
          date < localDate(settings.timezone, e.createdAt));
      const result = analyzeAttendance({
        date,
        baseShift,
        kind,
        punches,
        settings,
        now,
        unavailable,
        nextStart,
        approvedOvertimeMinutes: duty?.approvedOvertimeMinutes,
        note: duty?.note,
      });
      const previous =
        e.assignments.find((a) => a.effectiveFrom < date)?.shift ?? baseShift;
      const assignmentChanged =
        assignment?.effectiveFrom === date && assignment.shift !== previous;
      const row = {
        ...result,
        employeeId: e.id,
        name: e.name,
        pin: e.pin,
        active,
        status: !active && !duty ? "inactive" : result.status,
        dutyChanged: result.dutyChanged || assignmentChanged,
        dutyOverride: !!duty,
        timezone: settings.timezone,
      };
      rows.push(row);
      if (
        persist &&
        row.finalized &&
        row.active &&
        row.status !== "unavailable"
      )
        archive.push({
          employeeId: e.id,
          date,
          data: { punches: row.punches, result: row, settings },
        });
    }
  // Durable summaries and punch times survive the raw-log retention sweep.
  // Parameterized batches avoid one database round trip per employee/day.
  for (let offset = 0; offset < archive.length; offset += 100) {
    const values = archive
      .slice(offset, offset + 100)
      .map(
        (a) =>
          Prisma.sql`(${randomUUID()}, ${a.employeeId}, ${a.date}, ${JSON.stringify(a.data)}::jsonb, now())`,
      );
    await prisma.$executeRaw(
      Prisma.sql`INSERT INTO attendance_days (id, "employeeId", date, data, "updatedAt") VALUES ${Prisma.join(values)} ON CONFLICT ("employeeId", date) DO UPDATE SET data=EXCLUDED.data,"updatedAt"=now() WHERE attendance_days.data IS DISTINCT FROM EXCLUDED.data`,
    );
  }
  const knownPins = new Set(employees.map((e) => e.pin));
  return {
    rows,
    retentionDays: platform.dataRetentionDays,
    timezone: configAt(first).timezone,
    unknownPins: [
      ...new Set(
        records
          .filter((p) => !knownPins.has(p.devicePin))
          .map((p) => p.devicePin),
      ),
    ],
  };
}
export function summarizeMonth(
  days: Awaited<ReturnType<typeof attendanceRows>>["rows"],
) {
  const present = days.filter((d) => d.status === "present");
  return {
    workedDays: present.length,
    absentDays: days.filter((d) => d.status === "absent").length,
    pendingDays: days.filter((d) => d.status === "pending").length,
    offDays: days.filter((d) => d.status === "off").length,
    leaveDays: days.filter((d) => d.status === "leave").length,
    noDataDays: days.filter((d) => d.status === "unavailable").length,
    workedMinutes: present.reduce((n, d) => n + (d.workedMinutes ?? 0), 0),
    estimatedOvertimeMinutes: present.reduce(
      (n, d) => n + d.overtimeMinutes,
      0,
    ),
    approvedOvertimeMinutes: days.reduce(
      (n, d) => n + (d.approvedOvertimeMinutes ?? 0),
      0,
    ),
    doubleShiftDays: present.filter(
      (d) => d.doubleShiftWorked,
    ).length,
    possibleDoubleShiftDays: present.filter((d) => d.possibleDoubleShift)
      .length,
    dutyChangeDays: days.filter((d) => d.active && d.dutyChanged).length,
    reviewDays: days.filter((d) => d.active && d.needsReview).length,
    finalizedDays: days.filter(
      (d) => d.active && d.finalized && d.status !== "unavailable",
    ).length,
  };
}

export async function archiveRecentAttendance() {
  const companies = await prisma.$queryRaw<
    { id: string }[]
  >`SELECT c.id FROM companies c LEFT JOIN attendance_archive_state s ON s."companyId"=c.id WHERE EXISTS (SELECT 1 FROM employees e WHERE e."companyId"=c.id) ORDER BY COALESCE(s."checkedAt", '1970-01-01'::timestamp) ASC LIMIT 1`;
  const companyId = companies[0]?.id;
  if (!companyId) return;
  const settings = await settingsFor(companyId);
  const today = localDate(settings.timezone);
  await attendanceRows(companyId, [nextDate(today, -2), nextDate(today, -1)]);
  await prisma.attendanceArchiveState.upsert({
    where: { companyId },
    create: { companyId },
    update: { checkedAt: new Date() },
  });
}
