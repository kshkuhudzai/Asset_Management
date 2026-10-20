'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');
const { hash } = require('bcryptjs');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', require('../routes/authRoutes'));
app.use('/api/assets', require('../routes/assetRoutes'));
app.use('/api/procurement', require('../routes/procurementRoutes'));
const procurementModel = require('../models/procurementModel');

const PORT = process.env.PROCUREMENT_TEST_PORT || 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const created = { receiptIds: [], assetIds: [], stockItemIds: [], movementIds: [], categoryIds: [], userIds: [] };
let server;
let db;

function check(name, condition, detail) {
    results.push({ name, passed: !!condition });
    console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ` -> ${detail}` : ''}`);
}

function request(method, path, { body, token, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const requestHeaders = { Accept: 'application/json', ...headers };
        if (payload !== null) {
            requestHeaders['Content-Type'] = 'application/json';
            requestHeaders['Content-Length'] = Buffer.byteLength(payload);
        }
        if (token) requestHeaders.Authorization = `Bearer ${token}`;
        const req = http.request(`${BASE}${path}`, { method, headers: requestHeaders }, (res) => {
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

async function connectDb() {
    db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });
}

async function createUser(suffix, role) {
    const username = `prc_${suffix}_${Date.now()}`;
    const passwordHash = await hash('ProcurementTest@123', 8);
    const [result] = await db.query(
        `INSERT INTO users (username, password_hash, email, full_name, role, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [username, passwordHash, `${username}@example.test`, `Procurement ${suffix}`, role]
    );
    created.userIds.push(result.insertId);
    return { username, password: 'ProcurementTest@123', id: result.insertId };
}

async function login(user) {
    const response = await request('POST', '/api/auth/login', {
        body: { username: user.username, password: user.password }
    });
    return response.body && response.body.data && response.body.data.token;
}

async function cleanup() {
    if (!db) return;
    if (created.receiptIds.length) {
        await db.query('DELETE FROM procurement_receipt_lines WHERE receipt_id IN (?)', [created.receiptIds]);
        await db.query(
            "DELETE FROM audit_logs WHERE table_name = 'procurement_receipts' AND record_id IN (?)",
            [created.receiptIds]
        );
        await db.query('DELETE FROM procurement_receipts WHERE id IN (?)', [created.receiptIds]);
    }
    if (created.movementIds.length) {
        await db.query(
            "DELETE FROM audit_logs WHERE table_name IN ('stock_items', 'stock_movements') AND record_id IN (?)",
            [[...created.movementIds, ...created.stockItemIds]]
        );
        await db.query('DELETE FROM stock_movements WHERE id IN (?)', [created.movementIds]);
    }
    if (created.stockItemIds.length) {
        await db.query("DELETE FROM audit_logs WHERE table_name = 'stock_items' AND record_id IN (?)", [
            created.stockItemIds
        ]);
        await db.query('DELETE FROM stock_items WHERE id IN (?)', [created.stockItemIds]);
    }
    if (created.assetIds.length) {
        await db.query("DELETE FROM audit_logs WHERE table_name = 'assets' AND record_id IN (?)", [
            created.assetIds
        ]);
        await db.query('DELETE FROM assets WHERE id IN (?)', [created.assetIds]);
    }
    if (created.categoryIds.length) {
        await db.query("DELETE FROM audit_logs WHERE table_name = 'asset_categories' AND record_id IN (?)", [
            created.categoryIds
        ]);
        await db.query('DELETE FROM asset_categories WHERE id IN (?)', [created.categoryIds]);
    }
    if (created.userIds.length) {
        await db.query('DELETE FROM audit_logs WHERE user_id IN (?)', [created.userIds]);
        await db.query('DELETE FROM users WHERE id IN (?)', [created.userIds]);
    }
}

function recordCreatedIds(receipt) {
    if (!receipt) return;
    created.receiptIds.push(receipt.id);
    for (const line of receipt.lines || []) {
        if (line.asset_id) created.assetIds.push(line.asset_id);
        if (line.stock_item_id) created.stockItemIds.push(line.stock_item_id);
        if (line.stock_movement_id) created.movementIds.push(line.stock_movement_id);
    }
}

async function run() {
    const admin = await createUser('admin', 'System Administrator');
    const ict = await createUser('ict', 'ICT Officer');
    const departmentUser = await createUser('dept', 'Departmental User');
    const auditor = await createUser('audit', 'Auditor');
    const [adminToken, ictToken, deptToken, auditorToken] = await Promise.all(
        [admin, ict, departmentUser, auditor].map(login)
    );
    check('test roles can authenticate', !!adminToken && !!ictToken && !!deptToken && !!auditorToken);

    const noAuth = await request('GET', '/api/procurement');
    check('receipt list requires authentication', noAuth.status === 401, noAuth.raw);
    const blocked = await request('POST', '/api/procurement/receive', {
        token: deptToken,
        headers: { 'Idempotency-Key': 'blocked' },
        body: { lines: [{ type: 'consumable' }] }
    });
    check('departmental users cannot receive goods', blocked.status === 403, blocked.raw);
    const auditorWrite = await request('POST', '/api/procurement/receive', {
        token: auditorToken,
        headers: { 'Idempotency-Key': 'auditor-blocked' },
        body: { lines: [{ type: 'consumable' }] }
    });
    check('auditors cannot receive goods', auditorWrite.status === 403, auditorWrite.raw);

    const invalid = await request('POST', '/api/procurement/receive', {
        token: ictToken,
        headers: { 'Idempotency-Key': 'invalid' },
        body: { unexpected: true, lines: [] }
    });
    check('unknown fields and empty line sets fail strict validation', invalid.status === 400, invalid.raw);
    const missingKey = await request('POST', '/api/procurement/receive', {
        token: ictToken,
        body: { lines: [{ type: 'consumable', item_name: 'Paper', quantity: 2 }] }
    });
    check('receiving requires an idempotency key or receipt reference', missingKey.status === 400, missingKey.raw);

    const categoryResponse = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: `Procurement ${Date.now()}`, description: 'Procurement test fixture' }
    });
    const categoryId = categoryResponse.body?.data?.category?.id;
    if (categoryId) created.categoryIds.push(categoryId);
    check('asset category fixture created', !!categoryId, categoryResponse.raw);

    const tag = `PRC-${Date.now()}`;
    const requestBody = {
        receipt_reference: `GRN-${Date.now()}`,
        supplier: 'Procurement Test Supplier',
        purchase_order: 'PO-TEST-001',
        received_date: new Date().toISOString().slice(0, 10),
        notes: 'Grouped receiving integration test',
        lines: [
            {
                type: 'serialized',
                asset: {
                    asset_tag: `${tag}-A`,
                    serial_number: `${tag}-SERIAL`,
                    category_id: String(categoryId),
                    manufacturer: 'Test Manufacturer',
                    model: 'Test Device',
                    purchase_cost: '125.50',
                    location: 'Head Office',
                    department: 'ICT'
                }
            },
            {
                type: 'consumable',
                item_name: 'Procurement test patch leads',
                category: 'Consumables',
                unit_of_measure: 'Pack',
                store_location: 'ICT Store - Head Office',
                quantity: 4,
                unit_cost: '2.25',
                minimum_level: 1,
                maximum_level: 20
            }
        ]
    };
    const idemHeaders = { 'Idempotency-Key': `procurement-${Date.now()}` };
    const received = await request('POST', '/api/procurement/receive', {
        token: ictToken,
        headers: idemHeaders,
        body: requestBody
    });
    const receipt = received.body?.data?.receipt;
    recordCreatedIds(receipt);
    check('mixed serialized and consumable receipt commits (201)', received.status === 201, received.raw);
    check('receipt groups both created lines', !!receipt && receipt.lines.length === 2, received.raw);
    check(
        'serialized line creates an In Stock asset with generated identifiers',
        !!receipt?.lines?.[0]?.asset_code &&
            receipt.lines[0].asset_code.startsWith('NBSZ-AST-') &&
            receipt.lines[0].asset_tag === `${tag}-A`,
        received.raw
    );
    check(
        'serialized receipt line preserves identifying details for audit history',
        receipt?.lines?.[0]?.details?.asset_tag === `${tag}-A` &&
            receipt.lines[0].details.asset_code === receipt.lines[0].asset_code,
        received.raw
    );
    check(
        'consumable line reports a receipt ledger reference',
        !!receipt?.lines?.[1]?.movement_ref && Number(receipt.lines[1].quantity) === 4,
        received.raw
    );
    const firstStockItemId = receipt?.lines?.[1]?.stock_item_id;
    const firstMovementId = receipt?.lines?.[1]?.stock_movement_id;
    const [ledgerRows] = firstMovementId
        ? await db.query(
            'SELECT movement_type, quantity, balance_after FROM stock_movements WHERE id = ?',
            [firstMovementId]
        )
        : [[]];
    check(
        'consumable receipt updates the balance through a positive Receipt ledger row',
        ledgerRows.length === 1 &&
            ledgerRows[0].movement_type === 'Receipt' &&
            Number(ledgerRows[0].quantity) === 4 &&
            Number(ledgerRows[0].balance_after) === 4,
        JSON.stringify(ledgerRows)
    );

    const replay = await request('POST', '/api/procurement/receive', {
        token: ictToken,
        headers: idemHeaders,
        body: requestBody
    });
    check(
        'identical idempotency replay returns existing receipt without duplicates',
        replay.status === 200 &&
            replay.body?.data?.idempotent_replay === true &&
            replay.body?.data?.receipt?.id === receipt?.id,
        replay.raw
    );
    const [replayCounts] = await db.query(
        `SELECT
            (SELECT COUNT(*) FROM assets WHERE asset_tag = ?) AS assets,
            (SELECT COUNT(*) FROM procurement_receipts WHERE idempotency_key = ?) AS receipts`,
        [`${tag}-A`, `key:${require('crypto').createHash('sha256').update(idemHeaders['Idempotency-Key']).digest('hex')}`]
    );
    check(
        'replay does not create another asset or receipt group',
        Number(replayCounts[0].assets) === 1 && Number(replayCounts[0].receipts) === 1,
        JSON.stringify(replayCounts[0])
    );
    const changedPayload = {
        ...requestBody,
        notes: 'Different request under the same key'
    };
    const conflict = await request('POST', '/api/procurement/receive', {
        token: ictToken,
        headers: idemHeaders,
        body: changedPayload
    });
    check('reusing an idempotency key with different content conflicts', conflict.status === 409, conflict.raw);

    const list = await request('GET', '/api/procurement?limit=10', { token: auditorToken });
    check('auditors can read receipt groups', list.status === 200 && list.body?.data?.total >= 1, list.raw);
    const byReference = await request('GET', `/api/procurement/${requestBody.receipt_reference}`, {
        token: adminToken
    });
    check(
        'receipt detail can be retrieved by receipt reference',
        byReference.status === 200 && byReference.body?.data?.receipt?.id === receipt?.id,
        byReference.raw
    );
    const [auditRows] = await db.query(
        `SELECT COUNT(*) AS total FROM audit_logs
         WHERE table_name = 'procurement_receipts' AND record_id = ? AND action = 'RECEIVE'`,
        [receipt?.id]
    );
    check('grouped receipt has its own audit entry', Number(auditRows[0].total) === 1);

    const secondReceiptBody = {
        receipt_reference: `GRN-EXISTING-${Date.now()}`,
        lines: [{
            type: 'consumable',
            stock_item_id: String(firstStockItemId),
            quantity: 3,
            unit_cost: '2.75'
        }]
    };
    const secondReceiptResponse = await request('POST', '/api/procurement/receive', {
        token: ictToken,
        headers: { 'Idempotency-Key': `existing-item-${Date.now()}` },
        body: secondReceiptBody
    });
    const secondReceipt = secondReceiptResponse.body?.data?.receipt;
    recordCreatedIds(secondReceipt);
    const [updatedStockRows] = await db.query(
        'SELECT quantity_on_hand FROM stock_items WHERE id = ?',
        [firstStockItemId]
    );
    check(
        'a later receipt against an existing consumable appends to its balance',
        secondReceiptResponse.status === 201 &&
            Number(updatedStockRows[0]?.quantity_on_hand) === 7,
        secondReceiptResponse.raw
    );

    const rollbackTag = `${tag}-ROLLBACK`;
    const rollbackBody = {
        receipt_reference: `GRN-ROLLBACK-${Date.now()}`,
        lines: [
            { type: 'serialized', asset: { asset_tag: rollbackTag } },
            { type: 'consumable', stock_item_id: 2147483000, quantity: 1, unit_cost: 1 }
        ]
    };
    const rollbackResponse = await request('POST', '/api/procurement/receive', {
        token: ictToken,
        headers: { 'Idempotency-Key': `rollback-${Date.now()}` },
        body: rollbackBody
    });
    const [rolledBackAssets] = await db.query('SELECT id FROM assets WHERE asset_tag = ?', [rollbackTag]);
    check(
        'failure on a later line rolls back earlier asset and receipt writes',
        rollbackResponse.status === 404 && rolledBackAssets.length === 0,
        rollbackResponse.raw
    );

    const duplicateTag = await request('POST', '/api/procurement/receive', {
        token: ictToken,
        headers: { 'Idempotency-Key': `dupetag-${Date.now()}` },
        body: {
            receipt_reference: `GRN-DUPE-${Date.now()}`,
            lines: [{ type: 'serialized', asset: { asset_tag: `${tag}-A` } }]
        }
    });
    check('duplicate physical asset tags are rejected', duplicateTag.status === 409, duplicateTag.raw);

    const referenceBody = {
        receipt_reference: `GRN-KEY-${Date.now()}`,
        lines: [{
            type: 'consumable',
            item_name: 'Procurement reference-key test item',
            quantity: 3,
            unit_cost: 1
        }]
    };
    const referenceResult = await request('POST', '/api/procurement/receive', {
        token: adminToken,
        body: referenceBody
    });
    const referenceReceipt = referenceResult.body?.data?.receipt;
    recordCreatedIds(referenceReceipt);
    check('receipt reference is accepted as an idempotency key', referenceResult.status === 201, referenceResult.raw);
    const referenceReplay = await request('POST', '/api/procurement/receive', {
        token: adminToken,
        body: referenceBody
    });
    check(
        'receipt-reference retry resolves to the original receipt',
        referenceReplay.status === 200 &&
            referenceReplay.body?.data?.receipt?.id === referenceReceipt?.id,
        referenceReplay.raw
    );

    const concurrentBody = {
        receipt_reference: `GRN-CONCURRENT-${Date.now()}`,
        lines: [{
            type: 'consumable',
            item_name: 'Procurement concurrent retry item',
            quantity: 2,
            unit_cost: '3.10'
        }]
    };
    const concurrentHeaders = { 'Idempotency-Key': `concurrent-${Date.now()}` };
    const concurrentResults = await Promise.all([
        request('POST', '/api/procurement/receive', {
            token: ictToken,
            headers: concurrentHeaders,
            body: concurrentBody
        }),
        request('POST', '/api/procurement/receive', {
            token: ictToken,
            headers: concurrentHeaders,
            body: concurrentBody
        })
    ]);
    const concurrentReceipts = concurrentResults
        .map((result) => result.body?.data?.receipt)
        .filter(Boolean);
    if (concurrentReceipts[0]) recordCreatedIds(concurrentReceipts[0]);
    const [concurrentCount] = await db.query(
        'SELECT COUNT(*) AS total FROM procurement_receipts WHERE receipt_reference = ?',
        [concurrentBody.receipt_reference]
    );
    check(
        'simultaneous retries create exactly one receipt group',
        concurrentResults.every((result) => [200, 201].includes(result.status)) &&
            concurrentReceipts.length === 2 &&
            concurrentReceipts[0].id === concurrentReceipts[1].id &&
            Number(concurrentCount[0].total) === 1,
        concurrentResults.map((result) => result.raw).join(' | ')
    );

}

server = app.listen(PORT, async () => {
    let failure = null;
    try {
        await connectDb();
        await procurementModel.ensureTable();
        await run();
    } catch (error) {
        failure = error;
        console.error(error && error.stack ? error.stack : error);
    }

    try {
        await cleanup();
    } catch (error) {
        failure = failure || error;
        console.error('Cleanup failed:', error.message);
    }
    if (db) await db.end().catch(() => {});
    const passed = results.filter((result) => result.passed).length;
    const failed = results.length - passed;
    console.log(`\nProcurement tests: ${passed} passed, ${failed} failed${failure ? ' (aborted)' : ''}.`);
    server.close(() => process.exit(failed === 0 && !failure ? 0 : 1));
    setTimeout(() => process.exit(failed === 0 && !failure ? 0 : 1), 3000).unref();
});
