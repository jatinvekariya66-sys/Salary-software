/**
 * SQLite database for the Ledger payroll app.
 * Creates payroll.db on first run, right next to this file, and keeps
 * every employee and payroll run in it permanently — independent of any
 * one browser or device.
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'payroll.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT,
    base REAL DEFAULT 0,
    allowances REAL DEFAULT 0,
    deductions REAL DEFAULT 0,
    account_number TEXT,
    ifsc TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payroll_runs (
    id TEXT PRIMARY KEY,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payroll_entries (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT,
    base REAL DEFAULT 0,
    allowances REAL DEFAULT 0,
    deductions REAL DEFAULT 0,
    bonus REAL DEFAULT 0,
    adjustment REAL DEFAULT 0,
    net REAL NOT NULL,
    account_number TEXT,
    ifsc TEXT,
    status TEXT DEFAULT 'pending',
    transfer_id TEXT,
    paid_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_entries_run ON payroll_entries(run_id);
`);

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- employees ----------
function listEmployees() {
  return db.prepare('SELECT * FROM employees ORDER BY created_at ASC').all().map(rowToEmployee);
}
function createEmployee(data) {
  const id = uid();
  db.prepare(`INSERT INTO employees (id,name,role,base,allowances,deductions,account_number,ifsc,active)
              VALUES (@id,@name,@role,@base,@allowances,@deductions,@accountNumber,@ifsc,@active)`)
    .run({ id, ...data, active: data.active ? 1 : 0 });
  return rowToEmployee(db.prepare('SELECT * FROM employees WHERE id=?').get(id));
}
function updateEmployee(id, data) {
  const existing = db.prepare('SELECT * FROM employees WHERE id=?').get(id);
  if (!existing) return null;
  db.prepare(`UPDATE employees SET name=@name, role=@role, base=@base, allowances=@allowances,
              deductions=@deductions, account_number=@accountNumber, ifsc=@ifsc, active=@active WHERE id=@id`)
    .run({ id, ...data, active: data.active ? 1 : 0 });
  return rowToEmployee(db.prepare('SELECT * FROM employees WHERE id=?').get(id));
}
function deleteEmployee(id) {
  db.prepare('DELETE FROM employees WHERE id=?').run(id);
}
function rowToEmployee(r) {
  if (!r) return null;
  return {
    id: r.id, name: r.name, role: r.role, base: r.base, allowances: r.allowances,
    deductions: r.deductions, accountNumber: r.account_number, ifsc: r.ifsc, active: !!r.active,
  };
}

// ---------- payroll runs ----------
const listRunsStmt = db.prepare('SELECT * FROM payroll_runs ORDER BY created_at DESC');
const listEntriesStmt = db.prepare('SELECT * FROM payroll_entries WHERE run_id=?');

function listRuns() {
  return listRunsStmt.all().map(run => ({
    id: run.id, month: run.month, year: run.year, label: run.label, createdAt: run.created_at,
    entries: listEntriesStmt.all(run.id).map(rowToEntry),
  }));
}
function getRun(runId) {
  const run = db.prepare('SELECT * FROM payroll_runs WHERE id=?').get(runId);
  if (!run) return null;
  return { id: run.id, month: run.month, year: run.year, label: run.label, createdAt: run.created_at,
           entries: listEntriesStmt.all(runId).map(rowToEntry) };
}
function createRun({ month, year, label, entries }) {
  const runId = uid();
  const insertRun = db.prepare('INSERT INTO payroll_runs (id,month,year,label) VALUES (?,?,?,?)');
  const insertEntry = db.prepare(`INSERT INTO payroll_entries
    (id,run_id,employee_id,name,role,base,allowances,deductions,bonus,adjustment,net,account_number,ifsc,status)
    VALUES (@id,@runId,@employeeId,@name,@role,@base,@allowances,@deductions,@bonus,@adjustment,@net,@accountNumber,@ifsc,'pending')`);
  const tx = db.transaction(() => {
    insertRun.run(runId, month, year, label);
    for (const e of entries) {
      insertEntry.run({ id: uid(), runId, ...e });
    }
  });
  tx();
  return getRun(runId);
}
function deleteRun(runId) {
  db.prepare('DELETE FROM payroll_runs WHERE id=?').run(runId);
}
function deleteEntry(runId, employeeId) {
  db.prepare('DELETE FROM payroll_entries WHERE run_id=? AND employee_id=?').run(runId, employeeId);
  const remaining = db.prepare('SELECT COUNT(*) AS c FROM payroll_entries WHERE run_id=?').get(runId);
  if (remaining.c === 0) deleteRun(runId);
}
function updateEntryStatus(runId, employeeId, { status, transferId, paidAt }) {
  db.prepare(`UPDATE payroll_entries SET status=?, transfer_id=?, paid_at=? WHERE run_id=? AND employee_id=?`)
    .run(status, transferId || null, paidAt || null, runId, employeeId);
}
function getEntry(runId, employeeId) {
  const r = db.prepare('SELECT * FROM payroll_entries WHERE run_id=? AND employee_id=?').get(runId, employeeId);
  return rowToEntry(r);
}
function rowToEntry(r) {
  if (!r) return null;
  return {
    employeeId: r.employee_id, name: r.name, role: r.role, base: r.base, allowances: r.allowances,
    deductions: r.deductions, bonus: r.bonus, adjustment: r.adjustment, net: r.net,
    accountNumber: r.account_number, ifsc: r.ifsc, status: r.status, transferId: r.transfer_id, paidAt: r.paid_at,
  };
}

module.exports = {
  listEmployees, createEmployee, updateEmployee, deleteEmployee,
  listRuns, getRun, createRun, deleteRun, deleteEntry, updateEntryStatus, getEntry,
};
