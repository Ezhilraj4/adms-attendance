import { describe, expect, it } from "vitest";
import { analyzeAttendance, AttendancePunch } from "../src/utils/attendanceAnalysis";
import { ShiftSettings } from "../src/utils/dailyAttendance";
const settings: ShiftSettings = { timezone: "UTC", shift1Start: "09:00", shift1End: "17:00", shift2Start: "17:00", shift2End: "01:00", earlyMinutes: 60, afterMinutes: 120, graceMinutes: 15, overtimeThresholdMinutes: 30, maxOvertimeMinutes: 480, doubleShiftMinMinutes: 240, overtimeMode: "paired" };
const p = (time: string, status: number): AttendancePunch => ({ id: time + status, time: `2026-11-${time}Z`, status, device: "Test" });
const analyze = (punches: AttendancePunch[], overrides: Partial<Parameters<typeof analyzeAttendance>[0]> = {}) => analyzeAttendance({ date: "2026-11-22", baseShift: 1, kind: "SHIFT1", punches, settings, now: new Date("2026-11-23T09:00:00Z"), unavailable: false, nextStart: Date.parse("2026-11-23T08:00:00Z"), ...overrides });
describe("shop attendance analysis", () => {
  it("stays pending for the whole shop day, then marks no-punch leave", () => {
    expect(analyze([], { now: new Date("2026-11-22T17:01:00Z") }).status).toBe("pending");
    expect(analyze([], { now: new Date("2026-11-23T00:59:59Z") }).status).toBe("pending");
    expect(analyze([], { now: new Date("2026-11-23T01:00:00Z") }).status).toBe("leave");
  });
  it("counts late arrivals as present and applies a late grace period", () => {
    const r = analyze([p("22T09:10:00", 0), p("22T17:00:00", 1)]);
    expect(r.status).toBe("present"); expect(r.lateMinutes).toBe(0);
    expect(r.workedMinutes).toBe(470);
  });
  it("counts a called-in employee who covers the earlier duty", () => {
    const r = analyze([p("22T09:05:00", 0), p("22T17:00:00", 1)], { baseShift: 2, kind: "SHIFT2" });
    expect(r.status).toBe("present"); expect(r.detectedShift).toBe(1);
    expect(r.dutyChanged).toBe(true); expect(r.lateMinutes).toBe(0);
  });
  it("counts a called-in employee covering the later duty without false all-night overtime", () => {
    const r = analyze([p("22T17:10:00", 0), p("23T01:00:00", 1)]);
    expect(r.status).toBe("present"); expect(r.detectedShift).toBe(2);
    expect(r.overtimeMinutes).toBe(0); expect(r.dutyChanged).toBe(true);
  });
  it("excludes recorded breaks and estimates only after-end overtime", () => {
    const r = analyze([p("22T09:00:00", 0), p("22T12:00:00", 1), p("22T13:00:00", 0), p("22T18:00:00", 1)]);
    expect(r.workedMinutes).toBe(480); expect(r.overtimeMinutes).toBe(60);
    expect(r.estimatedHours).toBe(false);
  });
  it("recognizes double duty and removes scheduled second-duty time from OT once confirmed", () => {
    const punches = [p("22T09:00:00", 0), p("22T17:00:00", 1), p("22T17:05:00", 0), p("23T01:00:00", 1)];
    expect(analyze(punches).possibleDoubleShift).toBe(true);
    const confirmed = analyze(punches, { kind: "DOUBLE" });
    expect(confirmed.workedMinutes).toBe(955); expect(confirmed.overtimeMinutes).toBe(0);
  });
  it("does not invent work hours from a single punch", () => {
    const r = analyze([p("22T10:00:00", 0)]);
    expect(r.status).toBe("present"); expect(r.workedMinutes).toBeNull();
    expect(r.overtimeMinutes).toBe(0); expect(r.needsReview).toBe(true);
    expect(analyze([p("22T10:00:00", 0)], { kind: "DOUBLE" }).doubleShiftWorked).toBe(false);
  });
  it("labels generic repeated punches as estimates and keeps approval separate", () => {
    const r = analyze([p("22T09:00:00", 0), p("22T18:00:00", 0)], { approvedOvertimeMinutes: 30 });
    expect(r.estimatedHours).toBe(true); expect(r.overtimeMinutes).toBe(60);
    expect(r.approvedOvertimeMinutes).toBe(30);
  });
  it("ignores future punches for presence and does not infer leave from unavailable history", () => {
    expect(analyze([p("22T10:00:00", 0)], { now: new Date("2026-11-22T09:00:00Z") }).status).toBe("pending");
    expect(analyze([], { unavailable: true }).status).toBe("unavailable");
  });
  it("does not count the next day's arrival twice", () => {
    const r = analyze([p("23T08:00:00", 0)]);
    expect(r.punches).toHaveLength(0);
  });
  it("does not invent double duty when both groups have the same hours", () => {
    const r = analyze([p("22T09:00:00", 0), p("22T17:00:00", 1)], { settings: { ...settings, shift2Start: "09:00", shift2End: "17:00" } });
    expect(r.possibleDoubleShift).toBe(false);
  });
  it("keeps an early arrival for a covering duty in the detected duty", () => {
    const r = analyze([p("22T16:00:00", 0), p("23T01:00:00", 1)]);
    expect(r.detectedShift).toBe(2); expect(r.overtimeMinutes).toBe(0);
  });
});
