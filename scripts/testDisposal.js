'use strict';

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const { hash } = require('bcryptjs');
const app = require('../server');
const disposalModel = require('../models/disposalModel');
const assignmentModel = require('../models/assetAssignmentModel');

const PORT = process.env.DISPOSAL_TEST_PORT || 3994;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const userIds = [];
const categoryIds = [];
const assetIds = [];
const disposalIds = [];
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
    const email = `${username}@nbsz.co.zw`;
    const password = `Ds-${Date.now()}-Test!`;
    const [found] = await db.query('SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1', [username, email]);
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
    if (disposalIds.length) {
        await db.query('DELETE FROM audit_logs WHERE table_name = ? AND record_id IN (?)', ['asset_disposals', disposalIds]);
        await db.query('DELETE FROM asset_disposals WHERE id IN (?)', [disposalIds]);
    }
    if (assetIds.length) {
        await db.query('DELETE FROM audit_logs WHERE table_name = ? AND record_id IN (?)', ['assets', assetIds]);
        await db.query('DELETE FROM assets WHERE id IN (?)', [assetIds]);
    }
    if (categoryIds.length) {
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
    await assignmentModel.ensureTable();
    await disposalModel.ensureTable();

    const stamp = Date.now().toString().slice(-8);
    const ict = await createUser(`disposal_ict_${stamp}`, 'ICT Officer');
    const admin = await createUser(`disposal_admin_${stamp}`, 'System Administrator');
    const login = async (user) => {
        const response = await request('POST', '/api/auth/login', {
            body: { username: user.username, password: user.password }
        });
        return response.body?.data?.token;
    };
    const ictToken = await login(ict);
    const adminToken = await login(admin);
    check('Test roles can authenticate', Boolean(ictToken && adminToken));
    if (!ictToken || !adminToken) return;

    const [category] = await db.query(
        'INSERT INTO asset_categories (name, description) VALUES (?, ?)',
        [`Disposal ${stamp}`, 'Disposal fixture']
    );
    categoryIds.push(category.insertId);

    async function createAsset(tag, status) {
        const response = await request('POST', '/api/assets', {
            token: ictToken,
            body: {
                asset_tag: tag,
                serial_number: `${tag}-SN`,
                category_id: category.insertId,
                manufacturer: 'Test',
                model: 'Disposal fixture',
                status,
                condition_status: 'Fair',
                location: 'Test Location',
                department: 'ICT'
            }
        });
        const id = response.body?.data?.asset?.id;
        if (id) assetIds.push(id);
        return { response, id };
    }

    const eligible = await createAsset(`DS-${stamp}-A`, 'In Use');
    const repair = await createAsset(`DS-${stamp}-B`, 'Under Repair');
    check('Test assets created', Boolean(eligible.id && repair.id));

    const meta = await request('GET', '/api/disposals/meta', { token: ictToken });
    check('Disposal options are available', meta.status === 200 && meta.body?.data?.methods?.includes('Recycling'), meta.raw);

    const badRequest = await request('POST', '/api/disposals', { token: ictToken, body: { asset_id: eligible.id } });
    check('Required disposal fields are validated', badRequest.status === 400, badRequest.raw);

    const createRequest = await request('POST', '/api/disposals', {
        token: ictToken,
        body: {
            asset_id: eligible.id,
            reason: 'End of useful life',
            disposal_method: 'Recycling',
            requested_disposal_date: '2026-10-12',
            final_condition: 'Obsolete',
            data_destroyed: true,
            data_destroyed_at: '2026-10-10',
            data_destruction_reference: 'DEST-TEST-1'
        }
    });
    const disposalId = createRequest.body?.data?.id;
    if (disposalId) disposalIds.push(disposalId);
    check('Disposal request is saved pending approval', createRequest.status === 201 &&
        createRequest.body?.data?.status === 'Pending Approval', createRequest.raw);

    const disposalStats = await request('GET', '/api/disposals/stats', { token: ictToken });
    check('Workflow summary reports pending disposal approvals',
        disposalStats.status === 200 && Number(disposalStats.body?.data?.pendingApproval) >= 1,
        disposalStats.raw);

    const duplicate = await request('POST', '/api/disposals', {
        token: ictToken,
        body: {
            asset_id: eligible.id,
            reason: 'Duplicate',
            disposal_method: 'Recycling',
            requested_disposal_date: '2026-10-12',
            final_condition: 'Obsolete'
        }
    });
    check('Duplicate open requests are rejected', duplicate.status === 409, duplicate.raw);

    const repairRequest = await request('POST', '/api/disposals', {
        token: ictToken,
        body: {
            asset_id: repair.id,
            reason: 'Repair fixture',
            disposal_method: 'Recycling',
            requested_disposal_date: '2026-10-12',
            final_condition: 'Damaged'
        }
    });
    check('Assets under repair cannot be submitted', repairRequest.status === 409, repairRequest.raw);

    const selfApprove = await request('POST', `/api/disposals/${disposalId}/approve`, { token: ictToken, body: {} });
    check('ICT Officer cannot approve disposal', selfApprove.status === 403, selfApprove.raw);
    const requesterApprove = await request('POST', `/api/disposals/${disposalId}/approve`, { token: ictToken, body: {} });
    check('Requester cannot approve own request', requesterApprove.status === 403, requesterApprove.raw);

    const approved = await request('POST', `/api/disposals/${disposalId}/approve`, { token: adminToken, body: {} });
    check('Administrator approves a different user request', approved.status === 200 &&
        approved.body?.data?.status === 'Approved', approved.raw);

    const complete = await request('POST', `/api/disposals/${disposalId}/complete`, { token: ictToken, body: {} });
    check('Approved disposal is completed', complete.status === 200 &&
        complete.body?.data?.status === 'Completed', complete.raw);
    const [disposedAsset] = await db.query('SELECT status, condition_status FROM assets WHERE id = ?', [eligible.id]);
    check('Asset is retained in register as disposed', disposedAsset[0]?.status === 'Disposed' &&
        disposedAsset[0]?.condition_status === 'Obsolete');

    const list = await request('GET', '/api/disposals', { token: adminToken });
    check('Disposal register lists recorded requests', list.status === 200 &&
        list.body?.data?.items?.some((record) => Number(record.id) === disposalId), list.raw);
    const detail = await request('GET', `/api/disposals/${disposalId}`, { token: adminToken });
    check('Disposal details retain data destruction evidence', detail.status === 200 &&
        Number(detail.body?.data?.data_destroyed) === 1 &&
        detail.body?.data?.data_destruction_reference === 'DEST-TEST-1', detail.raw);
}

server = app.listen(PORT, async () => {
    console.log(`\nDisposal integration tests on port ${PORT}`);
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
            console.log(`\nDisposal tests: ${passed}/${results.length} passed.`);
            process.exit(passed === results.length ? 0 : 1);
        });
        setTimeout(() => {
            const passed = results.filter(Boolean).length;
            process.exit(passed === results.length ? 0 : 1);
        }, 3000).unref();
    }
});
