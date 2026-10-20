'use strict';

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const { hash } = require('bcryptjs');
const app = require('../server');
const verificationModel = require('../models/verificationModel');

const PORT = process.env.VERIFICATION_TEST_PORT || 3995;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const assetIds = [];
const categoryIds = [];
const exerciseIds = [];
const itemIds = [];
const userIds = [];
let server;
let db;

function check(name, passed, detail) {
    results.push({ name, passed: Boolean(passed) });
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
    const email = `${username}@nbsz.co.zw`;
    const password = `Vf-${Date.now()}-Test!`;
    const [existing] = await db.query(
        'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1',
        [username, email]
    );
    if (existing.length) return { id: existing[0].id, username, password };
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
    if (exerciseIds.length) {
        await db.query(
            `DELETE FROM audit_logs
              WHERE (table_name = 'asset_verifications' AND record_id IN (?))
                 OR (table_name = 'asset_verification_items' AND record_id IN (?))`,
            [exerciseIds, itemIds.length ? itemIds : [-1]]
        );
        await db.query('DELETE FROM asset_verification_items WHERE verification_id IN (?)', [exerciseIds]);
        await db.query('DELETE FROM asset_verifications WHERE id IN (?)', [exerciseIds]);
    }
    if (assetIds.length) {
        await db.query(
            `DELETE FROM audit_logs WHERE table_name = 'assets' AND record_id IN (?)`,
            [assetIds]
        );
        await db.query('DELETE FROM assets WHERE id IN (?)', [assetIds]);
    }
    if (categoryIds.length) {
        await db.query(
            `DELETE FROM audit_logs WHERE table_name = 'asset_categories' AND record_id IN (?)`,
            [categoryIds]
        );
        await db.query('DELETE FROM asset_categories WHERE id IN (?)', [categoryIds]);
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
    await verificationModel.ensureTables();

    const stamp = Date.now().toString().slice(-8);
    const ict = await createUser(`verify_ict_${stamp}`, 'ICT Officer');
    const departmental = await createUser(`verify_dept_${stamp}`, 'Departmental User');
    const ictLogin = await request('POST', '/api/auth/login', {
        body: { username: ict.username, password: ict.password }
    });
    const token = ictLogin.body && ictLogin.body.data && ictLogin.body.data.token;
    check('ICT Officer can authenticate', ictLogin.status === 200 && Boolean(token), ictLogin.raw);
    if (!token) return;

    const denied = await request('POST', '/api/verifications', {
        token: (await request('POST', '/api/auth/login', {
            body: { username: departmental.username, password: departmental.password }
        })).body?.data?.token,
        body: { name: 'Not allowed' }
    });
    check('Departmental users cannot create exercises', denied.status === 403, denied.raw);

    const meta = await request('GET', '/api/verifications/meta', { token });
    check('Verification metadata is available', meta.status === 200 &&
        meta.body?.data?.results?.includes('Incorrect Location'), meta.raw);

    const [categoryResult] = await db.query(
        'INSERT INTO asset_categories (name, description) VALUES (?, ?)',
        [`Verification ${stamp}`, 'Verification test category']
    );
    const categoryId = categoryResult.insertId;
    categoryIds.push(categoryId);
    check('Test category created', Boolean(categoryId));

    const asset = await request('POST', '/api/assets', {
        token,
        body: {
            asset_tag: `VF-${stamp}`,
            serial_number: `VF-SN-${stamp}`,
            category_id: categoryId,
            manufacturer: 'Test',
            model: 'Verification Fixture',
            department: `Verification ${stamp}`,
            location: 'Test Location',
            status: 'In Use',
            condition_status: 'Good'
        }
    });
    const assetId = asset.body?.data?.asset?.id;
    if (assetId) assetIds.push(assetId);
    check('Test asset created', asset.status === 201 && Boolean(assetId), asset.raw);
    if (!assetId) return;

    const created = await request('POST', '/api/verifications', {
        token,
        body: {
            name: `Verification ${stamp}`,
            department: `Verification ${stamp}`,
            location: 'Test Location',
            category_id: categoryId
        }
    });
    const exerciseId = created.body?.data?.id;
    if (exerciseId) exerciseIds.push(exerciseId);
    check('Exercise created with asset snapshot', created.status === 201 &&
        Number(created.body?.data?.total_assets) === 1, created.raw);
    if (!exerciseId) return;

    const detail = await request('GET', `/api/verifications/${exerciseId}`, { token });
    const item = detail.body?.data?.items?.[0];
    if (item) itemIds.push(item.id);
    check('Exercise includes a pending asset', detail.status === 200 &&
        item?.result === 'Pending' && Number(item.asset_id) === Number(assetId), detail.raw);

    const pendingComplete = await request('PATCH', `/api/verifications/${exerciseId}/complete`, {
        token,
        body: {}
    });
    check('Exercise cannot complete while assets are pending', pendingComplete.status === 409, pendingComplete.raw);

    const invalid = await request('PATCH', `/api/verifications/${exerciseId}/items/${item?.id}`, {
        token,
        body: { result: 'Unknown' }
    });
    check('Invalid verification result is rejected', invalid.status === 400, invalid.raw);

    const updated = await request('PATCH', `/api/verifications/${exerciseId}/items/${item.id}`, {
        token,
        body: { result: 'Incorrect Location', actual_location: 'Room 12', notes: 'Fixture exception' }
    });
    check('Asset verification result is recorded', updated.status === 200 &&
        updated.body?.data?.result === 'Incorrect Location', updated.raw);

    const exceptions = await request('GET', `/api/verifications/${exerciseId}/exceptions`, { token });
    check('Exception report includes the incorrectly located asset', exceptions.status === 200 &&
        exceptions.body?.data?.total === 1, exceptions.raw);

    const completed = await request('PATCH', `/api/verifications/${exerciseId}/complete`, {
        token,
        body: {}
    });
    check('Completed exercise retains exception totals', completed.status === 200 &&
        completed.body?.data?.status === 'Completed' &&
        Number(completed.body?.data?.exceptions) === 1, completed.raw);

    const locked = await request('PATCH', `/api/verifications/${exerciseId}/items/${item.id}`, {
        token,
        body: { result: 'Verified' }
    });
    check('Completed exercise results cannot be changed', locked.status === 404, locked.raw);
}

server = app.listen(PORT, async () => {
    console.log(`\nVerification integration tests on port ${PORT}`);
    try {
        await run();
    } catch (error) {
        console.error(error);
        results.push({ name: 'Suite execution', passed: false });
    } finally {
        try {
            await cleanup();
        } catch (error) {
            console.error('Cleanup failed:', error.message);
            results.push({ name: 'Fixture cleanup', passed: false });
        }
        server.close(() => {
            const passed = results.filter((result) => result.passed).length;
            console.log(`\nVerification tests: ${passed}/${results.length} passed.`);
            process.exit(passed === results.length ? 0 : 1);
        });
        setTimeout(() => {
            const passed = results.filter((result) => result.passed).length;
            process.exit(passed === results.length ? 0 : 1);
        }, 3000).unref();
    }
});
