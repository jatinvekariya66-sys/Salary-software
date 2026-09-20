# Ledger Payroll Backend — Database + Autopay

This replaces browser storage with a real database. Your employees and
payroll runs now live permanently in `payroll.db` (a SQLite file created
automatically next to this server), not in one browser's local storage.
It also does the actual bank transfers via Cashfree Payouts, when you're
ready for that.

## 1. Install

```bash
npm install
cp .env.example .env
```

Open `.env` and set:
- `APP_SECRET` — make up a long random string. This is the password protecting your whole database and API.
- Cashfree fields — optional. Leave them blank and the database/app work fine; autopay (real transfers) just stays off until you fill them in.

## 2. Run it

```bash
npm start
```

You'll see something like:
`Ledger backend running on port 4000 — database: payroll.db [autopay disabled]`

A file called `payroll.db` will appear in this folder — that's your real,
permanent database. Back it up like you would any important file.

## 3. Connect the Ledger app to it

Open the Ledger app (Autopayroll.html), click **"Server settings"** in the
sidebar, and enter:
- Server URL: `http://localhost:4000` (or wherever this runs)
- App secret: the same `APP_SECRET` from your `.env`

From then on, every employee you add, every payroll run you generate, and
every "mark paid" click is saved straight to `payroll.db` — not just your
browser. Open the app from a different browser or computer with the same
server settings, and you'll see the same data.

If you never fill in server settings, the app keeps working exactly as
before, using local browser storage only — the database is opt-in.

## 4. Add Cashfree later for real autopay

Fill in `CASHFREE_CLIENT_ID` / `CASHFREE_CLIENT_SECRET` (start with sandbox
keys) in `.env` and restart the server. The app's "Send to autopay" and
"Check status" buttons will then actually call Cashfree, using the account
number, IFSC, and net pay already stored in the database — nothing to
re-enter.

## API reference (if you want to call it directly)

Every request needs the header `x-app-secret: <your APP_SECRET>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/employees` | List all employees |
| POST | `/api/employees` | Add an employee |
| PUT | `/api/employees/:id` | Update an employee |
| DELETE | `/api/employees/:id` | Remove an employee |
| GET | `/api/runs` | List all payroll runs with their entries |
| POST | `/api/runs` | Create a new payroll run |
| DELETE | `/api/runs/:runId` | Delete an entire run |
| DELETE | `/api/runs/:runId/entries/:employeeId` | Remove one person from a run |
| PATCH | `/api/runs/:runId/entries/:employeeId` | Manually set status (pending/processing/paid) |
| POST | `/api/runs/:runId/send-autopay` | Send all pending entries in a run to Cashfree |
| GET | `/api/runs/:runId/check-status` | Check Cashfree status of processing entries, update the database |

## Where this needs to run

This server needs to stay running for the app to reach it — a small VPS,
Railway, or Render all work well and keep `payroll.db` persisted on disk.
Put it behind HTTPS if it's reachable from outside your own machine, and
never share your `APP_SECRET` or `.env` file.

## Backing up your data

`payroll.db` is a single file — copying it elsewhere (or scheduling a
regular backup of it) is your entire backup strategy. No separate database
server or account to worry about.
