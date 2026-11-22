import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/db/client";
import { app, cleanupAll, createCompany, createDevice, createAdmin } from "./helpers/securityTestApp";
import { shiftWindow } from "../src/utils/dailyAttendance";

describe("attendance API", () => {
  let companyId: string, cookie: string, foreignEmployeeId: string, nightEmployeeId: string;
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  beforeAll(async () => {
    const c = await createCompany(); companyId = c.id;
    cookie = (await createAdmin("COMPANY_ADMIN", c.id)).cookie;
    const device = await createDevice(c.id, { timezone: "Asia/Kolkata" });
    const settings = await prisma.attendanceSettings.create({ data: { companyId: c.id } });
    for (const [pin, name, shift] of [["1", "Day employee", 1], ["2", "Night employee", 2], ["3", "Absent employee", 1]] as const) {
      const employee = await prisma.employee.create({ data: { companyId: c.id, pin, name, shift, createdAt: new Date("2020-01-01") } });
      if (shift === 2) nightEmployeeId = employee.id;
    }
    await prisma.employee.create({ data: { companyId: c.id, pin: "4", name: "Inactive", active: false } });
    for (const shift of [1, 2]) {
      const w = shiftWindow(day, shift, settings);
      await prisma.punchRecord.createMany({ data: [w.start, w.end].map((t) => ({ deviceId: device.id, devicePin: String(shift), punchTime: t, punchTimeUtc: t, status: 0, verifyMode: 1, rawLine: "test" })) });
    }
    const other = await createCompany();
    foreignEmployeeId = (await prisma.employee.create({ data: { companyId: other.id, pin: "1", name: "Other company" } })).id;
  });
  afterAll(cleanupAll);
  it("requires authentication", async () => { await request(app).get("/api/admin/attendance/daily").expect(401); });
  it("shows present, absent, all times, and overnight punches without inactive employees", async () => {
    const r = await request(app).get(`/api/admin/attendance/daily?date=${day}`).set("Cookie", cookie).expect(200);
    expect(r.body.summary).toMatchObject({ total: 3, present: 2, leave: 1 });
    expect(r.body.rows.find((e: any) => e.pin === "2").punches).toHaveLength(2);
    expect(r.body.rows.find((e: any) => e.pin === "3").status).toBe("leave");
    expect(r.body.rows.some((e: any) => e.name === "Other company")).toBe(false);
  });
  it("does not let a query parameter cross company boundaries", async () => {
    const r = await request(app).get("/api/admin/attendance/employees?companyId=foreign").set("Cookie", cookie).expect(200);
    expect(r.body.employees).toHaveLength(4);
    await request(app).patch(`/api/admin/attendance/employees/${foreignEmployeeId}`).set("Cookie", cookie).send({ shift: 2 }).expect(404);
  });
  it("persists shift assignment and preserves it during name synchronization", async () => {
    await request(app).patch(`/api/admin/attendance/employees/${nightEmployeeId}`).set("Cookie", cookie).send({ shift: 1 }).expect(200);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: nightEmployeeId } })).shift).toBe(1);
    await prisma.employee.upsert({ where: { companyId_pin: { companyId, pin: "2" } }, create: { companyId, pin: "2", name: "Updated" }, update: { name: "Updated" } });
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: nightEmployeeId } })).shift).toBe(1);
  });
  it("validates dates, shifts, timezones and non-overlapping daily windows", async () => {
    await request(app).get("/api/admin/attendance/daily?date=2026-02-31").set("Cookie", cookie).expect(400);
    await request(app).patch(`/api/admin/attendance/employees/${nightEmployeeId}`).set("Cookie", cookie).send({ shift: 3 }).expect(400);
    const { body } = await request(app).get("/api/admin/attendance/settings").set("Cookie", cookie).expect(200);
    await request(app).patch("/api/admin/attendance/settings").set("Cookie", cookie).send({ ...body.settings, timezone: "invalid" }).expect(400);
    await request(app).patch("/api/admin/attendance/settings").set("Cookie", cookie).send({ ...body.settings, shift1End: body.settings.shift1Start }).expect(400);
    await request(app).patch("/api/admin/attendance/settings").set("Cookie", cookie).send({ ...body.settings, shift2Start: "22:00", shift2End: "06:00" }).expect(200);
  });
  it("uses pending for future shifts and no-data for expired records", async () => {
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const r = await request(app).get(`/api/admin/attendance/daily?date=${future}`).set("Cookie", cookie).expect(200);
    expect(r.body.summary.pending).toBe(3);
    const old = await request(app).get("/api/admin/attendance/daily?date=2020-01-01").set("Cookie", cookie).expect(200);
    expect(old.body.summary.unavailable).toBe(3);
  });
});
