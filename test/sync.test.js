import test from 'node:test';
import assert from 'node:assert/strict';
import { entryToRecord, computeOvertime, serial, weekStart, localDate } from '../lib/transform.js';
import { autoMap } from '../lib/mapping.js';
import { encrypt } from '../lib/crypto.js';
import { makeEnv, installFakes } from './harness.js';

const ID = (n) => `Z2lkOi8vSm9iYmVyL1VzZXIv${Buffer.from(String(n)).toString('base64')}`;
const TE = (n) => `Z2lkOi8vSm9iYmVyL1RpbWVTaGVldEVudHJ5Lz${n}`;
const opts = { tz: 'America/Chicago', maxHours: 16 };

test('entryToRecord: seconds to hours, local date, null job', () => {
  const r = entryToRecord({ id: 'Z2lk1', startAt: '2026-10-20T03:30:00Z', endAt: '2026-10-20T05:00:00Z', finalDuration: 5400, user: { id: 'u' } }, opts);
  assert.equal(r.hours, 1.5);
  assert.equal(r.job, '');
  assert.equal(localDate('2026-10-20T03:30:00Z', 'America/Chicago'), '2026-10-19'); // 10:30pm Central on the 19th
  assert.equal(r.date, serial('2026-10-19'));
});

test('entryToRecord: running timers skipped, huge entries flagged and excluded', () => {
  assert.equal(entryToRecord({ id: 'a', startAt: '2026-10-20T10:00:00Z', endAt: null, finalDuration: null }, opts), null);
  const r = entryToRecord({ id: 'Z2lk2', startAt: '2021-11-10T01:57:00Z', endAt: '2022-01-14T12:30:11Z', finalDuration: 5653991, user: { id: 'u' }, job: { jobNumber: 2548 } }, opts);
  assert.equal(r.hours, 0);
  assert.match(r.flag, /REVIEW: 1570\.6h/);
});

test('weekStart is Monday', () => {
  assert.equal(weekStart(serial('2026-10-19')), serial('2026-10-19')); // Monday
  assert.equal(weekStart(serial('2026-10-25')), serial('2026-10-19')); // Sunday
  assert.equal(weekStart(serial('2026-10-26')), serial('2026-10-26')); // next Monday
});

test('computeOvertime: only hours past 40 in a Mon-Sun week, per person', () => {
  const mk = (id, day, hrs, u = 'u1') => ({ id, userId: u, date: serial(day), hours: hrs, ot: 0, startAt: `${day}T12:00:00Z` });
  const recs = [mk('a', '2026-10-19', 20), mk('b', '2026-10-20', 20), mk('c', '2026-10-21', 3), mk('d', '2026-10-26', 10), mk('e', '2026-10-19', 45, 'u2')];
  const out = Object.fromEntries(computeOvertime(recs).map((r) => [r.id, r.ot]));
  assert.deepEqual(out, { a: 0, b: 0, c: 3, d: 0, e: 5 });
});

test('autoMap links unambiguous names and aliases, flags the rest', () => {
  const users = new Map([[ID(1), 'Michael Maddan'], [ID(2), 'Sam' + 'uel Gil'], [ID(3), 'Jake Welch'], [ID(4), 'Jake Welch']]);
  const { updates, unmatched } = autoMap([
    { row: 2, name: 'Michael Madden', current: 'Michael Madden' },
    { row: 3, name: 'Sam Gil', current: 'Sam Gil' },
    { row: 4, name: 'Jake Welch', current: 'Jake Welch' },
    { row: 5, name: 'Daniel Agustin', current: '' },
    { row: 6, name: 'Already Done', current: ID(9) },
  ], users);
  assert.deepEqual(updates.map((u) => [u.row, u.id]), [[2, ID(1)], [3, ID(2)]]);
  assert.equal(unmatched.length, 2);
});

function fixtureEntries() {
  const e = [];
  const add = (n, user, name, startISO, secs, job, updatedAt = '2026-10-31T00:00:00Z') =>
    e.push({ id: TE(n), startAt: startISO, endAt: new Date(Date.parse(startISO) + secs * 1000).toISOString(), finalDuration: secs, user: { id: ID(user), name: { full: name } }, job: job ? { jobNumber: job } : null, updatedAt });
  add(1, 1, 'Michael Maddan', '2026-10-19T12:00:00Z', 8 * 3600, 9333);
  add(2, 1, 'Michael Maddan', '2026-10-20T12:00:00Z', 8 * 3600, 9333);
  add(3, 1, 'Michael Maddan', '2026-10-21T12:00:00Z', 8 * 3600, 9333);
  add(4, 1, 'Michael Maddan', '2026-10-22T12:00:00Z', 8 * 3600, 9333);
  add(5, 1, 'Michael Maddan', '2026-10-23T12:00:00Z', 8 * 3600, 9333);
  add(6, 1, 'Michael Maddan', '2026-10-24T12:00:00Z', 2 * 3600, null); // Saturday, 42h that week -> 2h OT
  add(7, 2, 'Samuel Gil', '2026-10-19T12:00:00Z', 5 * 3600, 9335);
  add(8, 3, 'Jeremy Moore', '2021-11-10T01:57:00Z', 5653991, 2548); // forgotten clock-out (outside backfill window though)
  add(9, 3, 'Jeremy Moore', '2026-10-21T12:00:00Z', 20 * 3600, 9340); // over the 16h limit
  e.push({ id: TE(10), startAt: '2026-10-25T12:00:00Z', endAt: null, finalDuration: null, user: { id: ID(2), name: { full: 'Samuel Gil' } }, job: { jobNumber: 9335 }, updatedAt: '2026-10-31T00:00:00Z' }); // running
  return e;
}

test('full sync: backfill then incremental, mapping, overtime, flags, no duplicates', async () => {
  makeEnv();
  const entries = fixtureEntries();
  const sheets = {
    'Jobber Time': [['Time Entry ID'], ['T-0001', 46000, 'Michael Madden', 1042, 10, 0]], // legacy sample row must be dropped
    Employees: [['Employee Name', 'Jobber User ID'], ['Michael Madden', 'Michael Madden'], ['Sam Gil', 'Sam Gil'], ['Daniel Agustin', 'Daniel Agustin']],
    'Sync State': [['Key', 'Value'], ['jobber_refresh', encrypt('R0')]],
  };
  const fake = installFakes({ sheets, entries });
  const { runSync } = await import('../lib/sync.js');

  const r1 = await runSync();
  assert.equal(r1.ok, true);
  assert.equal(r1.mode, 'backfill');
  assert.equal(fake.log.tokenCalls[0].grant_type, 'refresh_token');
  assert.equal(fake.log.tokenCalls[0].refresh_token, 'R0');

  const time = sheets['Jobber Time'].slice(1).filter((r) => r[0]);
  assert.equal(time.length, 8); // 10 entries - 1 running - 1 before the backfill window
  assert.ok(!time.some((r) => r[0] === 'T-0001'));
  const ot = time.reduce((s, r) => s + (r[5] || 0), 0);
  assert.equal(ot, 2);
  const flagged = time.filter((r) => r[10]);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0][4], 0);

  assert.equal(sheets.Employees[1][1], ID(1)); // Michael Madden -> Michael Maddan
  assert.equal(sheets.Employees[2][1], ID(2)); // Sam Gil -> Samuel Gil
  assert.equal(sheets.Employees[3][1], 'Daniel Agustin'); // not seen yet, left alone
  assert.ok(sheets['Jobber Users'].length >= 4);
  assert.equal(sheets['Sync Log'].at(-1)[1], 'OK');

  const state = Object.fromEntries(sheets['Sync State'].slice(1).filter((r) => r[0]));
  assert.equal(state.backfill_done, '1');
  assert.equal(state.lock_until, '0');
  assert.ok(!state.grid_through || Number(state.grid_through) >= 5001); // formulas already exist through row 5001

  // Second run: the running timer finishes and an old entry is edited
  entries.find((e) => e.id === TE(10)).endAt = '2026-10-25T17:00:00Z';
  entries.find((e) => e.id === TE(10)).finalDuration = 5 * 3600;
  entries.find((e) => e.id === TE(10)).updatedAt = '2099-01-01T00:00:00Z';
  const r2 = await runSync();
  assert.equal(r2.mode, 'incremental');
  const time2 = sheets['Jobber Time'].slice(1).filter((r) => r[0]);
  assert.equal(time2.length, 9);
  assert.equal(new Set(time2.map((r) => r[0])).size, 9);
  assert.ok(r2.added >= 1);
  assert.ok(fake.log.tokenCalls.length === 1, 'access token reused, not refreshed again');
});

test('growth: past row 5001 the sync extends the grid, formulas and formats', async () => {
  makeEnv();
  const entries = [];
  for (let i = 0; i < 3100; i++) {
    const start = new Date(Date.parse('2026-08-03T12:00:00Z') + i * 3600e3).toISOString();
    entries.push({ id: TE(1000 + i), startAt: start, endAt: new Date(Date.parse(start) + 1800e3).toISOString(), finalDuration: 1800, user: { id: ID(1), name: { full: 'Michael Maddan' } }, job: { jobNumber: 9000 + (i % 7) }, updatedAt: '2026-10-31T00:00:00Z' });
  }
  const sheets = { 'Jobber Time': [['Time Entry ID']], Employees: [['Employee Name', 'Jobber User ID']], 'Sync State': [['Key', 'Value'], ['jobber_refresh', encrypt('R0')]] };
  const fake = installFakes({ sheets, entries });
  const { runSync } = await import('../lib/sync.js');
  const r = await runSync();
  assert.equal(r.fetched, 3100);
  const state = Object.fromEntries(sheets['Sync State'].slice(1).filter((x) => x[0]));
  assert.equal(Number(state.grid_through), 3101 + 2000);
  const row = sheets['Jobber Time'][5100]; // sheet row 5101
  assert.match(row[6], /^=IF\(C5101=/);
  assert.match(row[7], /Payroll Periods/);
  assert.ok(fake.meta.get('Jobber Time').rowCount >= 5101);
});
