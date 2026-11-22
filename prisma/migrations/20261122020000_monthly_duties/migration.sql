ALTER TABLE attendance_settings ADD COLUMN "overtimeThresholdMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN "maxOvertimeMinutes" INTEGER NOT NULL DEFAULT 480,
ADD COLUMN "doubleShiftMinMinutes" INTEGER NOT NULL DEFAULT 240,
ADD COLUMN "overtimeMode" TEXT NOT NULL DEFAULT 'paired';
CREATE TABLE employee_assignments (
 id TEXT PRIMARY KEY, "employeeId" TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "effectiveFrom" TEXT NOT NULL, shift INTEGER NOT NULL CHECK (shift IN (1,2)), active BOOLEAN NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("employeeId", "effectiveFrom")
);
CREATE TABLE employee_duties (
 id TEXT PRIMARY KEY, "employeeId" TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE,
 date TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('SHIFT1','SHIFT2','DOUBLE','OFF','LEAVE')),
 note TEXT NOT NULL DEFAULT '', "approvedOvertimeMinutes" INTEGER CHECK ("approvedOvertimeMinutes" BETWEEN 0 AND 1440),
 "updatedAt" TIMESTAMP(3) NOT NULL, UNIQUE ("employeeId", date)
);
CREATE TABLE attendance_days (
 id TEXT PRIMARY KEY, "employeeId" TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE ON UPDATE CASCADE,
 date TEXT NOT NULL, data JSONB NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE ("employeeId", date)
);
CREATE INDEX attendance_days_date_idx ON attendance_days(date);
CREATE TABLE attendance_setting_versions (
 id TEXT PRIMARY KEY, "companyId" TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "effectiveFrom" TEXT NOT NULL, config JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("companyId", "effectiveFrom")
);
INSERT INTO employee_assignments (id,"employeeId","effectiveFrom",shift,active)
SELECT 'baseline_' || id,id,'0001-01-01',shift,active FROM employees;
INSERT INTO attendance_setting_versions (id,"companyId","effectiveFrom",config)
SELECT 'baseline_' || "companyId","companyId",'0001-01-01',to_jsonb(s) FROM attendance_settings s;
ALTER TABLE employee_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_duties ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_setting_versions ENABLE ROW LEVEL SECURITY;
CREATE TABLE attendance_archive_state (
 "companyId" TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE attendance_archive_state ENABLE ROW LEVEL SECURITY;
