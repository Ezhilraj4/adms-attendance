import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app, cleanupAll, createAdmin, createCompany, createDevice } from "./helpers/securityTestApp";

describe("employee names from device uploads", () => {
  let company: Awaited<ReturnType<typeof createCompany>>;
  let device: Awaited<ReturnType<typeof createDevice>>;
  let admin: Awaited<ReturnType<typeof createAdmin>>;
  let base: string;
  beforeAll(async () => {
    company = await createCompany();
    device = await createDevice(company.id);
    admin = await createAdmin("COMPANY_ADMIN", company.id);
    base = `/${company.slug}/${device.deviceSecret}/iclock/cdata?SN=${device.serialNumber}`;
  });
  afterAll(cleanupAll);

  it("resolves existing punches after USERINFO arrives and supports name search", async () => {
    await request(app).post(`${base}&table=ATTLOG`).type("text/plain").send("001\t2026-11-22 09:00:00\t0\t1\t0").expect(200);
    await request(app).post(`${base}&table=USERINFO`).type("text/plain").send("USER PIN=001\tName=Rahul Kumar\tPri=0").expect(200);
    const response = await request(app).get("/api/admin/punch-records?search=Rahul").set("Cookie", admin.cookie).expect(200);
    expect(response.body.records).toHaveLength(1);
    expect(response.body.records[0].employeeName).toBe("Rahul Kumar");
    expect(response.body.records[0].devicePin).toBe("001");
  });

  it("updates names from OPERLOG uploads and rejects an untrusted device secret", async () => {
    await request(app).post(`${base}&table=OPERLOG`).type("text/plain").send("USER PIN=001\tName=Rahul Updated\tPri=0\nOPLOG 1\t2").expect(200);
    await request(app).post(`/${company.slug}/wrong/iclock/cdata?SN=${device.serialNumber}&table=USERINFO`).type("text/plain").send("001\tWrong Name");
    const response = await request(app).get("/api/admin/punch-records").set("Cookie", admin.cookie).expect(200);
    expect(response.body.records[0].employeeName).toBe("Rahul Updated");
    const detail = await request(app).get(`/api/admin/punch-records/${response.body.records[0].id}/deliveries`).set("Cookie", admin.cookie).expect(200);
    expect(detail.body.punchRecord.employeeName).toBe("Rahul Updated");
  });

  it("isolates identical PINs in another company", async () => {
    const other = await createCompany();
    const otherDevice = await createDevice(other.id);
    await request(app).post(`/${other.slug}/${otherDevice.deviceSecret}/iclock/cdata?SN=${otherDevice.serialNumber}&table=USERINFO`).type("text/plain").send("001\tAnother Employee").expect(200);
    const response = await request(app).get("/api/admin/punch-records?search=Another").set("Cookie", admin.cookie).expect(200);
    expect(response.body.records).toHaveLength(0);
  });

  it("requires authorization for scheduled webhook processing", async () => {
    await request(app).get("/api/internal/worker").expect(401);
  });
});
