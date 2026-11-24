// HTML pages for the dashboard. Plain server-rendered HTML, phone first, light and dark.
import { escapeHtml as e } from './http.js';

const usd = (n) => (n === null || n === undefined || Number.isNaN(n) ? '' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const hrs = (n) => (Number(n) || 0).toFixed(2);
const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
const sdate = (s) => (s ? new Date(Date.UTC(1899, 11, 30) + s * 86400000).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '');
const ldate = (s) => (s ? new Date(Date.UTC(1899, 11, 30) + s * 86400000).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '');
const stamp = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

const CSS = `
:root{--bg:#f5f3ef;--card:#fff;--fg:#1d2420;--mute:#66706a;--line:#e3dfd7;--brand:#14513a;--brand-fg:#fff;--good:#146c43;--bad:#a4262c;--warn:#8a5a00;--yellow:#f2c230;--red:#c8372d;--track:#e8e4db}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121815;--card:#1b231f;--fg:#e9ede9;--mute:#9aa59e;--line:#2b362f;--brand:#59b58d;--brand-fg:#0d1511;--good:#6fcf9a;--bad:#ff8a84;--warn:#e6b450;--track:#2b362f;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:20px 48px}
main{max-width:46rem;margin:0 auto;display:grid;gap:16px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{font-size:1.4rem;margin:0}h2{font-size:1.05rem;margin:0 0 10px}small,.mute{color:var(--mute)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;min-width:0}
.big{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:12px;margin:8px 0 12px}
.big div{display:grid;gap:2px}.big b{font-size:1.5rem;font-variant-numeric:tabular-nums}.big span{color:var(--mute);font-size:.85rem}
.pos{color:var(--good)}.neg{color:var(--bad)}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.92rem}
th,td{text-align:right;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th:first-child,td:first-child{text-align:left}th{color:var(--mute);font-weight:600;font-size:.8rem}
td.t{white-space:normal;text-align:left;min-width:9rem}tfoot td{font-weight:700;border-bottom:0}
.bar{height:10px;background:var(--track);border-radius:6px;overflow:hidden;margin:6px 0}.bar i{display:block;height:100%;background:var(--brand)}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:.78rem;border:1px solid var(--line);color:var(--mute)}
.card-row{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line)}.card-row:last-child{border-bottom:0}
.dot{width:14px;height:18px;border-radius:3px;flex:none;margin-top:3px}.y{background:var(--yellow)}.r{background:var(--red)}
.note{margin:8px 0 0;font-size:.9rem;color:var(--mute)}
form{display:grid;gap:12px}input{font:inherit;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);letter-spacing:.3em;text-align:center}
button,.btn{font:inherit;padding:12px 16px;border-radius:8px;border:0;background:var(--brand);color:var(--brand-fg);font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
a{color:var(--brand)}.brand{text-align:center;padding:16px 16px 0}.brand img{max-width:220px;max-height:90px;width:auto;height:auto;background:#fff;border-radius:10px;padding:6px 10px}.err{color:var(--bad)}.top a{font-size:.9rem}
`;

export const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>${e(title)}</title><style>${CSS}</style></head><body><div class="brand"><img src="/logo.jpg" alt="Black Tie" onerror="this.parentNode.style.display='none'"></div><main>${body}</main></body></html>`;

export function renderLogin({ name, error, locked }) {
  return shell('Black Tie Pay', `<section><h1>${name ? e(name) : 'Black Tie'}</h1><p class="mute">Enter your 6-digit PIN.</p>
<form method="post" autocomplete="off"><input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" aria-label="PIN" required autofocus>
${error ? `<div class="err" role="alert">${e(error)}</div>` : ''}<button type="submit"${locked ? ' disabled' : ''}>Open</button></form></section>`);
}

export const renderNotFound = () => shell('Black Tie Pay', '<section><h1>Black Tie</h1><p>This link is not valid. Ask the office for your link.</p></section>');

function moneyLine(label, v, cls = '') { return `<tr><td>${e(label)}</td><td class="${cls}">${usd(v)}</td></tr>`; }

function jobsTable(jobs, empty) {
  if (!jobs.length) return `<p class="note">${e(empty)}</p>`;
  const tot = jobs.reduce((t, j) => ({ earned: t.earned + j.earned, cards: t.cards + j.cards, net: t.net + j.net, hours: t.hours + j.hours }), { earned: 0, cards: 0, net: 0, hours: 0 });
  return `<div class="wrap"><table><thead><tr><th>Job</th><th>My hrs</th><th>Share</th><th>P4P</th><th>Cards</th><th>Net</th></tr></thead><tbody>${jobs.map((j) => `<tr><td class="t">#${j.job}${j.title ? ` <small>${e(j.title)}</small>` : ''}${j.flag ? ` <span class="pill">${e(j.flag.toLowerCase())}</span>` : ''}</td><td>${hrs(j.hours)}</td><td>${pct(j.share)}</td><td>${usd(j.earned)}</td><td>${j.cards ? usd(-j.cards) : ''}</td><td>${usd(j.net)}</td></tr>`).join('')}</tbody><tfoot><tr><td>Total</td><td>${hrs(tot.hours)}</td><td></td><td>${usd(tot.earned)}</td><td>${tot.cards ? usd(-tot.cards) : ''}</td><td>${usd(tot.net)}</td></tr></tfoot></table></div>`;
}

function cardsBlock(cards, label) {
  if (!cards.length) return `<p class="note">No cards ${e(label)}.</p>`;
  const total = cards.reduce((s, c) => s + c.amount, 0);
  return `${cards.map((c) => `<div class="card-row"><span class="dot ${/red/i.test(c.type) ? 'r' : 'y'}" aria-hidden="true"></span><div style="flex:1"><b>${e(c.type || 'Card')}</b> · job #${e(c.job)}<div class="mute">${e(c.reason)}</div></div><b>${usd(-c.amount)}</b></div>`).join('')}<p class="note">Total deducted: <b>${usd(total)}</b></p>`;
}

function payrollBlock(title, p, emptyMsg) {
  if (!p) return `<section><h2>${e(title)}</h2><p class="note">${e(emptyMsg)}</p></section>`;
  const s = p.summary;
  const dir = !s ? '' : s.over >= 0 ? `Your p4p is ${usd(s.over)} above base pay.` : `Your p4p is ${usd(-s.over)} under base pay. Base pay is still paid in full; the gap comes out of your bank.`;
  return `<section><h2>${e(title)}</h2><p class="mute">${e(sdate(p.period.start))} to ${e(sdate(p.period.end))} · paid ${e(ldate(p.period.pay))}</p>
${s ? `<div class="big"><div><b>${usd(s.basePay)}</b><span>Base pay (${hrs(s.hours)} hrs${s.ot ? `, ${hrs(s.ot)} OT` : ''})</span></div><div><b>${usd(s.net)}</b><span>Net p4p after cards</span></div><div><b class="${s.over >= 0 ? 'pos' : 'neg'}">${usd(s.over)}</b><span>Over / (under) base</span></div></div><p class="note">${e(dir)}</p>
<div class="wrap"><table><tbody>${moneyLine('Gross p4p', s.gross)}${moneyLine('Card deductions', -s.cards)}${moneyLine('Added to bank', s.toBank)}${moneyLine('Drawn from bank', s.draw)}${moneyLine('Bonus paid out', s.bonusPaid, s.bonusPaid > 0 ? 'pos' : '')}${moneyLine('Total pay (base + bonus)', s.total)}</tbody></table></div>` : '<p class="note">No figures for you in this period yet.</p>'}
<h2 style="margin-top:16px">Jobs in this payroll</h2>${jobsTable(p.jobs, 'No approved jobs for you in this payroll yet.')}
<h2 style="margin-top:16px">Cards</h2>${cardsBlock(p.cards, 'in this payroll')}</section>`;
}

function bankBlock(b) {
  const w = Math.max(0, Math.min(1, b.balance / b.threshold));
  return `<section><h2>Bank</h2><div class="big"><div><b class="${b.balance < 0 ? 'neg' : ''}">${usd(b.balance)}</b><span>Balance after your last payroll</span></div>${b.projected === null ? '' : `<div><b class="${b.projected < 0 ? 'neg' : ''}">${usd(b.projected)}</b><span>After the upcoming payroll</span></div>`}</div>
<div class="bar" role="img" aria-label="Bank progress to ${usd(b.threshold)}"><i style="width:${Math.round(w * 100)}%"></i></div>
<p class="note">${b.balance >= b.threshold ? `You have reached the ${usd(b.threshold)} threshold. All of your bonus is paid out.` : `Threshold: ${usd(b.threshold)}. Until you reach it, half of any bonus goes to your bank.`}</p></section>`;
}

function projectsBlock(list) {
  if (!list.length) return `<section><h2>Current projects</h2><p class="note">No open projects with your hours.</p></section>`;
  return `<section><h2>Current projects</h2><div class="wrap"><table><thead><tr><th>Job</th><th>My hrs</th><th>Job hrs</th><th>Budget</th><th>Used</th></tr></thead><tbody>${list.map((p) => `<tr><td class="t">#${p.job}${p.title ? ` <small>${e(p.title)}</small>` : ''}<br><span class="pill">${e(p.period ? `pays ${p.period}` : p.status || 'in progress')}</span>${p.flag ? ` <span class="pill">${e(p.flag.toLowerCase())}</span>` : ''}</td><td>${hrs(p.hours)}</td><td>${hrs(p.totalHours)}</td><td>${p.budgetHours === null ? '—' : hrs(p.budgetHours)}</td><td>${p.used === null ? '' : pct(p.used)}</td></tr>`).join('')}</tbody></table></div>
<p class="note">Jobs finish and pay out once the office approves them.</p></section>`;
}

export function renderEmployee(v, { back, logout } = {}) {
  return shell('Black Tie Pay', `<header><div><h1>${e(v.name)}</h1><small>Updated ${e(stamp(v.updated))}</small></div><div class="top">${back ? `<a href="${e(back)}">All employees</a> · ` : ''}${logout ? `<a href="${e(logout)}">Sign out</a>` : ''}</div></header>
${payrollBlock('Upcoming payroll', v.upcoming, 'No open payroll period yet.')}${bankBlock(v.bank)}${projectsBlock(v.projects)}${payrollBlock('Last payroll', v.last, 'No payroll has been closed yet.')}`);
}

function leaderBlock(o) {
  const rows = o.leaders || [];
  const lp = o.leaderPeriods || {};
  const cell = (v) => (v === null ? '<td class="mute">-</td>' : `<td>${usd(v)}</td>`);
  return `<section><h2>Leaderboard</h2><p class="mute">Net p4p per clocked hour. A figure shows only when it is above ${usd(o.leaderMin)}/hr. Based on closed payrolls only (last 2 = ${lp.last2 || 0} closed, last 6 = ${lp.last6 || 0} closed so far).</p>${rows.length ? `<div class="wrap"><table><thead><tr><th>#</th><th>Employee</th><th>Previous payroll</th><th>Last 2 payrolls</th><th>Last 6 payrolls</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${e(r.name)}</td>${cell(r.last)}${cell(r.last2)}${cell(r.last6)}</tr>`).join('')}</tbody></table></div>` : '<p>Nobody is above the cutoff yet.</p>'}</section>`;
}
export function renderOverview(o, { base, logout } = {}) {
  return shell('Black Tie Pay - Admin', `<header><div><h1>All employees</h1><small>${o.period ? `${e(o.period.id)} · ${e(sdate(o.period.start))} to ${e(sdate(o.period.end))} · paid ${e(ldate(o.period.pay))} · updated ${e(stamp(o.updated))}` : 'No open payroll period'}</small></div><div class="top">${logout ? `<a href="${e(logout)}">Sign out</a>` : ''}</div></header>
${o.readyForReview.length ? `<section><h2>Needs your review</h2><p>${o.readyForReview.length} completed and paid job(s) are waiting for approval: ${e(o.readyForReview.slice(0, 25).map((n) => `#${n}`).join(', '))}${o.readyForReview.length > 25 ? '…' : ''}. Approve them in the Job Budgets tab.</p></section>` : ''}
<section><div class="wrap"><table><thead><tr><th>Employee</th><th>Base</th><th>Net p4p</th><th>Over/(under)</th><th>Bonus paid</th><th>Bank before</th><th>Bank after</th></tr></thead><tbody>${o.rows.map((r) => `<tr><td><a href="${e(base)}?e=${encodeURIComponent(r.name)}">${e(r.name)}</a></td>${r.summary ? `<td>${usd(r.summary.basePay)}</td><td>${usd(r.summary.net)}</td><td class="${r.summary.over >= 0 ? 'pos' : 'neg'}">${usd(r.summary.over)}</td><td>${usd(r.summary.bonusPaid)}</td><td class="${r.summary.bankBegin < 0 ? 'neg' : ''}">${usd(r.summary.bankBegin)}</td><td class="${r.summary.bankEnd < 0 ? 'neg' : ''}">${usd(r.summary.bankEnd)}</td>` : '<td colspan="6" class="mute">no figures</td>'}</tr>`).join('')}</tbody></table></div></section>
${leaderBlock(o)}`);
}

export const renderAccessPage = ({ rows, base, created, key }) => shell('Dashboard links', `<section><h1>Dashboard links and PINs</h1>
<p class="note">A PIN is shown only once, right after it is created. Give each person their link and PIN privately. To make a new PIN, use "New PIN".</p>
<div class="wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Link</th><th>PIN</th><th></th></tr></thead><tbody>${rows.map((r) => { const c = created.find((x) => x.name === r.name && x.role === r.role); const path = r.role === 'admin' ? 'a' : 'd'; return `<tr><td>${e(r.name)}</td><td>${e(r.role)}</td><td class="t" style="word-break:break-all"><a href="${e(`${base}/${path}/${r.code}`)}">${e(`${base}/${path}/${r.code}`)}</a></td><td><b>${c ? e(c.pin) : '••••••'}</b></td><td><a href="?reset=${encodeURIComponent(r.name)}&amp;role=${encodeURIComponent(r.role)}&amp;key=${encodeURIComponent(key)}">New PIN</a></td></tr>`; }).join('')}</tbody></table></div></section>`);
