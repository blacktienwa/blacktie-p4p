// Reads the sheet's finished numbers and shapes them into one person's dashboard view. No money math happens here.
import { TAB } from './tabs.js';

export const LEADER_MIN = 20; // $ of net p4p per hour a person must exceed to appear on the leaderboard
const q = (t) => `'${t}'`;
const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v) => String(v ?? '');
const norm = (v) => str(v).trim().toLowerCase();

// Results / history columns (A..Q)
const R = { name: 0, base: 1, hours: 2, ot: 3, basePay: 4, gross: 5, cards: 6, net: 7, over: 8, bankBegin: 9, room: 10, toBank: 11, draw: 12, bonusPaid: 13, deficit: 14, bankEnd: 15, total: 16 };
const summary = (r) => Object.fromEntries(Object.entries(R).slice(1).map(([k, i]) => [k, num(r[i])]));
const payout = (r) => ({ job: num(r[0]), period: str(r[2]), budgetHours: r[3] === '' || r[3] === undefined ? null : num(r[3]), pool: num(r[4]), hours: num(r[5]), totalHours: num(r[6]), share: num(r[7]), rate: num(r[8]), earned: num(r[9]), cards: num(r[10]), net: num(r[11]), flag: str(r[12]) });

let cache = null;
export async function loadData(sh, now = Date.now(), ttlMs = 60000) {
  if (cache && now - cache.at < ttlMs) return cache.data;
  const g = (range) => sh.get(range);
  const [emp, periods, prev, pay, jobs, hist, payHist, ledger, cards, settings] = await Promise.all([
    g(`${q(TAB.emp)}!A2:G60`), g(`${q(TAB.periods)}!A2:F60`), g(`${q(TAB.preview)}!A1:Q60`), g(`${q(TAB.payouts)}!A2:M1501`),
    g(`${q(TAB.jobs)}!A2:T1501`), g(`${q(TAB.history)}!A2:T5000`), g(`${q(TAB.payHist)}!A2:N5000`), g(`${q(TAB.ledger)}!A2:G5000`),
    g(`${q(TAB.cards)}!A2:H1501`), g(`${q(TAB.settings)}!B6`),
  ]);
  const data = {
    loadedAt: now,
    threshold: num(settings[0]?.[0]) || 1000,
    employees: emp.filter((r) => r[0]).map((r) => ({ name: str(r[0]), base: num(r[2]), rate: num(r[3]), active: norm(r[4]) !== 'no', startBank: num(r[5]) })),
    periods: periods.filter((r) => r[0]).map((r) => ({ id: str(r[0]), start: num(r[1]), end: num(r[2]), pay: num(r[3]), status: norm(r[4]) })),
    preview: prev[1]?.[0] ? { id: str(prev[1][0]), start: num(prev[1][1]), end: num(prev[1][2]), pay: num(prev[1][3]), updated: str(prev[1][4]), rows: prev.slice(4).filter((r) => r[0]) } : null,
    payouts: pay.filter((r) => r[0] && r[1]),
    excludedJobs: new Set(jobs.filter((r) => r[0] && str(r[14]) === 'Excluded').map((r) => num(r[0]))),
    jobs: new Map(jobs.filter((r) => r[0]).map((r) => [num(r[0]), { title: str(r[1]), status: str(r[2]), invoice: str(r[4]), budgetHours: r[8] === '' || r[8] === undefined ? null : num(r[8]), hours: num(r[9]), used: r[10] === '' || r[10] === undefined ? null : num(r[10]), review: str(r[14]) }])),
    history: hist.filter((r) => r[0]),
    payHist: payHist.filter((r) => r[0]),
    ledger: ledger.filter((r) => r[0]),
    cards: cards.filter((r) => r[1]).map((r) => ({ date: r[0], employee: str(r[1]), job: r[2], type: str(r[3]), amount: num(r[4]), reason: str(r[5]), period: str(r[7]) })),
  };
  cache = { at: now, data };
  return data;
}
export const clearCache = () => { cache = null; };

const jobLine = (data, p) => ({ ...p, title: data.jobs.get(p.job)?.title || '' });

// Everything one person may see. Other people's rows are never copied into the result.
export function buildView(data, name) {
  const emp = data.employees.find((e) => e.name === name);
  if (!emp) return null;
  const mine = data.payouts.filter((r) => str(r[1]) === name && !data.excludedJobs.has(num(r[0]))).map(payout);
  const frozenIds = new Set(data.periods.filter((p) => p.status === 'frozen' || p.status === 'skipped').map((p) => p.id));

  // Upcoming payroll
  let upcoming = null;
  const pv = data.preview;
  if (pv) {
    const row = pv.rows.find((r) => str(r[0]) === name);
    upcoming = {
      period: { id: pv.id, start: pv.start, end: pv.end, pay: pv.pay },
      summary: row ? summary(row) : null,
      jobs: mine.filter((p) => p.period === pv.id).sort((a, b) => a.job - b.job).map((p) => jobLine(data, p)),
      cards: data.cards.filter((c) => c.employee === name && c.period === pv.id),
    };
  }

  // Last payroll = most recent frozen period that has a history row for this person
  let last = null;
  const frozen = data.periods.filter((p) => p.status === 'frozen').sort((a, b) => b.pay - a.pay);
  for (const p of frozen) {
    const row = data.history.find((r) => str(r[0]) === p.id && str(r[3]) === name);
    if (!row) continue;
    last = {
      period: { id: p.id, start: p.start, end: p.end, pay: p.pay },
      summary: summary(row.slice(3)),
      jobs: data.payHist.filter((r) => str(r[2]) === p.id && str(r[1]) === name).map(payout).sort((a, b) => a.job - b.job).map((x) => jobLine(data, x)),
      cards: data.cards.filter((c) => c.employee === name && c.period === p.id),
    };
    break;
  }

  // Current projects: jobs they have clocked on that are not in the upcoming or a closed period
  const projects = mine
    .filter((p) => p.period !== pv?.id && !frozenIds.has(p.period))
    .sort((a, b) => b.job - a.job)
    .map((p) => {
      const j = data.jobs.get(p.job) || {};
      return { job: p.job, title: j.title || '', status: j.review || j.status || '', hours: p.hours, totalHours: p.totalHours, budgetHours: p.budgetHours, used: j.used ?? null, period: p.period, flag: p.flag };
    });

  // Bank
  const ledger = data.ledger.filter((r) => str(r[2]) === name);
  const balance = emp.startBank + ledger.reduce((s, r) => s + num(r[4]) - num(r[5]), 0);
  const bank = { balance, threshold: data.threshold, projected: upcoming?.summary ? upcoming.summary.bankEnd : null };

  return { name, rate: emp.rate, base: emp.base, updated: pv?.updated || '', upcoming, last, projects, bank };
}

// Admin overview: one line per active employee (summary figures only)
export function buildOverview(data) {
  const pv = data.preview;
  const rows = data.employees.filter((e) => e.active).map((e) => {
    const r = pv?.rows.find((x) => str(x[0]) === e.name);
    const sm = r ? summary(r) : null;
    return { name: e.name, rate: e.rate, summary: sm, perHour: sm && sm.hours > 0 ? sm.net / sm.hours : null };
  });
  // Leaderboard: net p4p per clocked hour, only figures above the cutoff.
  // Columns: the upcoming period, the last closed payroll, and the last 2 and last 6 closed payrolls combined.
  const closed = data.periods.filter((p) => p.status === 'frozen').sort((a, b) => b.pay - a.pay).map((p) => p.id);
  const perHourOver = (name, ids) => {
    let net = 0; let hours = 0;
    for (const r of data.history) if (str(r[3]) === name && ids.includes(str(r[0]))) { const sm = summary(r.slice(3)); net += sm.net; hours += sm.hours; }
    return hours > 0 ? net / hours : null;
  };
  const ok = (v) => (v !== null && v > LEADER_MIN ? v : null);
  const board = rows.map((x) => ({
    name: x.name, summary: x.summary,
    now: ok(x.perHour), last: ok(perHourOver(x.name, closed.slice(0, 1))), last2: ok(perHourOver(x.name, closed.slice(0, 2))), last6: ok(perHourOver(x.name, closed.slice(0, 6))),
  })).filter((x) => x.last !== null || x.last2 !== null || x.last6 !== null)
    .sort((a, b) => (b.last ?? -1) - (a.last ?? -1) || (b.last6 ?? -1) - (a.last6 ?? -1));
  const leaders = board;
  // Last payroll: every person's figures from the most recent closed payroll
  let last = null;
  for (const p of data.periods.filter((x) => x.status === 'frozen').sort((a, b) => b.pay - a.pay)) {
    const hist = data.history.filter((r) => str(r[0]) === p.id);
    if (!hist.length) continue;
    last = { period: { id: p.id, start: p.start, end: p.end, pay: p.pay }, rows: hist.map((r) => ({ name: str(r[3]), summary: summary(r.slice(3)) })).sort((a, b) => a.name.localeCompare(b.name)) };
    break;
  }
  const leaderPeriods = { last: closed[0] || '', last2: closed.slice(0, 2).length, last6: closed.slice(0, 6).length };
  const pending = [...data.jobs.entries()].filter(([, j]) => j.review === 'Ready for review').map(([n]) => n);
  return { period: pv ? { id: pv.id, start: pv.start, end: pv.end, pay: pv.pay } : null, updated: pv?.updated || '', rows, last, leaders, leaderPeriods, leaderMin: LEADER_MIN, readyForReview: pending };
}
