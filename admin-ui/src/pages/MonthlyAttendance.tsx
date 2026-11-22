import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  api,
  DailyAttendanceRow,
  MonthlyAttendanceReport,
  MonthlyEmployee,
  MonthlyTotals,
} from "../api";
import { statusLabel, useCompany } from "./Attendance";

const hours = (minutes: number | null) =>
  minutes === null ? "—" : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
const dutyLabels: Record<string, string> = {
  SHIFT1: "1st shift",
  SHIFT2: "2nd shift",
  DOUBLE: "Double duty",
  OFF: "Day off",
  LEAVE: "Planned leave",
  DEFAULT: "Use regular assignment",
};
const metrics: { key: keyof MonthlyTotals; label: string; time?: boolean }[] = [
  { key: "workedDays", label: "Worked days" },
  { key: "leaveDays", label: "Leave / no punch" },
  { key: "pendingDays", label: "Pending" },
  { key: "workedMinutes", label: "Recorded hours", time: true },
  { key: "estimatedOvertimeMinutes", label: "OT estimate", time: true },
  { key: "approvedOvertimeMinutes", label: "OT approved", time: true },
  { key: "doubleShiftDays", label: "Double duties" },
  { key: "dutyChangeDays", label: "Duty changes" },
  { key: "offDays", label: "Days off" },
  { key: "reviewDays", label: "Review" },
  { key: "noDataDays", label: "No data" },
];
function matches(row: DailyAttendanceRow, filter: string) {
  switch (filter) {
    case "workedDays":
    case "workedMinutes":
      return row.status === "present";
    case "leaveDays":
      return row.status === "leave";
    case "pendingDays":
      return row.status === "pending";
    case "offDays":
      return row.status === "off";
    case "noDataDays":
      return row.status === "unavailable";
    case "estimatedOvertimeMinutes":
      return row.overtimeMinutes > 0;
    case "approvedOvertimeMinutes":
      return row.approvedOvertimeMinutes !== null;
    case "doubleShiftDays":
      return row.doubleShiftWorked;
    case "dutyChangeDays":
      return row.dutyChanged;
    case "reviewDays":
      return row.needsReview;
    default:
      return true;
  }
}
function csvDownload(filename: string, rows: unknown[][]) {
  const csv = rows
    .map((row) =>
      row
        .map(
          (value) =>
            `"${String(value ?? "")
              .replace(/^[\s]*[=+@-]/, "'$&")
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
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function MonthlyAttendance() {
  const [saving, setSaving] = useState(false);
  const scope = useCompany(saving);
  const [params, setParams] = useSearchParams();
  const month = params.get("month") ?? "";
  const employeeId = params.get("employeeId") ?? "";
  const [report, setReport] = useState<MonthlyAttendanceReport | null>(null);
  const [person, setPerson] = useState<MonthlyEmployee | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [editDate, setEditDate] = useState("");
  const [kind, setKind] = useState("DEFAULT");
  const [note, setNote] = useState("");
  const [approved, setApproved] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!scope.companyId) return;
    let current = true;
    setLoading(true);
    setError("");
    setReport(null);
    api
      .getMonthlyAttendance(scope.companyId, month || undefined)
      .then((r) => {
        if (current) setReport(r);
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
  }, [scope.companyId, month, refresh]);
  useEffect(() => {
    setPerson(null);
    setSaved(false);
    if (!scope.companyId || !employeeId) return;
    let current = true;
    setDetailLoading(true);
    api
      .getMonthlyAttendance(scope.companyId, month || undefined, employeeId)
      .then((r) => {
        if (!current) return;
        setPerson(r.employees[0] ?? null);
        setEditDate((d) => (d.startsWith(r.month) ? d : r.month + "-01"));
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setDetailLoading(false);
      });
    return () => {
      current = false;
    };
  }, [scope.companyId, month, employeeId, refresh]);
  useEffect(() => {
    const row = person?.days?.find((d) => d.date === editDate);
    setKind(row?.dutyOverride ? row.dutyKind : "DEFAULT");
    setNote(row?.note ?? "");
    setApproved(
      row?.approvedOvertimeMinutes === null ||
        row?.approvedOvertimeMinutes === undefined
        ? ""
        : String(row.approvedOvertimeMinutes),
    );
    setSaved(false);
  }, [person, editDate]);
  function changeParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  }
  function open(id: string, metric = "all") {
    changeParam("employeeId", id);
    setFilter(metric);
  }
  const format = (
    value: string | null,
    timezone = report?.timezone ?? "Asia/Kolkata",
  ) =>
    value
      ? new Intl.DateTimeFormat("en-IN", {
          timeZone: timezone,
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(new Date(value))
      : "—";
  async function saveDuty(e: FormEvent) {
    e.preventDefault();
    if (!employeeId || !editDate) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await api.updateEmployeeDuty(scope.companyId, employeeId, {
        date: editDate,
        kind,
        note,
        approvedOvertimeMinutes: approved === "" ? null : Number(approved),
      });
      setRefresh((v) => v + 1);
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  const employees = (report?.employees ?? []).filter((e) =>
    `${e.name} ${e.pin}`.toLowerCase().includes(search.toLowerCase()),
  );
  const days = (person?.days ?? []).filter((d) => matches(d, filter));
  function exportSummary() {
    if (!report) return;
    csvDownload(`attendance-${report.month}.csv`, [
      ["Month", "Employee", "PIN", ...metrics.map((m) => m.label)],
      ...employees.map((e) => [
        report.month,
        e.name,
        e.pin,
        ...metrics.map((m) =>
          m.time ? hours(e.totals[m.key]) : e.totals[m.key],
        ),
      ]),
    ]);
  }
  function exportDetails() {
    if (!person || !report) return;
    csvDownload(`attendance-${person.pin}-${report.month}.csv`, [
      [
        "Date",
        "Employee",
        "Status",
        "Duty",
        "All punch times",
        "Recorded hours",
        "Estimated OT",
        "Approved OT",
        "Late minutes",
        "Duty changed",
        "Double duty",
        "Review",
        "Note",
      ],
      ...days.map((d) => [
        d.date,
        person.name,
        statusLabel[d.status],
        dutyLabels[d.dutyKind],
        d.punches.map((p) => format(p.time, d.timezone)).join("; "),
        hours(d.workedMinutes),
        hours(d.overtimeMinutes),
        hours(d.approvedOvertimeMinutes),
        d.lateMinutes,
        d.dutyChanged ? "Yes" : "No",
        d.doubleShiftWorked ? "Yes" : "No",
        d.reviewReasons.join("; "),
        d.note,
      ]),
    ]);
  }
  return (
    <div>
      <h2>Monthly Attendance</h2>
      <p className="muted">
        Click any employee count to view its dates, punches and duty details.
      </p>
      <div className="filters">
        {scope.picker}
        <div className="field">
          <label htmlFor="attendance-month">Month</label>
          <input
            id="attendance-month"
            type="month"
            value={month || report?.month || ""}
            disabled={saving}
            onChange={(e) => changeParam("month", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="monthly-search">Find employee</label>
          <input
            id="monthly-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Employee or PIN"
          />
        </div>
        <button
          className="btn"
          disabled={loading || saving}
          onClick={() => setRefresh((v) => v + 1)}
        >
          Refresh
        </button>
        <button className="btn" disabled={!report} onClick={exportSummary}>
          Download month CSV
        </button>
      </div>
      {(error || scope.error) && (
        <div role="alert" className="error-banner">
          {error || scope.error}
        </div>
      )}
      {report && (
        <p>
          <strong>{report.reportStatus}</strong> · {report.timezone} · No-punch
          days stay Pending until the last shift ends, then become Leave.
          Missing historical data is never counted as leave.
        </p>
      )}
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              {metrics.map((m) => (
                <th key={m.key}>{m.label}</th>
              ))}
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.employeeId}>
                <td>
                  <strong>{e.name}</strong>
                  <div className="muted">PIN {e.pin}</div>
                </td>
                {metrics.map((m) => (
                  <td key={m.key}>
                    <button
                      className="count-link"
                      onClick={() => open(e.employeeId, m.key)}
                      aria-label={`View ${e.name}: ${m.label}`}
                    >
                      {m.time ? hours(e.totals[m.key]) : e.totals[m.key]}
                    </button>
                  </td>
                ))}
                <td>
                  <button
                    className="btn btn-sm"
                    onClick={() => open(e.employeeId)}
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
            {!employees.length && (
              <tr>
                <td colSpan={metrics.length + 2}>
                  {loading ? "Calculating month…" : "No matching employees."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Recorded hours may be estimates when IN/OUT punches are unclear.
        Overtime estimates are separate from approved minutes. Double duty can
        be detected from both shifts' coverage; review uncertain records before
        using them for payroll.
      </p>
      {employeeId && (
        <section
          className="card employee-detail"
          aria-label="Employee attendance details"
        >
          <div className="filters">
            <h3>
              {person
                ? `${person.name} · PIN ${person.pin}`
                : "Employee details"}
            </h3>
            <button
              className="btn"
              disabled={saving}
              onClick={() => changeParam("employeeId", "")}
            >
              Close view
            </button>
            <button className="btn" disabled={!person} onClick={exportDetails}>
              Download details CSV
            </button>
          </div>
          {detailLoading && <p>Loading employee details…</p>}
          {person && (
            <>
              <div className="attendance-summary">
                {metrics.slice(0, 8).map((m) => (
                  <button
                    className="card count-card"
                    key={m.key}
                    onClick={() => setFilter(m.key)}
                    aria-pressed={filter === m.key}
                  >
                    <span>{m.label}</span>
                    <strong>
                      {m.time
                        ? hours(person.totals[m.key])
                        : person.totals[m.key]}
                    </strong>
                  </button>
                ))}
              </div>
              <form className="card" onSubmit={saveDuty}>
                <h3>Change duty or approve overtime for one date</h3>
                <fieldset className="attendance-form" disabled={saving}>
                  <div className="filters">
                    <div className="field">
                      <label htmlFor="duty-date">Date</label>
                      <input
                        id="duty-date"
                        required
                        type="date"
                        value={editDate}
                        min={`${report?.month ?? month}-01`}
                        max={person.days?.[person.days.length - 1]?.date}
                        onChange={(e) => setEditDate(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="date-duty">Duty</label>
                      <select
                        id="date-duty"
                        value={kind}
                        onChange={(e) => setKind(e.target.value)}
                      >
                        {Object.entries(dutyLabels).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="approved-ot">
                        Approved overtime (minutes; blank = not reviewed)
                      </label>
                      <input
                        id="approved-ot"
                        type="number"
                        min={0}
                        max={1440}
                        step={1}
                        value={approved}
                        onChange={(e) => setApproved(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="duty-note">
                      Duty / leave / overtime note
                    </label>
                    <input
                      id="duty-note"
                      maxLength={500}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. Covered the evening duty for another employee"
                    />
                  </div>
                  <button className="btn btn-primary">
                    {saving ? "Saving…" : "Save this date"}
                  </button>
                  {saved && <span role="status"> Saved.</span>}
                </fieldset>
              </form>
              <div className="filters">
                <label htmlFor="detail-filter">Show dates</label>
                <select
                  id="detail-filter"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All dates</option>
                  {metrics.map((m) => (
                    <option key={m.key} value={m.key}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Status</th>
                      <th>Duty</th>
                      <th>All punch times</th>
                      <th>Recorded hours</th>
                      <th>OT estimate / approved</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => (
                      <tr key={d.date}>
                        <td>
                          <button
                            className="count-link"
                            onClick={() => setEditDate(d.date)}
                          >
                            {d.date}
                          </button>
                        </td>
                        <td>
                          <span className={`badge attendance-${d.status}`}>
                            {statusLabel[d.status]}
                          </span>
                          {!d.finalized && (
                            <div className="muted">Day open</div>
                          )}
                        </td>
                        <td>
                          {dutyLabels[d.dutyKind]}
                          <div className="muted">Scheduled: {format(d.shiftStart, d.timezone)} → {format(d.shiftEnd, d.timezone)}</div>
                          {d.detectedShift && (
                            <div>Covered shift {d.detectedShift}</div>
                          )}
                          {d.possibleDoubleShift && (
                            <div>Double duty detected</div>
                          )}
                          {d.dutyChanged && <div>Duty changed</div>}
                        </td>
                        <td className="attendance-punches">
                          {d.punches.length
                            ? d.punches.map((p) => (
                                <span
                                  className="attendance-punch"
                                  key={`${p.id}-${p.time}`}
                                  title={p.device}
                                >
                                  {format(p.time, d.timezone)}
                                </span>
                              ))
                            : "—"}
                        </td>
                        <td>
                          {hours(d.workedMinutes)}
                          {d.estimatedHours && (
                            <div className="muted">Estimated span</div>
                          )}
                        </td>
                        <td>
                          {hours(d.overtimeMinutes)} /{" "}
                          {hours(d.approvedOvertimeMinutes)}
                        </td>
                        <td className="attendance-notes">
                          {d.lateMinutes > 0 && (
                            <div>Late {d.lateMinutes} min (after grace)</div>
                          )}
                          {d.reviewReasons.map((reason) => (
                            <div key={reason}>{reason}</div>
                          ))}
                          {d.note && <p>{d.note}</p>}
                        </td>
                      </tr>
                    ))}
                    {!days.length && (
                      <tr>
                        <td colSpan={7}>No dates match this count.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
