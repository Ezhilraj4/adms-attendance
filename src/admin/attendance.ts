import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../db/client";
import { resolveCompanyScope } from "../middleware/requireAdminAuth";
import { isValidTimeZone } from "../adms/timezone";
import {
  attendanceRows,
  settingsFor,
  settingsAt,
  localDate,
  validDate,
  summarizeMonth,
} from "../attendance/report";

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
const dateSchema = z.string().refine(validDate, "Choose a valid date");
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
    overtimeThresholdMinutes: z.number().int().min(0).max(240).default(30),
    maxOvertimeMinutes: z.number().int().min(0).max(720).default(480),
    doubleShiftMinMinutes: z.number().int().min(30).max(720).default(240),
    overtimeMode: z.enum(["paired", "span"]).default("paired"),
    effectiveFrom: dateSchema.optional(),
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
    const base = await settingsFor(companyId);
    const date =
      typeof req.query.date === "string"
        ? req.query.date
        : localDate(base.timezone);
    if (!validDate(date)) {
      res.status(400).json({ error: "Choose a valid date" });
      return;
    }
    res.json({
      settings: await settingsAt(companyId, date),
      effectiveFrom: date,
    });
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
    const old = await settingsFor(companyId);
    const { effectiveFrom: requested, ...config } = parsed.data;
    const effectiveFrom = requested ?? localDate(old.timezone);
    await prisma.$transaction(async (tx) => {
      await tx.attendanceSettingVersion.upsert({
        where: {
          companyId_effectiveFrom: { companyId, effectiveFrom: "0001-01-01" },
        },
        create: {
          companyId,
          effectiveFrom: "0001-01-01",
          config: JSON.parse(JSON.stringify(old)),
        },
        update: {},
      });
      await tx.attendanceSettingVersion.upsert({
        where: { companyId_effectiveFrom: { companyId, effectiveFrom } },
        create: { companyId, effectiveFrom, config },
        update: { config },
      });
    });
    const current = await settingsAt(companyId, localDate(config.timezone));
    await prisma.attendanceSettings.update({
      where: { companyId },
      data: current,
    });
    res.json({ settings: config, effectiveFrom });
  }),
);
attendanceRouter.get(
  "/employees",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    const settings = await settingsFor(companyId);
    const employees = await prisma.employee.findMany({
      where: { companyId },
      orderBy: [{ name: "asc" }, { pin: "asc" }],
      include: {
        assignments: {
          where: { effectiveFrom: { lte: localDate(settings.timezone) } },
          orderBy: { effectiveFrom: "desc" },
          take: 1,
        },
      },
    });
    res.json({
      employees: employees.map((e) => ({
        id: e.id,
        name: e.name,
        pin: e.pin,
        shift: e.assignments[0]?.shift ?? e.shift,
        active: e.assignments[0]?.active ?? e.active,
      })),
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
        effectiveFrom: dateSchema.optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Choose shift 1 or 2 and a valid active status" });
      return;
    }
    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!employee) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }
    const settings = await settingsFor(companyId);
    const effectiveFrom =
      parsed.data.effectiveFrom ?? localDate(settings.timezone);
    await prisma.$transaction(async (tx) => {
      await tx.employeeAssignment.upsert({
        where: {
          employeeId_effectiveFrom: {
            employeeId: employee.id,
            effectiveFrom: "0001-01-01",
          },
        },
        create: {
          employeeId: employee.id,
          effectiveFrom: "0001-01-01",
          shift: employee.shift,
          active: employee.active,
        },
        update: {},
      });
      const previous = await tx.employeeAssignment.findFirst({
        where: {
          employeeId: employee.id,
          effectiveFrom: { lte: effectiveFrom },
        },
        orderBy: { effectiveFrom: "desc" },
      });
      const data = {
        shift: parsed.data.shift ?? previous?.shift ?? employee.shift,
        active: parsed.data.active ?? previous?.active ?? employee.active,
      };
      await tx.employeeAssignment.upsert({
        where: {
          employeeId_effectiveFrom: { employeeId: employee.id, effectiveFrom },
        },
        create: { employeeId: employee.id, effectiveFrom, ...data },
        update: data,
      });
      const current = await tx.employeeAssignment.findFirst({
        where: {
          employeeId: employee.id,
          effectiveFrom: { lte: localDate(settings.timezone) },
        },
        orderBy: { effectiveFrom: "desc" },
      });
      if (current)
        await tx.employee.update({
          where: { id: employee.id },
          data: { shift: current.shift, active: current.active },
        });
    });
    res.json({ ok: true });
  }),
);
attendanceRouter.get(
  "/daily",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    if (!(await prisma.company.findUnique({ where: { id: companyId } }))) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const settings = await settingsFor(companyId);
    const date =
      typeof req.query.date === "string"
        ? req.query.date
        : localDate(settings.timezone);
    if (!validDate(date)) {
      res.status(400).json({ error: "Choose a valid date" });
      return;
    }
    const report = await attendanceRows(companyId, [date]);
    const rows = report.rows.filter((r) => r.status !== "inactive");
    const summary: Record<string, number> = {
      total: rows.length,
      present: 0,
      absent: 0,
      pending: 0,
      unavailable: 0,
      off: 0,
      leave: 0,
    };
    for (const r of rows) summary[r.status]++;
    res.json({ ...report, date, rows, summary });
  }),
);

attendanceRouter.get(
  "/monthly",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    if (!(await prisma.company.findUnique({ where: { id: companyId } }))) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    const settings = await settingsFor(companyId);
    const month =
      typeof req.query.month === "string"
        ? req.query.month
        : localDate(settings.timezone).slice(0, 7);
    if (!/^(20[0-9]{2})-(0[1-9]|1[0-2])$/.test(month)) {
      res.status(400).json({ error: "Choose a month between 2000 and 2099" });
      return;
    }
    const count = new Date(
      Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
    ).getUTCDate();
    const dates = Array.from(
      { length: count },
      (_, i) => month + "-" + String(i + 1).padStart(2, "0"),
    );
    const employeeId =
      typeof req.query.employeeId === "string"
        ? req.query.employeeId
        : undefined;
    const report = await attendanceRows(companyId, dates, employeeId);
    if (employeeId && !report.rows.length) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }
    const groups = new Map<string, typeof report.rows>();
    for (const r of report.rows) {
      const days = groups.get(r.employeeId) ?? [];
      days.push(r);
      groups.set(r.employeeId, days);
    }
    const employees = [...groups.values()]
      .filter((days) => days.some((d) => d.status !== "inactive"))
      .map((days) => ({
        employeeId: days[0].employeeId,
        name: days[0].name,
        pin: days[0].pin,
        totals: summarizeMonth(days),
        ...(employeeId || req.query.includeDetails === "true" ? { days } : {}),
      }));
    const completed = report.rows.every(
      (r) => r.finalized || r.status === "inactive",
    );
    res.json({
      month,
      timezone: report.timezone,
      employees,
      retentionDays: report.retentionDays,
      reportStatus: !completed
        ? "In progress"
        : report.rows.some((r) => r.status === "unavailable")
          ? "Partial data"
          : "Complete",
      archived: true,
    });
  }),
);

attendanceRouter.patch(
  "/employees/:id/duty",
  route(async (req, res) => {
    const companyId = companyScope(req, res);
    if (!companyId) return;
    const employee = await prisma.employee.findFirst({
      where: { id: req.params.id, companyId },
    });
    if (!employee) {
      res.status(404).json({ error: "Employee not found" });
      return;
    }
    const parsed = z
      .object({
        date: dateSchema,
        kind: z.enum(["DEFAULT", "SHIFT1", "SHIFT2", "DOUBLE", "OFF", "LEAVE"]),
        note: z.string().trim().max(500).default(""),
        approvedOvertimeMinutes: z
          .number()
          .int()
          .min(0)
          .max(1440)
          .nullable()
          .default(null),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Choose a date, duty and overtime minutes between 0 and 1440",
      });
      return;
    }
    const { date, kind: requested, ...data } = parsed.data;
    if (
      requested === "DEFAULT" &&
      !data.note &&
      data.approvedOvertimeMinutes === null
    ) {
      await prisma.employeeDuty.deleteMany({
        where: { employeeId: employee.id, date },
      });
    } else {
      const assignment = await prisma.employeeAssignment.findFirst({
        where: { employeeId: employee.id, effectiveFrom: { lte: date } },
        orderBy: { effectiveFrom: "desc" },
      });
      const kind =
        requested === "DEFAULT"
          ? (assignment?.shift ?? employee.shift) === 2
            ? "SHIFT2"
            : "SHIFT1"
          : requested;
      await prisma.employeeDuty.upsert({
        where: { employeeId_date: { employeeId: employee.id, date } },
        create: { employeeId: employee.id, date, kind, ...data },
        update: { kind, ...data },
      });
    }
    res.json({ ok: true });
  }),
);
