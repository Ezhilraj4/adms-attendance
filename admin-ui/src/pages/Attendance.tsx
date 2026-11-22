import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  AttendanceEmployee,
  AttendanceSettings as Settings,
  CompanyOption,
  DailyAttendanceReport,
} from "../api";
import { useAuth } from "../context/AuthContext";
import { TIMEZONE_OPTIONS } from "../utils/timezoneOptions";

export function useCompany(disabled = false) {
  const { user } = useAuth();
  const [companies, setCompanies] = useState<CompanyOption[]>([]);
  const [companyId, setCompanyId] = useState(user?.companyId ?? "");
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    api
      .listCompanyOptions()
      .then(({ companies }) => {
        if (!current) return;
        setCompanies(companies);
        setCompanyId((id) => id || companies[0]?.id || "");
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, []);
  return {
    companyId,
    error,
    picker:
      user?.role === "SUPER_ADMIN" ? (
        <div className="field">
          <label htmlFor="attendance-company">Company</label>
          <select
            id="attendance-company"
            disabled={disabled}
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
          >
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      ) : null,
  };
}

export function Employees() {
  const [busy, setBusy] = useState("");
  const scope = useCompany(!!busy);
  const [employees, setEmployees] = useState<AttendanceEmployee[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [savedAssignment, setSavedAssignment] = useState(false);
  useEffect(() => {
    if (!scope.companyId) return;
    let current = true;
    setLoading(true);
    setError("");
    setEmployees([]);
    api
      .getEmployees(scope.companyId)
      .then((r) => {
        if (current) setEmployees(r.employees);
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [scope.companyId]);
  async function update(
    employee: AttendanceEmployee,
    change: { shift?: number; active?: boolean },
  ) {
    setBusy(employee.id);
    setError("");
    try {
      await api.updateEmployee(scope.companyId, employee.id, {
        ...change,
        effectiveFrom: effectiveFrom || undefined,
      });
      setEmployees((await api.getEmployees(scope.companyId)).employees);
      setSavedAssignment(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const rows = employees.filter((e) =>
    `${e.name} ${e.pin}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div>
      <h2>Employees</h2>
      <p className="muted">
        Names come from your device. Assign each employee to a shift for daily
        attendance.
      </p>
      <div className="filters">
        {scope.picker}
        <div className="field">
          <label htmlFor="assignment-date">
            Assignment effective from (blank = today)
          </label>
          <input
            id="assignment-date"
            type="date"
            value={effectiveFrom}
            disabled={!!busy}
            onChange={(e) => {
              setEffectiveFrom(e.target.value);
              setSavedAssignment(false);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="employee-search">Search employees</label>
          <input
            id="employee-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or PIN"
          />
        </div>
        <Link to="/attendance-settings">Adjust shift times</Link>
      </div>
      {(error || scope.error) && (
        <div role="alert" className="error-banner">
          {error || scope.error}
        </div>
      )}
      <div className="card table-wrap">
        {savedAssignment && (
          <p role="status">
            Assignment saved. Future changes start on the selected date; earlier
            attendance stays unchanged.
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>PIN</th>
              <th>Shift</th>
              <th>Include in attendance</th>
              <th>Report</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td>{e.pin}</td>
                <td>
                  <div
                    className="shift-buttons"
                    role="group"
                    aria-label={`Shift for ${e.name}`}
                  >
                    {[1, 2].map((shift) => (
                      <button
                        key={shift}
                        className={`btn btn-sm${e.shift === shift ? " btn-primary" : ""}`}
                        aria-pressed={e.shift === shift}
                        disabled={!!busy}
                        onClick={() => update(e, { shift })}
                      >
                        {shift === 1 ? "1st shift" : "2nd shift"}
                      </button>
                    ))}
                  </div>
                </td>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={e.active}
                      disabled={!!busy}
                      onChange={(event) =>
                        update(e, { active: event.target.checked })
                      }
                      aria-label={`Include ${e.name} in attendance`}
                    />{" "}
                    {e.active ? "Active" : "Inactive"}
                  </label>
                </td>
                <td>
                  <Link to={`/attendance-monthly?employeeId=${e.id}`}>
                    View details
                  </Link>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5}>
                  {loading && scope.companyId
                    ? "Loading…"
                    : "No employees found. Use Devices → Commands → Sync employee names first."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AttendanceSettings() {
  const [saving, setSaving] = useState(false);
  const scope = useCompany(saving);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  useEffect(() => {
    if (!scope.companyId) return;
    let current = true;
    setSettings(null);
    setError("");
    setSaved(false);
    api
      .getAttendanceSettings(scope.companyId)
      .then((r) => {
        if (current) setSettings(r.settings);
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [scope.companyId]);
  function edit<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => s && { ...s, [key]: value });
    setSaved(false);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const result = await api.updateAttendanceSettings(scope.companyId, {
        ...settings,
        effectiveFrom: effectiveFrom || undefined,
      });
      setSettings(result.settings);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div>
      <h2>Attendance Settings</h2>
      <p className="muted">
        Choose working times for both shifts. An end time earlier than the start
        continues into the next day.
      </p>
      {scope.picker}
      {(error || scope.error) && (
        <div role="alert" className="error-banner">
          {error || scope.error}
        </div>
      )}
      {settings && (
        <form onSubmit={save}>
          <fieldset disabled={saving} className="attendance-form">
            <div className="card field">
              <label htmlFor="settings-effective-date">
                Settings effective from (blank = today)
              </label>
              <input
                id="settings-effective-date"
                type="date"
                value={effectiveFrom}
                onChange={(e) => {
                  setEffectiveFrom(e.target.value);
                  setSaved(false);
                }}
              />
              <p className="muted">
                Earlier dates keep their saved working-time rules.
              </p>
            </div>
            <div className="card">
              <div className="field">
                <label htmlFor="attendance-timezone">Attendance timezone</label>
                <select
                  id="attendance-timezone"
                  value={settings.timezone}
                  onChange={(e) => edit("timezone", e.target.value)}
                >
                  {!TIMEZONE_OPTIONS.some(
                    (t) => t.tz === settings.timezone,
                  ) && (
                    <option value={settings.timezone}>
                      {settings.timezone}
                    </option>
                  )}
                  {TIMEZONE_OPTIONS.map((t) => (
                    <option key={t.tz} value={t.tz}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="attendance-shifts">
              {([1, 2] as const).map((shift) => (
                <div className="card" key={shift}>
                  <h3>{shift === 1 ? "1st shift" : "2nd shift"}</h3>
                  <div className="filters">
                    <div className="field">
                      <label htmlFor={`shift${shift}-start`}>Starts</label>
                      <input
                        id={`shift${shift}-start`}
                        type="time"
                        required
                        value={
                          shift === 1
                            ? settings.shift1Start
                            : settings.shift2Start
                        }
                        onChange={(e) =>
                          edit(
                            shift === 1 ? "shift1Start" : "shift2Start",
                            e.target.value,
                          )
                        }
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`shift${shift}-end`}>Ends</label>
                      <input
                        id={`shift${shift}-end`}
                        type="time"
                        required
                        value={
                          shift === 1 ? settings.shift1End : settings.shift2End
                        }
                        onChange={(e) =>
                          edit(
                            shift === 1 ? "shift1End" : "shift2End",
                            e.target.value,
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="card">
              <h3>Punch time allowances</h3>
              <div className="filters">
                {(
                  [
                    {
                      key: "earlyMinutes",
                      label:
                        "Shop day starts this many minutes before the earliest shift",
                      max: 360,
                    },
                    {
                      key: "graceMinutes",
                      label: "Late arrival grace (minutes)",
                      max: 180,
                    },
                  ] as const
                ).map((f) => (
                  <div className="field" key={f.key}>
                    <label htmlFor={f.key}>{f.label}</label>
                    <input
                      id={f.key}
                      type="number"
                      min={0}
                      max={f.max}
                      required
                      value={settings[f.key]}
                      onChange={(e) => edit(f.key, Number(e.target.value))}
                    />
                  </div>
                ))}
              </div>
              <p className="muted">
                No punch stays Pending until the full shop working day
                (including night shift) ends, then becomes Leave — no punch.
                Late arrivals and covering another shift still count as Present.
              </p>
            </div>
            <div className="card">
              <h3>Overtime and duty detection</h3>
              <div className="filters">
                {(
                  [
                    {
                      key: "overtimeThresholdMinutes",
                      label: "Minimum overtime (minutes)",
                      min: 0,
                      max: 240,
                    },
                    {
                      key: "maxOvertimeMinutes",
                      label: "Maximum estimated overtime per day (minutes)",
                      min: 0,
                      max: 720,
                    },
                    {
                      key: "doubleShiftMinMinutes",
                      label:
                        "Minimum coverage in each shift to detect double duty (minutes)",
                      min: 30,
                      max: 720,
                    },
                  ] as const
                ).map((f) => (
                  <div className="field" key={f.key}>
                    <label htmlFor={f.key}>{f.label}</label>
                    <input
                      id={f.key}
                      type="number"
                      min={f.min}
                      max={f.max}
                      required
                      value={
                        settings[f.key] ??
                        (f.key === "overtimeThresholdMinutes"
                          ? 30
                          : f.key === "maxOvertimeMinutes"
                            ? 480
                            : 240)
                      }
                      onChange={(e) => edit(f.key, Number(e.target.value))}
                    />
                  </div>
                ))}
              </div>
              <div className="field">
                <label htmlFor="overtime-mode">Worked time calculation</label>
                <select
                  id="overtime-mode"
                  value={settings.overtimeMode ?? "paired"}
                  onChange={(e) =>
                    edit("overtimeMode", e.target.value as "paired" | "span")
                  }
                >
                  <option value="paired">
                    Use IN/OUT pairs; exclude recorded breaks
                  </option>
                  <option value="span">
                    First punch to last punch; includes breaks
                  </option>
                </select>
              </div>
              <p className="muted">
                Unclear punches are flagged. Estimated overtime is separate from
                approved overtime in each employee's monthly details.
              </p>
            </div>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? "Saving…" : "Save attendance settings"}
            </button>
            {saved && <p role="status">Attendance settings saved.</p>}
          </fieldset>
        </form>
      )}
    </div>
  );
}

export const statusLabel = {
  present: "Present",
  absent: "Absent (no punch)",
  pending: "Pending",
  unavailable: "No data",
  off: "Day off",
  leave: "Leave — no punch",
  inactive: "Inactive",
};
export function DailyAttendance() {
  const scope = useCompany();
  const [date, setDate] = useState("");
  const [report, setReport] = useState<DailyAttendanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState("");
  const [shift, setShift] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (!scope.companyId) return;
    let current = true;
    setLoading(true);
    setError("");
    setReport(null);
    api
      .getDailyAttendance(scope.companyId, date || undefined)
      .then((r) => {
        if (current) {
          setReport(r);
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [scope.companyId, date, refresh]);
  const format = (value: string | null) =>
    value && report
      ? new Intl.DateTimeFormat("en-IN", {
          timeZone: report.timezone,
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date(value))
      : "—";
  const rows = (report?.rows ?? []).filter(
    (r) =>
      (!status || r.status === status) &&
      (!shift || r.shift === Number(shift)) &&
      `${r.name} ${r.pin}`.toLowerCase().includes(search.toLowerCase()),
  );
  function download() {
    if (!report) return;
    const csv = [
      [
        "Date",
        "Timezone",
        "Employee",
        "PIN",
        "Shift",
        "Status",
        "First punch",
        "Last punch",
        "All punch times",
        "Late minutes after grace",
      ],
      ...rows.map((r) => [
        report.date,
        report.timezone,
        r.name,
        r.pin,
        r.shift,
        statusLabel[r.status],
        format(r.firstPunch),
        format(r.lastPunch),
        r.punches.map((p) => format(p.time)).join("; "),
        r.lateMinutes,
      ]),
    ]
      .map((row) =>
        row
          .map(
            (value) =>
              `"${String(value)
                .replace(/^[=+@\-\t\r]/, "'$&")
                .replace(/"/g, '""')}"`,
          )
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `attendance-${report.date}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div>
      <h2>Daily Attendance</h2>
      <p className="muted">
        Present and absent employees, with every recorded punch beside their
        name.
      </p>
      <div className="filters">
        {scope.picker}
        <div className="field">
          <label htmlFor="attendance-date">Attendance date</label>
          <input
            id="attendance-date"
            type="date"
            value={date || report?.date || ""}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <button
          className="btn"
          onClick={() => setRefresh((v) => v + 1)}
          disabled={loading}
        >
          Refresh
        </button>
        <button className="btn" onClick={download} disabled={!report}>
          Download CSV
        </button>
      </div>
      {(error || scope.error) && (
        <div role="alert" className="error-banner">
          {error || scope.error}
        </div>
      )}
      {report && (
        <>
          <div className="attendance-summary">
            {(
              [
                "total",
                "present",
                "leave",
                "pending",
                "off",
                "unavailable",
              ] as const
            ).map((key) => (
              <div className="card" key={key}>
                <span className="muted">
                  {key === "total" ? "Employees" : statusLabel[key]}
                </span>
                <strong>{report.summary[key]}</strong>
              </div>
            ))}
          </div>
          <p className="muted">
            Times in {report.timezone}. The date is the day the shift starts.
            No-punch days stay Pending until the shop's last shift ends, then
            become Leave. Monthly summaries keep archived days beyond the{" "}
            {report.retentionDays}-day raw-log period; missing earlier data
            remains “No data”.
          </p>
          {!!report.unknownPins.length && (
            <p role="status">
              {report.unknownPins.length} PIN(s) are outside the active employee
              roster. Sync employee names or check inactive employees to include
              them.
            </p>
          )}
        </>
      )}
      <div className="filters">
        <div className="field">
          <label htmlFor="attendance-search">Search</label>
          <input
            id="attendance-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Employee or PIN"
          />
        </div>
        <div className="field">
          <label htmlFor="attendance-status">Status</label>
          <select
            id="attendance-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {Object.entries(statusLabel).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="attendance-shift">Shift</label>
          <select
            id="attendance-shift"
            value={shift}
            onChange={(e) => setShift(e.target.value)}
          >
            <option value="">Both shifts</option>
            <option value="1">1st shift</option>
            <option value="2">2nd shift</option>
          </select>
        </div>
      </div>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Shift</th>
              <th>Status</th>
              <th>First punch</th>
              <th>Last punch</th>
              <th>All punch times</th>
              <th>Late</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.employeeId}>
                <td>
                  <strong>{r.name}</strong>
                  <div className="muted">PIN {r.pin}</div>
                  <Link
                    to={`/attendance-monthly?employeeId=${r.employeeId}&month=${report?.date.slice(0, 7)}`}
                  >
                    View full details
                  </Link>
                </td>
                <td>
                  {r.dutyKind === "DOUBLE"
                    ? "Double shift"
                    : r.dutyKind === "OFF"
                      ? "Day off"
                      : r.dutyKind === "LEAVE"
                        ? "Leave"
                        : r.shift === 1
                          ? "1st shift"
                          : "2nd shift"}
                  {r.detectedShift && (
                    <div>Covered shift {r.detectedShift}</div>
                  )}
                  {r.possibleDoubleShift && <div>Double duty detected</div>}
                  <div className="muted">
                    {format(r.shiftStart)} → {format(r.shiftEnd)}
                  </div>
                </td>
                <td>
                  <span className={`badge attendance-${r.status}`}>
                    {statusLabel[r.status]}
                  </span>
                  {!r.finalized && <div className="muted">Day still open</div>}
                </td>
                <td>{format(r.firstPunch)}</td>
                <td>{format(r.lastPunch)}</td>
                <td className="attendance-punches">
                  {r.punches.length
                    ? r.punches.map((p) => (
                        <span
                          className="attendance-punch"
                          key={p.id}
                          title={p.device}
                        >
                          {format(p.time)}
                        </span>
                      ))
                    : "—"}
                </td>
                <td>{r.lateMinutes ? `${r.lateMinutes} min` : "—"}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7}>
                  {loading
                    ? "Loading attendance…"
                    : "No employees match. Check the Employees page and filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
