ALTER TABLE "employees" ADD COLUMN "shift" INTEGER NOT NULL DEFAULT 1, ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "employees" ADD CONSTRAINT "employee_shift_valid" CHECK ("shift" IN (1, 2));
CREATE TABLE "attendance_settings" (
  "companyId" TEXT PRIMARY KEY REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  "shift1Start" TEXT NOT NULL DEFAULT '09:00',
  "shift1End" TEXT NOT NULL DEFAULT '17:00',
  "shift2Start" TEXT NOT NULL DEFAULT '17:00',
  "shift2End" TEXT NOT NULL DEFAULT '01:00',
  "earlyMinutes" INTEGER NOT NULL DEFAULT 60,
  "afterMinutes" INTEGER NOT NULL DEFAULT 120,
  "graceMinutes" INTEGER NOT NULL DEFAULT 15,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
ALTER TABLE "attendance_settings" ENABLE ROW LEVEL SECURITY;
