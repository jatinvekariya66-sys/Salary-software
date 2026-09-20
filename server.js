/**
 * Ledger payroll backend — database + autopay, in one server.
 * ------------------------------------------------------------
 * Employees and payroll runs are stored permanently in payroll.db
 * (SQLite, created automatically next to this file) instead of the
 * browser's local storage — so your data lives in one place, safe from
 * a cleared cache or a different device.
 *
 * It also does the actual money-moving step for a run, via Cashfree
 * Payouts, using the account/IFSC/net-pay already sitting in the database.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const db = require('./db');

const {
  CASHFREE_CLIENT_ID,
  CASHFREE_CLIENT_SECRET,
  CASHFREE_ENV,
  CASHFREE_API_VERSION,
  APP_SECRET,
  PORT,
  ENABLE_SCHEDULE,
  CRON_SCHEDULE,
} = process.env;

if (!APP_SECRET) {
  console.error('Missing APP_SECRET in .env — set a long random value. This protects your whole database and API.');
  process.exit(1);
}

const cashfreeEnabled = !!(CASHFREE_CLIENT_ID && CASHFREE_CLIENT_SECRET);
if (!cashfreeEnabled) {
  console.warn('CASHFREE_CLIENT_ID / SECRET not set — the database and app will work fine, but autopay (actual transfers) will be disabled until you add them.');
}

const BASE_URL = CASHFREE_ENV === 'production'
  ? 'https://api.cashfree.com/payout'
  : 'https://sandbox.cashfree.com/payout';

const cf = cashfreeEnabled ? axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
    'x-api-version': CASHFREE_API_VERSION || '2024-01-01',
    'x-client-id': CASHFREE_CLIENT_ID,
    'x-client-secret': CASHFREE_CLIENT_SECRET,
  },
  timeout: 15000,
}) : null;

async function ensureBeneficiary(entry) {
  const beneficiaryId = `emp_${entry.employeeId}`.slice(0, 40);
  try {
    await cf.post('/beneficiary', {
      beneficiary_id: beneficiaryId,
      beneficiary_name: entry.name,
      beneficiary_instrument_details: { bank_account_number: entry.accountNumber, bank_ifsc: entry.ifsc },
    });
  } catch (err) {
    const msg = err.response?.data?.message || '';
    if (err.response?.status !== 409 && !/already exists/i.test(msg)) {
      throw new Error(`Beneficiary setup failed for ${entry.name}: ${msg || err.message}`);
    }
  }
  return beneficiaryId;
}
async function requestTransfer(entry, beneficiaryId, periodLabel) {
  const transferId = `sal_${entry.employeeId}_${periodLabel}`.replace(/\s+/g, '').slice(0, 40);
  const res = await cf.post('/transfers', {
    transfer_id: transferId,
    transfer_amount: entry.net,
    transfer_mode: 'banktransfer',
    remarks: `Salary ${periodLabel}`.slice(0, 70),
    beneficiary_details: { beneficiary_id: beneficiaryId },
  });
  return { transferId, status: res.data.status };
}
async function getTransferStatus(transferId) {
  const res = await cf.get('/transfers', { params: { transfer_id: transferId } });
  return res.data;
}

// ---------- HTTP API ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, cashfreeEnabled, env: CASHFREE_ENV || 'sandbox' }));

app.use((req, res, next) => {
  if (req.headers['x-app-secret'] !== APP_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ----- Employees -----
app.get('/api/employees', (req, res) => res.json(db.listEmployees()));

app.post('/api/employees', (req, res) => {
  const { name, role, base, allowances, deductions, accountNumber, ifsc, active } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.status(201).json(db.createEmployee({
    name, role: role || '—', base: Number(base) || 0, allowances: Number(allowances) || 0,
    deductions: Number(deductions) || 0, accountNumber: accountNumber || '', ifsc: ifsc || '',
    active: active !== false,
  }));
});

app.put('/api/employees/:id', (req, res) => {
  const { name, role, base, allowances, deductions, accountNumber, ifsc, active } = req.body;
  const updated = db.updateEmployee(req.params.id, {
    name, role: role || '—', base: Number(base) || 0, allowances: Number(allowances) || 0,
    deductions: Number(deductions) || 0, accountNumber: accountNumber || '', ifsc: ifsc || '',
    active: active !== false,
  });
  if (!updated) return res.status(404).json({ error: 'Employee not found' });
  res.json(updated);
});

app.delete('/api/employees/:id', (req, res) => { db.deleteEmployee(req.params.id); res.status(204).end(); });

// ----- Payroll runs -----
app.get('/api/runs', (req, res) => res.json(db.listRuns()));

app.post('/api/runs', (req, res) => {
  const { month, year, label, entries } = req.body;
  if (month == null || year == null || !label || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'month, year, label, and a non-empty entries array are required' });
  }
  res.status(201).json(db.createRun({ month, year, label, entries }));
});

app.delete('/api/runs/:runId', (req, res) => { db.deleteRun(req.params.runId); res.status(204).end(); });

app.delete('/api/runs/:runId/entries/:employeeId', (req, res) => {
  db.deleteEntry(req.params.runId, req.params.employeeId);
  res.status(204).end();
});

app.patch('/api/runs/:runId/entries/:employeeId', (req, res) => {
  const { status, transferId, paidAt } = req.body;
  if (!['pending', 'processing', 'paid'].includes(status)) return res.status(400).json({ error: 'invalid status' });
  db.updateEntryStatus(req.params.runId, req.params.employeeId, { status, transferId, paidAt });
  res.json(db.getEntry(req.params.runId, req.params.employeeId));
});

// ----- Autopay (Cashfree), acting directly on the database -----
app.post('/api/runs/:runId/send-autopay', async (req, res) => {
  if (!cashfreeEnabled) return res.status(400).json({ error: 'Cashfree credentials are not configured on this server yet.' });
  const run = db.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const periodLabel = `${run.year}-${String(run.month + 1).padStart(2, '0')}`;
  const results = [];
  for (const entry of run.entries) {
    if (entry.status !== 'pending') { continue; }
    if (!entry.accountNumber || !entry.ifsc) {
      results.push({ employeeId: entry.employeeId, name: entry.name, status: 'failed', error: 'Missing account number or IFSC' });
      continue;
    }
    try {
      const beneficiaryId = await ensureBeneficiary(entry);
      const { transferId } = await requestTransfer(entry, beneficiaryId, periodLabel);
      db.updateEntryStatus(run.id, entry.employeeId, { status: 'processing', transferId });
      results.push({ employeeId: entry.employeeId, name: entry.name, status: 'processing', transferId });
    } catch (err) {
      results.push({ employeeId: entry.employeeId, name: entry.name, status: 'failed', error: err.response?.data?.message || err.message });
    }
  }
  res.json({ periodLabel, results });
});

app.get('/api/runs/:runId/check-status', async (req, res) => {
  if (!cashfreeEnabled) return res.status(400).json({ error: 'Cashfree credentials are not configured on this server yet.' });
  const run = db.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const results = [];
  for (const entry of run.entries) {
    if (entry.status !== 'processing' || !entry.transferId) continue;
    try {
      const data = await getTransferStatus(entry.transferId);
      const status = (data.transfer_status || data.status || '').toUpperCase();
      if (status === 'SUCCESS') {
        db.updateEntryStatus(run.id, entry.employeeId, { status: 'paid', transferId: entry.transferId, paidAt: new Date().toISOString() });
        results.push({ employeeId: entry.employeeId, name: entry.name, result: 'paid' });
      } else if (status === 'FAILED' || status === 'REVERSED') {
        db.updateEntryStatus(run.id, entry.employeeId, { status: 'pending' });
        results.push({ employeeId: entry.employeeId, name: entry.name, result: 'failed', status });
      } else {
        results.push({ employeeId: entry.employeeId, name: entry.name, result: 'still_processing', status });
      }
    } catch (err) {
      results.push({ employeeId: entry.employeeId, name: entry.name, result: 'check_failed', error: err.response?.data?.message || err.message });
    }
  }
  res.json({ results });
});

app.listen(PORT || 4000, () => {
  console.log(`Ledger backend running on port ${PORT || 4000} — database: payroll.db [autopay ${cashfreeEnabled ? 'enabled' : 'disabled'}]`);
});

// ---------- optional automatic schedule ----------
if (ENABLE_SCHEDULE === 'true' && cashfreeEnabled) {
  cron.schedule(CRON_SCHEDULE || '0 9 1 * *', async () => {
    console.log('Scheduled autopay check triggered — add logic here to pick the current run and send it, once you know which run should run automatically each month.');
  });
  console.log(`Scheduled runs enabled: "${CRON_SCHEDULE || '0 9 1 * *'}"`);
}
