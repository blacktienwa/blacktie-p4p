// Pure functions: Jobber time entry -> sheet record, and weekly overtime.
const DAY = 86400000;

export function localDate(iso, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

// Google Sheets date serial (days since 1899-12-30)
export function serial(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / DAY;
}

// Serial of the Monday that starts this serial's Mon-Sun week (1899-12-30 was a Saturday)
export function weekStart(ser) {
  return ser - ((ser + 5) % 7);
}

export function entryToRecord(n, { tz, maxHours }) {
  // Skip running timers (no end yet); they are picked up once clocked out.
  if (!n || !n.id || !n.startAt || !n.endAt || n.finalDuration == null) return null;
  let hours = Math.round((n.finalDuration / 3600) * 10000) / 10000;
  let flag = '';
  if (hours > maxHours) {
    flag = `REVIEW: ${hours.toFixed(1)}h in one entry - excluded until fixed in Jobber`;
    hours = 0;
  }
  return {
    id: n.id,
    date: serial(localDate(n.startAt, tz)),
    userId: n.user?.id || '',
    job: n.job?.jobNumber ?? '',
    hours,
    ot: 0,
    startAt: n.startAt,
    flag,
  };
}

// Overtime = hours beyond `threshold` in a Mon-Sun week, per person, in clock order.
export function computeOvertime(records, threshold = 40) {
  const order = [...records].sort((a, b) => (a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.id < b.id ? -1 : 1));
  const cum = new Map();
  for (const r of order) {
    const k = `${r.userId}|${weekStart(r.date)}`;
    const prev = cum.get(k) || 0;
    const next = prev + r.hours;
    cum.set(k, next);
    r.ot = Math.round((Math.max(0, next - threshold) - Math.max(0, prev - threshold)) * 10000) / 10000;
  }
  return order;
}
