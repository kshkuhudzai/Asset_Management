'use strict';

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const { hash } = require('bcryptjs');
const app = require('../server');
const licenceModel = require('../models/licenceModel');

const PORT = process.env.LICENCE_TEST_PORT || 3993;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const userIds = [];
const licenceIds = [];
const allocationIds = [];
let server;
let db;

function check(name, passed, detail) {
    results.push(Boolean(passed));
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${!passed && detail ? `: ${detail}` : ''}`);
}

function request(method, path, { body, token } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = { Accept: 'application/json' };
        if (payload !== null) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (token) headers.Authorization = `Bearer ${token}`;
        const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = raw ? JSON.parse(raw) : null;
                } catch {
                    parsed = raw;
                }
                resolve({ status: res.statusCode, body: parsed, raw });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

async function createUser(username, role) {
    const password = `Lc-${Date.now()}-Test!`;
    const email = `${username}@nbsz.co.zw`;
    const [found] = await db.query(
        'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
        [username, email]
    );
    if (found.length) return { id: found[0].id, username, password };
    const passwordHash = await hash(password, 10);
    const [created] = await db.query(
        `INSERT INTO users (username, password_hash, email, full_name, role, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [username, passwordHash, email, username, role]
    );
    userIds.push(created.insertId);
    return { id: created.insertId, username, password };
}

async function cleanup() {
    if (!db) return;
    if (licenceIds.length) {
        await db.query(
            `DELETE FROM audit_logs
              WHERE (table_name = 'software_licences' AND record_id IN (?))
                 OR (table_name = 'software_licence_allocations' AND record_id IN (?))`,
            [licenceIds, allocationIds.length ? allocationIds : [-1]]
        );
        await db.query('DELETE FROM software_licence_allocations WHERE licence_id IN (?)', [licenceIds]);
        await db.query('DELETE FROM software_licences WHERE id IN (?)', [licenceIds]);
    }
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
    await licenceModel.ensureTables();
    const stamp = Date.now().toString().slice(-8);
    const ict = await createUser(`licence_ict_${stamp}`, 'ICT Officer');
    const departmental = await createUser(`licence_dept_${stamp}`, 'Departmental User');

    async function login(user) {
        const response = await request('POST', '/api/auth/login', {
            body: { username: user.username, password: user.password }
        });
        return response.body?.data?.token;
    }
    const token = await login(ict);
    const deptToken = await login(departmental);
    check('Test users authenticated', Boolean(token && deptToken));
    if (!token || !deptToken) return;

    const denied = await request('POST', '/api/licences', {
        token: deptToken,
        body: { software_name: 'Denied', purchased_quantity: 1 }
    });
    check('Departmental user cannot create licences', denied.status === 403, denied.raw);

    const meta = await request('GET', '/api/licences/meta', { token });
    check('Licence metadata includes supported licence types', meta.status === 200 &&
        meta.body?.data?.types?.includes('Subscription'), meta.raw);

    const invalid = await request('POST', '/api/licences', {
        token,
        body: { software_name: '', purchased_quantity: 0, licence_type: 'Invalid' }
    });
    check('Invalid licence fields are rejected', invalid.status === 400, invalid.raw);

    const created = await request('POST', '/api/licences', {
        token,
        body: {
            software_name: `Suite ${stamp}`,
            publisher: 'Example Publisher',
            licence_type: 'Per User',
            purchase_reference: `PO-${stamp}`,
            purchased_quantity: 3,
            purchased_date: '2026-01-01',
            expiry_date: '2027-01-01',
            unit_cost: 100,
            currency: 'USD'
        }
    });
    const licenceId = created.body?.data?.id;
    if (licenceId) licenceIds.push(licenceId);
    check('Licence is created with generated reference', created.status === 201 &&
        created.body?.data?.licence_ref?.startsWith('LIC-'), created.raw);
    if (!licenceId) return;

    const listed = await request('GET', '/api/licences', { token });
    const listRow = listed.body?.data?.items?.find((row) => Number(row.id) === licenceId);
    check('List shows purchased and available seat counts', listed.status === 200 &&
        Number(listRow?.purchased_quantity) === 3 && Number(listRow?.available_quantity) === 3, listed.raw);

    const allocation = await request('POST', `/api/licences/${licenceId}/allocations`, {
        token,
        body: { user_id: ict.id, quantity: 2, notes: 'Test allocation' }
    });
    const allocationId = allocation.body?.data?.id;
    if (allocationId) allocationIds.push(allocationId);
    check('Licence seats are allocated to an active user', allocation.status === 201 &&
        Number(allocation.body?.data?.quantity) === 2, allocation.raw);

    const overAllocate = await request('POST', `/api/licences/${licenceId}/allocations`, {
        token,
        body: { user_id: ict.id, quantity: 2 }
    });
    check('Allocation cannot exceed purchased quantity', overAllocate.status === 409, overAllocate.raw);

    const reduceBelowAllocated = await request('PUT', `/api/licences/${licenceId}`, {
        token,
        body: { purchased_quantity: 1 }
    });
    check('Purchased quantity cannot fall below allocations', reduceBelowAllocated.status === 409, reduceBelowAllocated.raw);

    const retireAllocated = await request('PATCH', `/api/licences/${licenceId}/status`, {
        token,
        body: { status: 'Retired' }
    });
    check('Licence with active allocations cannot be retired', retireAllocated.status === 409, retireAllocated.raw);

    const detail = await request('GET', `/api/licences/${licenceId}`, { token });
    check('Detail includes allocation history', detail.status === 200 &&
        detail.body?.data?.allocations?.length === 1, detail.raw);

    const release = await request('POST', `/api/licences/${licenceId}/allocations/${allocationId}/release`, {
        token,
        body: {}
    });
    check('Allocation can be released', release.status === 200, release.raw);

    const stats = await request('GET', '/api/licences/stats', { token });
    check('Licence summary totals are numeric', stats.status === 200 &&
        typeof stats.body?.data?.purchased === 'number' &&
        typeof stats.body?.data?.allocated === 'number', stats.raw);

    const invalidExpiry = await request('GET', '/api/licences/expiring?days=999999', { token });
    check('Expiry alert window is bounded', invalidExpiry.status === 400, invalidExpiry.raw);
}

server = app.listen(PORT, async () => {
    console.log(`\nLicence integration tests on port ${PORT}`);
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
            console.log(`\nLicence tests: ${passed}/${results.length} passed.`);
            process.exit(passed === results.length ? 0 : 1);
        });
        setTimeout(() => {
            const passed = results.filter(Boolean).length;
            process.exit(passed === results.length ? 0 : 1);
        }, 3000).unref();
    }
});
