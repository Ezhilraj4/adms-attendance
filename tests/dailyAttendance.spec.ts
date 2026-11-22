import { describe, expect, it } from "vitest";
import { shiftWindow, summarizeDay, ShiftSettings } from "../src/utils/dailyAttendance";
const settings: ShiftSettings = { timezone: "Asia/Kolkata", shift1Start: "09:00", shift1End: "17:00", shift2Start: "22:00", shift2End: "06:00", earlyMinutes: 60, afterMinutes: 120, graceMinutes: 15 };
describe("daily shift attendance", () => {
  it("converts local shift boundaries into UTC", () => {
    const w = shiftWindow("2026-11-22", 1, settings);
    expect(w.start.toISOString()).toBe("2026-11-22T03:30:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-22T11:30:00.000Z");
  });
  it("keeps overnight punches on the date the shift starts", () => {
    const w = shiftWindow("2026-11-22", 2, settings);
    expect(w.end.toISOString()).toBe("2026-11-23T00:30:00.000Z");
    const r = summarizeDay([w.start, w.end], w, 15, new Date("2026-11-24"), false);
    expect(r.status).toBe("present"); expect(r.spanMinutes).toBe(480);
  });
  it("does not finalize the basic shift before its scheduled end", () => {
    const w = shiftWindow("2026-11-22", 1, settings);
    expect(summarizeDay([], w, 15, new Date(w.end.getTime() - 1), false).status).toBe("pending");
    expect(summarizeDay([], w, 15, w.to, false).status).toBe("absent");
  });
  it("excludes out-of-window punches and reports grace-adjusted lateness", () => {
    const w = shiftWindow("2026-11-22", 1, settings);
    const r = summarizeDay([new Date(w.from.getTime() - 1), new Date(w.start.getTime() + 20 * 60000), w.to], w, 15, w.to, false);
    expect(r.lateMinutes).toBe(5); expect(r.lastPunch).toBeNull();
  });
  it("does not infer absence from missing historical data", () => {
    const w = shiftWindow("2026-11-22", 1, settings);
    expect(summarizeDay([], w, 15, w.to, true).status).toBe("unavailable");
    expect(summarizeDay([w.start], w, 15, w.to, true).status).toBe("present");
  });
  it("respects a daylight-saving timezone rather than a fixed UTC offset", () => {
    const s = { ...settings, timezone: "America/New_York" };
    expect(shiftWindow("2026-07-01", 1, s).start.toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(shiftWindow("2026-12-01", 1, s).start.toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });
});
