[README.md](https://github.com/user-attachments/files/35164184/README.md)
# Black Tie P4P sync (stage 1: time entries)

Pulls clocked time from Jobber into your Google Sheet several times a day. Money math stays in the sheet's formulas.

**What it does each run**
- Reads time entries (job number, person, hours) from Jobber and updates the `Jobber Time` tab (columns A-F, I, K). Hours = seconds / 3600.
- Calculates weekly overtime (hours past 40, Monday-Sunday, Central time) into column F.
- Excludes any single entry over 16 hours (a forgotten clock-out), puts 0 hours in the sheet, and writes `REVIEW...` in the Flag column (K). Fix the entry in Jobber and the next run picks up the correction.
- Skips timers that are still running; they are picked up after clock-out.
- Fills the `Jobber Users` tab (every person who clocked time, with their Jobber ID) and links `Employees!B` to the right Jobber ID when the name matches exactly one person.
- Writes a line to the `Sync Log` tab each run.

**Not in this stage:** job status, completion dates and invoice paid dates (Job Budgets column G, the period override, still handles these), and the employee dashboard.

## One-time setup

### 1. Fix the sheet's row limits (2 minutes)
The sheet's formulas stop at row 5000, and the timesheet data will pass that in a few weeks.
1. In the Google Sheet: **Edit -> Find and replace**.
2. Find: `$5000`   Replace with: `$20000`
3. Search: **All sheets**. Tick **Also search within formulas**. Click **Replace all**.

### 2. GitHub
Unzip this folder on your computer. In your empty `blacktie-p4p` repository click **uploading an existing file**, drag in everything inside the unzipped folder (the `api`, `lib` and `test` folders plus the loose files), and click **Commit changes**.

### 3. Vercel
1. **Add New -> Project**, import `blacktie-p4p`. Framework preset: **Other**. Leave the build settings alone.
2. Before deploying, open **Environment Variables** and add these (all environments):

| Name | Value |
|---|---|
| `SHEET_ID` | `1gEjSbYeOR559ETNIGbRMtCD8Rf8aqf46TozY7BG9JQw` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The full contents of the JSON key file you downloaded from Google |
| `JOBBER_CLIENT_ID` | Your app's Client ID from the Jobber Developer Center |
| `JOBBER_CLIENT_SECRET` | The app's Client Secret (secret) |
| `JOBBER_REDIRECT_URI` | `https://YOUR-PROJECT.vercel.app/api/jobber/callback` (must match the Developer Center exactly) |
| `ENCRYPTION_KEY` | Any random string of 40+ characters (a password manager can generate one). Protects the Jobber tokens stored in the sheet |
| `SETUP_KEY` | Any random string of 24+ characters. You use it to start the connection and run manual syncs |
| `CRON_SECRET` | Any random string of 24+ characters. Vercel uses it to prove scheduled runs are genuine |

Optional: `BACKFILL_START` (default `2026-08-01`), `TIMEZONE` (default `America/Chicago`), `MAX_ENTRY_HOURS` (default `16`), `ALERT_WEBHOOK_URL` (gets a JSON POST with a `text` field when a sync fails).

3. Click **Deploy**. Confirm the project is on the **Pro** plan: the schedule runs three times a day (see `vercel.json`) and the Hobby plan rejects that.

### 4. Jobber
In the Developer Center, make sure the app's **OAuth Callback URL** equals `JOBBER_REDIRECT_URI`.

### 5. Connect (Jeremy does this once)
While logged in to Jobber as the admin, open:
`https://YOUR-PROJECT.vercel.app/api/jobber/connect?key=YOUR_SETUP_KEY`
Click **Allow Access**. You should land on a page saying "Connected to <your company>".
Do not use "Test in GraphiQL" on this app afterwards. It cancels the connection's refresh token.

### 6. First sync
Open `https://YOUR-PROJECT.vercel.app/api/sync?key=YOUR_SETUP_KEY`. The first run loads history from `BACKFILL_START`. If the response says the backfill is not finished, open the link again. When it says "Backfill complete", it keeps itself up to date on the schedule.

Then check the sheet: `Jobber Time` filled in, `Jobber Users` listing everyone, `Employees!B` holding long IDs, and `Sync Log` showing OK.

## Troubleshooting
- **"permission denied" / 403 from Google:** the sheet isn't shared with the service account as Editor, or `SHEET_ID` is wrong.
- **"Jobber is not connected":** repeat step 5.
- **Employee not linked:** see `Sync Log` notes. Copy that person's ID from the `Jobber Users` tab into `Employees!B` by hand.
- **Schedule:** edit `vercel.json` (times are UTC; `0 12,17,22 * * *` is 7am, 12pm and 5pm Central daylight time).
- **Tests:** `npm test` runs the logic checks against fake Jobber and Google services.


## Cafeteria plan and leaderboard

**What it does**
- Every payroll period set to **Frozen** earns each eligible person a deposit: hours worked in the period (overtime included) × their $/hr rate × their hours-tier %.
  - **Rate** comes from the cafeteria sheet's `Rates` tab, using their Role (Technician or Mgmt) and completed years since Hire Date at the end of the period.
  - **Hours tier** comes from `Hours Tiers`: their average weekly hours over the last 6 months (25 or less = 25%, over 25 and under 30 = 75%, 30 or more = 100%). Weeks before their hire date, or before the Jobber time history starts, are left out of the average.
  - The deposit is split into banks by their split % on `Employees`.
- Each sync also posts approved withdrawal requests and rewrites the `Balances` tab.
- Employees see their bank balances, last deposit, request form, request status and recent activity on their page. A request larger than the available amount (balance minus requests already waiting) is refused.
- The leaderboard shows the top 10 from the last frozen payroll: P4P after yellow and red cards ÷ hours worked, plus efficiency (actual hours ÷ budget hours on the jobs paid that payroll). People outside the top 10 also see their own rank. The admin page shows everyone.

### One-time setup
1. In Google Drive create a blank Google Sheet named **Black Tie Cafeteria Plan**. Click **Share**, add the service account's email (the `client_email` from the Google key, the same one the main sheet is shared with) as **Editor**.
2. Copy the new sheet's ID: the long part of its address between `/d/` and `/edit`.
3. In Vercel: **Settings -> Environment Variables**, add `CAFE_SHEET_ID` = that ID (all environments). Then **Deployments -> ... -> Redeploy**.
4. Open `https://YOUR-PROJECT.vercel.app/api/cafe?key=YOUR_SETUP_KEY`. It builds the tabs and lists everyone from Jobber on `Employees`. Jake Welch, Kyle Ungerer and Ramon Casillas are set to Eligible = No. Tyler Eldridge, Kat Weaver and Tony Spencer are added as cafeteria-only.
5. On the cafeteria sheet's `Employees` tab, fill in for each eligible person: **Role** (`Technician` or `Mgmt`), **Hire Date**, a **split %** for each bank (must total 100), and an **opening $** for each bank (their balance as of the end of the last payroll before the start period).
6. On `Settings`, check **Start deposits with period**. It defaults to the next payroll that isn't frozen yet. Opening balances must cover everything before it.
7. Open `https://YOUR-PROJECT.vercel.app/api/access?key=YOUR_SETUP_KEY` once more. It creates links and PINs for Tyler, Kat and Tony (shown once, like before).

To post right away instead of waiting for the next sync, open the cafe link with `&run=1` on the end.

### Day to day
- **Approve or deny a request:** on the `Requests` tab, set Status to `Approved` or `Denied` (add an Office Note if you like). Approved requests post as withdrawals at the next sync. If the bank no longer covers the request, it is not posted and column I says why.
- **Withdrawals the office makes directly:** add a row on `Ledger`: date, employee, bank, type `Withdrawal`, a positive amount, and a note. Leave the Key column empty. Use type `Adjustment` with a + or - amount for corrections.
- **Don't edit** `Deposits`, `Balances`, or the Key column. Deposits post once per person per period; to redo one, delete that person's row on `Deposits` and their `DEP|...` rows on `Ledger`, then run a sync.
- **Adding a bank:** add its name to `Banks` on `Settings`, then open the cafe setup link again to add its columns.
- Setup problems (missing role, hire date, or a split that isn't 100%) appear in the `Sync Log` as warnings. That person's deposit posts at the first sync after it's fixed.

## Page tabs
Each person's page has tabs: **Pay** (P4P people), **Benefits** (cafeteria plan members), **Leaderboard** and **Standards** (everyone). The Standards text lives in `lib/standards.js`; edit the wording there and upload that file to change it.
