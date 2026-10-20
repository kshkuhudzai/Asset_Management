'use strict';

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const { hash } = require('bcryptjs');
const { unzipSync, strFromU8 } = require('fflate');
const app = require('../server');
const assignmentModel = require('../models/assetAssignmentModel');
const transferModel = require('../models/transferModel');
const maintenanceModel = require('../models/maintenanceModel');
const warrantyModel = require('../models/warrantyModel');
const stockModel = require('../models/stockModel');
const verificationModel = require('../models/verificationModel');
const disposalModel = require('../models/disposalModel');
const licenceModel = require('../models/licenceModel');

const PORT = Number(process.env.REPORT_TEST_PORT || 3998);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const userIds = [];
let server;
let db;

function check(name, passed, detail) {
    results.push(Boolean(passed));
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${!passed && detail ? `: ${detail}` : ''}`);
}

function isValidPdf(buffer) {
    if (!Buffer.isBuffer(buffer)) return false;
    const text = buffer.toString('latin1');
    const startXref = text.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
    const pageCount = text.match(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/);
    return text.startsWith('%PDF-') &&
        text.includes('/Type /Page') &&
        Number(pageCount?.[1]) >= 1 &&
        Boolean(startXref) &&
        text.slice(Number(startXref[1]), Number(startXref[1]) + 4) === 'xref';
}

function request(method, path, token) {
    return new Promise((resolve, reject) => {
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const raw = buffer.toString('utf8');
                let body;
                const contentType = res.headers['content-type'] || '';
                if (contentType.includes('application/json')) {
                    try {
                        body = raw ? JSON.parse(raw) : null;
                    } catch {
                        body = raw;
                    }
                } else {
                    body = buffer;
                }
                resolve({ status: res.statusCode, headers: res.headers, body, raw });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

async function createUser(username, role) {
    const password = `Report-${Date.now()}-${Math.random()}!`;
    const passwordHash = await hash(password, 10);
    const [created] = await db.query(
        `INSERT INTO users (username, password_hash, email, full_name, role, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [username, passwordHash, `${username}@nbsz.co.zw`, username, role]
    );
    userIds.push(created.insertId);
    return { id: created.insertId, username, password };
}

async function authenticate(user) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ username: user.username, password: user.password });
        const req = http.request(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(raw).data.token);
                } catch (error) {
                    reject(new Error(`Login failed (${res.statusCode}): ${raw}`));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function cleanup() {
    if (!db) return;
    if (userIds.length) {
        await db.query('DELETE FROM audit_logs WHERE user_id IN (?)', [userIds]);
        await db.query('DELETE FROM users WHERE id IN (?)', [userIds]);
    }
    await db.end();
}

async function run() {
    db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });
    await assignmentModel.ensureTable();
    await transferModel.ensureTable();
    await maintenanceModel.ensureTable();
    await warrantyModel.ensureTable();
    await stockModel.ensureTable();
    await verificationModel.ensureTables();
    await disposalModel.ensureTable();
    await licenceModel.ensureTables();

    const stamp = Date.now().toString().slice(-8);
    const auditor = await createUser(`report_auditor_${stamp}`, 'Auditor');
    const departmental = await createUser(`report_department_${stamp}`, 'Departmental User');
    const auditorToken = await authenticate(auditor);
    const departmentalToken = await authenticate(departmental);
    check('Report test roles authenticate', Boolean(auditorToken && departmentalToken));

    const unauthorized = await request('GET', '/api/reports/types');
    check('Reports require authentication', unauthorized.status === 401, unauthorized.raw);

    const denied = await request('GET', '/api/reports/types', departmentalToken);
    check('Departmental users cannot access organization-wide reports', denied.status === 403, denied.raw);

    const types = await request('GET', '/api/reports/types', auditorToken);
    const available = types.body?.data || [];
    check('Auditors can view the report catalogue',
        types.status === 200 && available.length >= 8 && available.some((item) => item.type === 'asset_register'),
        types.raw);

    const summary = await request('GET', '/api/reports/summary', auditorToken);
    check('Summary includes lifecycle metrics',
        summary.status === 200 && summary.body?.data?.assets &&
        summary.body?.data?.maintenance && summary.body?.data?.licences, summary.raw);

    const unauthorizedExport = await request('GET', '/api/reports/asset_register/export?format=xlsx');
    check('Exports require authentication', unauthorizedExport.status === 401, unauthorizedExport.raw);

    const workbook = await request(
        'GET',
        '/api/reports/asset_register/export?format=xlsx&search=report_export_fixture_no_match',
        auditorToken
    );
    let workbookValid = false;
    if (workbook.status === 200 && Buffer.isBuffer(workbook.body)) {
        try {
            const files = unzipSync(workbook.body);
            const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
            workbookValid = sheet.includes('Asset ID') &&
                workbook.headers['content-type']?.includes('spreadsheetml.sheet') &&
                workbook.headers['content-disposition']?.includes('asset_register.xlsx');
        } catch (error) {
            workbookValid = false;
        }
    }
    check('Excel export is a valid filtered workbook', workbookValid, workbook.raw);

    const pdf = await request(
        'GET',
        '/api/reports/asset_register/export?format=pdf&search=report_export_fixture_no_match',
        auditorToken
    );
    check('PDF export returns a downloadable PDF',
        pdf.status === 200 && isValidPdf(pdf.body) &&
        pdf.headers['content-type'] === 'application/pdf', pdf.raw);

    const invalidExport = await request(
        'GET',
        '/api/reports/asset_register/export?format=csv',
        auditorToken
    );
    check('Unsupported server export formats are rejected', invalidExport.status === 400, invalidExport.raw);

    let reportFailures = 0;
    for (const item of available) {
        const response = await request('GET', `/api/reports/${encodeURIComponent(item.type)}`, auditorToken);
        if (response.status !== 200 || !Array.isArray(response.body?.data?.rows) ||
            !Array.isArray(response.body?.data?.columns)) {
            reportFailures += 1;
            console.log(`  [FAIL] ${item.title} report loads: ${response.raw}`);
        }
    }
    check('Every report returns tabular data', reportFailures === 0, `${reportFailures} report(s) failed`);

    const invalidDate = await request('GET', '/api/reports/asset_register?from=not-a-date', auditorToken);
    check('Invalid report dates are rejected', invalidDate.status === 400, invalidDate.raw);

    const invalidRange = await request(
        'GET',
        '/api/reports/asset_register?from=2026-12-31&to=2026-01-01',
        auditorToken
    );
    check('Reversed report date ranges are rejected', invalidRange.status === 400, invalidRange.raw);

    const filtered = await request(
        'GET',
        '/api/reports/asset_register?search=unlikely_report_test_value%27%20OR%201%3D1%20--',
        auditorToken
    );
    check('Search filters are parameterized', filtered.status === 200 &&
        filtered.body?.data?.rows?.length === 0, filtered.raw);

    const unsupportedFilter = await request('GET', '/api/reports/licences?department=ICT', auditorToken);
    check('Unsupported report filters are rejected', unsupportedFilter.status === 400, unsupportedFilter.raw);

    const missingReport = await request('GET', '/api/reports/not-a-report', auditorToken);
    check('Unknown report types return not found', missingReport.status === 404, missingReport.raw);
}

server = app.listen(PORT, async () => {
    console.log(`\nReports integration tests on port ${PORT}`);
    try {
        await run();
    } catch (error) {
        console.error(error);
        results.push(false);
    } finally {
        try {
            await cleanup();
        } catch (error) {
            console.error('Cleanup failed:', error.message);
            results.push(false);
        }
        server.close(() => {
            const passed = results.filter(Boolean).length;
            console.log(`\nReports tests: ${passed}/${results.length} passed.`);
            process.exit(passed === results.length ? 0 : 1);
        });
        setTimeout(() => {
            const passed = results.filter(Boolean).length;
            process.exit(passed === results.length ? 0 : 1);
        }, 3000).unref();
    }
});
