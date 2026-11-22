import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/db/client";
import { attendanceRows, localDate, nextDate, summarizeMonth } from "../src/attendance/report";
import { app, cleanupAll, createCompany, createAdmin, createDevice } from "./helpers/securityTestApp";
import { zonedWallClockToUtc } from "../src/adms/timezone";

describe("monthly employee reports and duty history", () => {
  let companyId: string, cookie: string, employeeId: string, deviceId: string, foreignId: string;
  const today = localDate("Asia/Kolkata");
  const day = nextDate(today, -2);
  const month = day.slice(0, 7);
  beforeAll(async () => {
    const company = await createCompany(); companyId = company.id;
    cookie = (await createAdmin("COMPANY_ADMIN", companyId)).cookie;
    const device = await createDevice(companyId, { timezone: "Asia/Kolkata" }); deviceId = device.id;
    employeeId = (await prisma.employee.create({ data: { companyId, pin: "001", name: "Monthly employee", createdAt: new Date("2020-01-01") } })).id;
    await prisma.attendanceSettings.create({ data: { companyId } });
    const other = await createCompany();
    foreignId = (await prisma.employee.create({ data: { companyId: other.id, pin: "001", name: "Private other company" } })).id;
    await prisma.punchRecord.createMany({ data: [["09:10", 0], ["12:00", 1], ["13:00", 0], ["18:00", 1]].map(([time, status]) => {
      const instant = zonedWallClockToUtc(new Date(`${day}T${time}:00Z`), "Asia/Kolkata");
      return { deviceId, devicePin: "001", punchTime: instant, punchTimeUtc: instant, status: Number(status), verifyMode: 1, rawLine: "synthetic monthly test" };
    }) });
  });
  afterAll(cleanupAll);
  it("requires auth and never exposes another company's employee detail", async () => {
    await request(app).get(`/api/admin/attendance/monthly?month=${month}`).expect(401);
    await request(app).get(`/api/admin/attendance/monthly?month=${month}&employeeId=${foreignId}`).set("Cookie", cookie).expect(404);
    await request(app).patch(`/api/admin/attendance/employees/${foreignId}/duty`).set("Cookie", cookie).send({ date: day, kind: "DOUBLE" }).expect(404);
  });
  it("returns clickable-count totals separately from full employee day records", async () => {
    const overview = await request(app).get(`/api/admin/attendance/monthly?month=${month}`).set("Cookie", cookie).expect(200);
    expect(overview.body.employees).toHaveLength(1);
    expect(overview.body.employees[0].days).toBeUndefined();
    expect(overview.body.employees[0].totals.workedDays).toBe(1);
    const detail = await request(app).get(`/api/admin/attendance/monthly?month=${month}&employeeId=${employeeId}`).set("Cookie", cookie).expect(200);
    const row = detail.body.employees[0].days.find((r: any) => r.date === day);
    expect(row.punches).toHaveLength(4); expect(row.workedMinutes).toBe(470); expect(row.overtimeMinutes).toBe(60);
  });
  it("keeps past settings and assignments intact after a future change", async () => {
    const original = await attendanceRows(companyId, [day], employeeId);
    const { body } = await request(app).get("/api/admin/attendance/settings").set("Cookie", cookie).expect(200);
    await request(app).patch("/api/admin/attendance/settings").set("Cookie", cookie).send({ ...body.settings, shift1Start: "10:00", effectiveFrom: today }).expect(200);
    await request(app).patch(`/api/admin/attendance/employees/${employeeId}`).set("Cookie", cookie).send({ shift: 2, effectiveFrom: nextDate(today) }).expect(200);
    const historical = await attendanceRows(companyId, [day], employeeId);
    expect(historical.rows[0].shiftStart).toBe(original.rows[0].shiftStart);
    expect(historical.rows[0].baseShift).toBe(1);
    const future = await attendanceRows(companyId, [nextDate(today)], employeeId, false);
    expect(future.rows[0].baseShift).toBe(2);
  });
  it("saves a duty change and keeps approved OT distinct from detected OT", async () => {
    await request(app).patch(`/api/admin/attendance/employees/${employeeId}/duty`).set("Cookie", cookie).send({ date: day, kind: "SHIFT2", note: "Covered another duty", approvedOvertimeMinutes: 45 }).expect(200);
    const report = await attendanceRows(companyId, [day], employeeId);
    expect(report.rows[0].dutyChanged).toBe(true);
    expect(report.rows[0].note).toBe("Covered another duty");
    expect(summarizeMonth(report.rows).approvedOvertimeMinutes).toBe(45);
    await request(app).patch(`/api/admin/attendance/employees/${employeeId}/duty`).set("Cookie", cookie).send({ date: day, kind: "DEFAULT" }).expect(200);
  });
  it("persists all recorded times after raw punches have been cleaned up", async () => {
    await attendanceRows(companyId, [day], employeeId);
    expect(await prisma.attendanceDay.count({ where: { employeeId, date: day } })).toBe(1);
    await prisma.punchRecord.deleteMany({ where: { deviceId } });
    const archived = await attendanceRows(companyId, [day], employeeId);
    expect(archived.rows[0].status).toBe("present"); expect(archived.rows[0].punches).toHaveLength(4);
    expect(archived.rows[0].workedMinutes).toBe(470);
  });
  it("keeps a planned day off out of no-punch leave counts", async () => {
    await request(app).patch(`/api/admin/attendance/employees/${employeeId}/duty`).set("Cookie", cookie).send({ date: day, kind: "OFF", note: "Weekly off" }).expect(200);
    // Previously archived attendance still proves this employee worked on the day off.
    const report = await attendanceRows(companyId, [day], employeeId);
    expect(report.rows[0].status).toBe("present"); expect(report.rows[0].dutyKind).toBe("OFF");
    expect(report.rows[0].reviewReasons).toContain("Worked on a scheduled day off or leave");
  });
  it("validates duty updates and report months", async () => {
    await request(app).get("/api/admin/attendance/monthly?month=2026-99").set("Cookie", cookie).expect(400);
    await request(app).patch(`/api/admin/attendance/employees/${employeeId}/duty`).set("Cookie", cookie).send({ date: "not-a-date", kind: "DOUBLE" }).expect(400);
    await request(app).patch(`/api/admin/attendance/employees/${employeeId}/duty`).set("Cookie", cookie).send({ date: day, kind: "DOUBLE", approvedOvertimeMinutes: -1 }).expect(400);
  });
});
