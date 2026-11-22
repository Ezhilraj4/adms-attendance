import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { resolveCompanyScope } from "../middleware/requireAdminAuth";
import {
  isValidTimeZone,
  zonedWallClockNow,
  zonedWallClockToUtc,
} from "../adms/timezone";
import { shiftWindow, summarizeDay } from "../utils/dailyAttendance";
import { getOrCreatePlatformSettings } from "../utils/retention";

export const attendanceRouter = Router();
// Express 4 needs explicit rejection forwarding for all asynchronous routes.
const route =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
function companyScope(req: Request, res: Response): string | null {
  const scope = resolveCompanyScope(
    req,
    typeof req.query.companyId === "string" ? req.query.companyId : undefined,
  );
  if (scope.all) {
    res.status(400).json({ error: "Select a company" });
    return null;
  }
  return scope.companyId;
}
const settingsFor = (companyId: string) =>
  prisma.attendanceSettings.upsert({
    where: { companyId },
    create: { companyId },
    update: {},
  });
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const settingsSchema = z
  .object({
    timezone: z.string().refine(isValidTimeZone, "Choose a valid timezone"),
    shift1Start: time,
    shift1End: time,
    shift2Start: time,
    shift2End: time,
    earlyMinutes: z.number().int().min(0).max(360),
    afterMinutes: z.number().int().min(0).max(360),
    graceMinutes: z.number().int().min(0).max(180),
  })
  .superRefine((s, ctx) => {
    const minutes = (v: string) =>
      Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
    for (const shift of [1, 2] as const) {
      const start = shift === 1 ? s.shift1Start : s.shift2Start;
      const end = shift === 1 ? s.shift1End : s.shift2End;
      const duration = (minutes(end) - minutes(start) + 1440) % 1440;
      if (!duration || duration + s.earlyMinutes + s.afterMinutes > 1440)
        ctx.addIssue({
          code: "custom",
          message: `Shift ${shift}: choose different start/end times and keep the total punch window within 24 hours`,
        });
    }
  });

attendanceRouter.get(
  "/settings",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({ settings: await settingsFor(companyId) });
  }),
);
attendanceRouter.patch(
  "/settings",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0].message });
      return;
    }
    if (!(await prisma.company.findUnique({ where: { id: companyId } }))) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json({
      settings: await prisma.attendanceSettings.upsert({
        where: { companyId },
        create: { companyId, ...parsed.data },
        update: parsed.data,
      }),
    });
  }),
);
attendanceRouter.get(
  "/employees",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    res.json({
      employees: await prisma.employee.findMany({
        where: { companyId },
        orderBy: [{ name: "asc" }, { pin: "asc" }],
        select: { id: true, name: true, pin: true, shift: true, active: true },
      }),
    });
  }),
);
attendanceRouter.patch(
  "/employees/:id",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    const parsed = z
      .object({
        shift: z.union([z.literal(1), z.literal(2)]).optional(),
        active: z.boolean().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Choose shift 1 or 2 and a valid active status" });
      return;
    }
    const result = await prisma.employee.updateMany({
      where: { id: req.params.id, companyId },
      data: parsed.data,
    });
    if (!result.count) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }
    res.json({ ok: true });
  }),
);
attendanceRouter.get(
  "/daily",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const settings = await settingsFor(companyId);
    const now = new Date();
    const date =
      typeof req.query.date === "string"
        ? req.query.date
        : zonedWallClockNow(settings.timezone, now).toISOString().slice(0, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    ) {
      res.status(400).json({ error: "Choose a valid date" });
      return;
    }
    const windows = [
      shiftWindow(date, 1, settings),
      shiftWindow(date, 2, settings),
    ];
    const from = new Date(Math.min(...windows.map((w) => w.from.getTime())));
    const to = new Date(Math.max(...windows.map((w) => w.to.getTime())));
    const [employees, records, platform] = await Promise.all([
      prisma.employee.findMany({
        where: { companyId, active: true },
        orderBy: [{ name: "asc" }, { pin: "asc" }],
      }),
      prisma.punchRecord.findMany({
        where: {
          device: { companyId },
          OR: [
            { punchTimeUtc: { gte: from, lt: to } },
            {
              punchTimeUtc: null,
              punchTime: {
                gte: new Date(from.getTime() - 86400000),
                lt: new Date(to.getTime() + 86400000),
              },
            },
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
    ]);
    const grouped = new Map<
      string,
      { id: string; time: Date; device: string; status: number }[]
    >();
    for (const p of records) {
      const list = grouped.get(p.devicePin) ?? [];
      list.push({
        id: p.id,
        time:
          p.punchTimeUtc ?? zonedWallClockToUtc(p.punchTime, p.device.timezone),
        device: p.device.label ?? p.device.serialNumber,
        status: p.status,
      });
      grouped.set(p.devicePin, list);
    }
    const cutoff = now.getTime() - platform.dataRetentionDays * 86400000;
    const rows = employees.map((e) => {
      const window = windows[e.shift - 1];
      const punches = (grouped.get(e.pin) ?? [])
        .filter((p) => p.time >= window.from && p.time < window.to)
        .sort((a, b) => a.time.getTime() - b.time.getTime());
      const unavailable =
        window.from.getTime() < cutoff ||
        date <
          zonedWallClockNow(settings.timezone, e.createdAt)
            .toISOString()
            .slice(0, 10);
      return {
        employeeId: e.id,
        name: e.name,
        pin: e.pin,
        shift: e.shift,
        ...summarizeDay(
          punches.map((p) => p.time),
          window,
          settings.graceMinutes,
          now,
          unavailable,
        ),
        shiftStart: window.start.toISOString(),
        shiftEnd: window.end.toISOString(),
        punches: punches.map((p) => ({ ...p, time: p.time.toISOString() })),
      };
    });
    const knownPins = new Set(employees.map((e) => e.pin));
    const unknownPins = [
      ...new Set(
        records
          .filter((p) => !knownPins.has(p.devicePin))
          .map((p) => p.devicePin),
      ),
    ];
    const summary = {
      total: rows.length,
      present: 0,
      absent: 0,
      pending: 0,
      unavailable: 0,
    };
    for (const row of rows)
      summary[row.status as "present" | "absent" | "pending" | "unavailable"]++;
    res.json({
      date,
      timezone: settings.timezone,
      rows,
      summary,
      unknownPins,
      retentionDays: platform.dataRetentionDays,
    });
  }),
);
