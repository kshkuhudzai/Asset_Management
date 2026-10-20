'use strict';

/**
 * scripts/testBarcode.js
 * ---------------------------------------------------------------------------
 * Standalone smoke/regression test for QR Code / Barcode Management (§5.8).
 *
 * Boots the Express app on an isolated port, runs real HTTP requests against it,
 * and asserts on all barcode endpoints and business rules.
 *
 * Run with:
 *     node scripts/testBarcode.js
 *
 * Exit code 0 = all checks passed, 1 = failure.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const app = require('../server');
const barcodeModel = require('../models/barcodeModel');

const PORT = process.env.BARCODE_TEST_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let server = null;
let db = null;

// Fixture tracking for cleanup
const createdLabelIds = [];
const createdScanIds = [];
const createdAssetIds = [];
const createdCategoryIds = [];
const createdUserIds = [];

function check(name, condition, detail) {
    results.push({ name, passed: !!condition, detail });
    const icon = condition ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${name}${!condition && detail ? ` -> ${detail}` : ''}`);
}

function section(title) {
    console.log(`\n${title}`);
    console.log('-'.repeat(title.length));
}

function request(method, path, { body, token } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const headers = { Accept: 'application/json' };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (token) headers.Authorization = `Bearer ${token}`;

        const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (chunk) => (raw += chunk));
            res.on('end', () => {
                let parsed;
                try {
                    parsed = raw ? JSON.parse(raw) : null;
                } catch (e) {
                    parsed = raw;
                }
                resolve({ status: res.statusCode, body: parsed, raw });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
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

async function ensureUser({ username, email, password, fullName, role }) {
    const { hash } = require('bcryptjs');
    const [existing] = await db.query(
        'SELECT id, is_active FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1',
        [username]
    );

    if (existing.length) {
        if (!existing[0].is_active) {
            await db.query('UPDATE users SET is_active = 1 WHERE id = ?', [existing[0].id]);
        }
        return existing[0].id;
    }

    const passwordHash = await hash(password, 10);
    const [result] = await db.query(
        `INSERT INTO users (username, password_hash, email, full_name, role, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [username, passwordHash, email, fullName, role]
    );
    createdUserIds.push(result.insertId);
    return result.insertId;
}

async function cleanup() {
    if (!db) return;
    try {
        if (createdScanIds.length) {
            await db.query('DELETE FROM asset_scan_events WHERE id IN (?)', [createdScanIds]);
        }
        if (createdLabelIds.length) {
            await db.query(
                `DELETE FROM audit_logs WHERE table_name = 'asset_barcode_labels' AND record_id IN (?)`,
                [createdLabelIds]
            );
            await db.query('DELETE FROM asset_barcode_labels WHERE id IN (?)', [createdLabelIds]);
        }
        if (createdAssetIds.length) {
            await db.query(
                `DELETE FROM asset_barcode_labels WHERE asset_id IN (?)`,
                [createdAssetIds]
            );
            await db.query(
                `DELETE FROM asset_scan_events WHERE asset_id IN (?)`,
                [createdAssetIds]
            );
            await db.query(
                `DELETE FROM audit_logs WHERE table_name = 'assets' AND record_id IN (?)`,
                [createdAssetIds]
            );
            await db.query('DELETE FROM assets WHERE id IN (?)', [createdAssetIds]);
        }
        if (createdCategoryIds.length) {
            await db.query('DELETE FROM asset_categories WHERE id IN (?)', [createdCategoryIds]);
        }
        if (createdUserIds.length) {
            await db.query('DELETE FROM audit_logs WHERE user_id IN (?)', [createdUserIds]);
            await db.query('DELETE FROM users WHERE id IN (?)', [createdUserIds]);
        }
        console.log('\nCleaned up test fixtures.');
    } catch (err) {
        console.error('Cleanup failed:', err.message);
    }
}

async function run() {
    const stamp = `${Date.now()}`.slice(-7);
    const tagSeed = `BC-${stamp}`;

    let adminToken, hisoToken, ictToken, deptToken, auditorToken;

    section('1. Infrastructure & Table Initialization');
    await connectDb();
    await barcodeModel.ensureTable();
    check('barcodeModel.ensureTable executed successfully', true);

    const [labelTable] = await db.query("SHOW TABLES LIKE 'asset_barcode_labels'");
    const [scanTable] = await db.query("SHOW TABLES LIKE 'asset_scan_events'");
    check('asset_barcode_labels table exists', labelTable.length > 0);
    check('asset_scan_events table exists', scanTable.length > 0);

    const health = await request('GET', '/api/health');
    check('GET /api/health returns 200', health.status === 200);

    const adminUser = { username: 'bc_admin', email: 'bc.admin@nbsz.co.zw', password: 'BcAdmin@123', fullName: 'BC Admin', role: 'System Administrator' };
    const hisoUser = { username: 'bc_hiso', email: 'bc.hiso@nbsz.co.zw', password: 'BcHiso@123', fullName: 'BC HISO', role: 'HISO' };
    const ictUser = { username: 'bc_ict', email: 'bc.ict@nbsz.co.zw', password: 'BcIct@123', fullName: 'BC ICT Officer', role: 'ICT Officer' };
    const deptUser = { username: 'bc_dept', email: 'bc.dept@nbsz.co.zw', password: 'BcDept@123', fullName: 'BC Department User', role: 'Departmental User' };
    const auditorUser = { username: 'bc_auditor', email: 'bc.auditor@nbsz.co.zw', password: 'BcAuditor@123', fullName: 'BC Auditor', role: 'Auditor' };

    for (const u of [adminUser, hisoUser, ictUser, deptUser, auditorUser]) {
        await ensureUser(u);
    }

    const login = (u) => request('POST', '/api/auth/login', { body: { username: u.username, password: u.password } });

    const adminLogin = await login(adminUser);
    adminToken = adminLogin.body?.data?.token;
    check('admin login successful', adminLogin.status === 200 && !!adminToken);

    const hisoLogin = await login(hisoUser);
    hisoToken = hisoLogin.body?.data?.token;

    const ictLogin = await login(ictUser);
    ictToken = ictLogin.body?.data?.token;
    check('ICT Officer login successful', ictLogin.status === 200 && !!ictToken);

    const deptLogin = await login(deptUser);
    deptToken = deptLogin.body?.data?.token;

    const auditorLogin = await login(auditorUser);
    auditorToken = auditorLogin.body?.data?.token;
    check('Auditor login successful', auditorLogin.status === 200 && !!auditorToken);

    const anon = await request('GET', '/api/barcode/stats');
    check('unauthenticated request is rejected (401)', anon.status === 401);

    section('2. Test Fixtures (Asset Category and Assets)');
    const createCat = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: `Barcode Cat ${tagSeed}`, description: 'Barcode Test Category' }
    });
    const categoryId = createCat.body?.data?.category?.id;
    if (categoryId) createdCategoryIds.push(categoryId);
    check('category created', !!categoryId);

    async function createAsset(suffix, overrides = {}) {
        const payload = {
            asset_tag: `${tagSeed}-${suffix}`,
            serial_number: `${tagSeed}-SN-${suffix}`,
            category_id: categoryId,
            manufacturer: 'Dell',
            model: 'Latitude 5420',
            location: 'Head Office',
            department: 'ICT',
            status: 'In Stock',
            condition_status: 'Good',
            ...overrides
        };
        const res = await request('POST', '/api/assets', { token: adminToken, body: payload });
        const created = res.body?.data?.asset;
        if (created) createdAssetIds.push(created.id);
        return created;
    }

    const asset1 = await createAsset('01');
    const asset2 = await createAsset('02');
    const asset3 = await createAsset('03');
    check('created 3 test assets', !!asset1 && !!asset2 && !!asset3);

    section('3. Reference Metadata, Coverage, and Stats');
    const metaRes = await request('GET', '/api/barcode/meta', { token: ictToken });
    check('GET /api/barcode/meta returns 200', metaRes.status === 200);
    check('meta contains code_types and label_statuses', 
        metaRes.body?.data?.code_types?.includes('QR Code') &&
        metaRes.body?.data?.label_statuses?.includes('Active')
    );

    const coverageRes = await request('GET', '/api/barcode/coverage', { token: ictToken });
    check('GET /api/barcode/coverage returns 200', coverageRes.status === 200, coverageRes.raw);
    check('unlabeled asset1 is in coverage list', 
        coverageRes.body?.data?.items?.some(i => i.id === asset1.id),
        JSON.stringify(coverageRes.body?.data?.items?.map(i => ({ id: i.id, tag: i.asset_tag, qr: i.qr_code_value })))
    );

    const statsRes = await request('GET', '/api/barcode/stats', { token: auditorToken });
    check('GET /api/barcode/stats returns 200 for Auditor', statsRes.status === 200);
    check('stats payload has asset and label breakdown', 
        typeof statsRes.body?.data?.assets?.total === 'number' &&
        typeof statsRes.body?.data?.labels?.active === 'number'
    );

    section('4. Single Asset Barcode Generation (§5.8)');
    const genRes = await request('POST', `/api/barcode/asset/${asset1.id}/generate`, {
        token: ictToken,
        body: { code_type: 'QR Code', symbology: 'QR', notes: 'Initial label generation' }
    });
    check('POST /api/barcode/asset/:id/generate returns 201', genRes.status === 201, genRes.raw);
    const label1 = genRes.body?.data;
    if (label1) createdLabelIds.push(label1.id);

    check('minted code follows NBSZ- format', typeof label1?.code_value === 'string' && label1.code_value.startsWith('NBSZ-'), JSON.stringify(label1));
    check('minted label has LBL- reference', typeof label1?.label_ref === 'string' && label1.label_ref.startsWith('LBL-'));
    check('label is marked Active', label1?.label_status === 'Active');

    // Verify asset record in assets table was updated with qr_code_value
    const asset1Check = await request('GET', `/api/assets/${asset1.id}`, { token: ictToken });
    check('asset qr_code_value is updated', asset1Check.body?.data?.asset?.qr_code_value === label1?.code_value);

    // Get asset label details
    const assetLabelRes = await request('GET', `/api/barcode/asset/${asset1.id}`, { token: ictToken });
    check('GET /api/barcode/asset/:id returns active label', assetLabelRes.body?.data?.label?.id === label1?.id);

    section('5. Bulk Barcode Generation');
    const bulkRes = await request('POST', '/api/barcode/generate', {
        token: adminToken,
        body: {
            asset_ids: [asset2.id, asset3.id],
            code_type: 'Barcode',
            symbology: 'Code128'
        }
    });
    check('POST /api/barcode/generate returns 201', bulkRes.status === 201, bulkRes.raw);
    check('bulk generated 2 barcodes', bulkRes.body?.data?.generated?.length === 2);
    bulkRes.body?.data?.generated?.forEach(g => {
        if (g.label_id) createdLabelIds.push(g.label_id);
    });

    section('6. Scanning & Lookups (§5.8 / §10 Non-sensitive projection)');
    // 6a. Read-only lookup
    const lookupRes = await request('GET', `/api/barcode/lookup/${label1?.code_value || 'NONE'}`, { token: deptToken });
    check('GET /api/barcode/lookup/:code returns 200 for Departmental user', lookupRes.status === 200, lookupRes.raw);
    check('lookup payload returns asset identification', lookupRes.body?.data?.asset?.asset_tag === asset1.asset_tag);
    check('lookup payload does NOT expose purchase_cost or notes', 
        lookupRes.body?.data?.asset?.purchase_cost === undefined &&
        lookupRes.body?.data?.asset?.purchase_price === undefined
    );

    // 6b. Scan event logging
    const scanRes = await request('POST', '/api/barcode/scan', {
        token: ictToken,
        body: {
            code: label1?.code_value,
            scan_purpose: 'Verification',
            scan_location: 'ICT Lab Room 2'
        }
    });
    check('POST /api/barcode/scan returns 200', scanRes.status === 200, scanRes.raw);
    check('scan_result is Matched', scanRes.body?.data?.scan_result === 'Matched');
    const scanId = scanRes.body?.data?.scan_id;
    if (scanId) createdScanIds.push(scanId);
    check('scan event was logged with id', !!scanId);

    // 6c. Scan history query
    const scansRes = await request('GET', '/api/barcode/scans', { token: auditorToken });
    check('GET /api/barcode/scans returns 200', scansRes.status === 200);
    check('logged scan appears in scan history', scansRes.body?.data?.items?.some(s => s.id === scanId));

    // 6d. Single scan details
    const singleScanRes = await request('GET', `/api/barcode/scans/${scanId}`, { token: ictToken });
    check('GET /api/barcode/scans/:id returns scan details', singleScanRes.body?.data?.id === scanId);

    // 6e. Scanning an unknown code
    const unknownRes = await request('POST', '/api/barcode/scan', {
        token: ictToken,
        body: { code: 'NBSZ-UNKNOWN999', scan_purpose: 'Identification' }
    });
    check('scanning unknown code returns 404', unknownRes.status === 404);

    section('7. Label Printing & Replacement');
    // 7a. Record label print
    const printRes = await request('POST', `/api/barcode/asset/${asset1.id}/print`, { token: ictToken });
    check('POST /api/barcode/asset/:id/print returns 200', printRes.status === 200);
    check('print count bumped to 2', printRes.body?.data?.label?.print_count === 2);
    check('returns printable metadata card', !!printRes.body?.data?.printable?.code_value);

    // 7b. Replace damaged label
    const replaceRes = await request('POST', `/api/barcode/label/${label1?.id}/replace`, {
        token: ictToken,
        body: { label_status: 'Damaged', notes: 'Sticker peeling off laptop chassis' }
    });
    check('POST /api/barcode/label/:id/replace returns 201', replaceRes.status === 201);
    const newLabel = replaceRes.body?.data?.label;
    if (newLabel) createdLabelIds.push(newLabel.id);
    check('new label generated with different code_value', newLabel?.code_value !== label1?.code_value);

    // Check old label is now marked Damaged/Retired
    const oldLabelCheck = await request('GET', `/api/barcode/${label1?.id}`, { token: ictToken });
    check('old label status is Damaged', oldLabelCheck.body?.data?.label_status === 'Damaged');

    section('8. Label Register Queries & Updates');
    const allLabelsRes = await request('GET', '/api/barcode', { token: auditorToken });
    check('GET /api/barcode returns list with items', (allLabelsRes.body?.data?.items?.length || 0) > 0);

    if (newLabel) {
        const updateLabelRes = await request('PUT', `/api/barcode/${newLabel.id}`, {
            token: ictToken,
            body: { label_condition: 'Fair', notes: 'Updated notes during verification' }
        });
        check('PUT /api/barcode/:id returns 200', updateLabelRes.status === 200);
        check('label condition updated to Fair', updateLabelRes.body?.data?.label_condition === 'Fair');
    }
}

(async () => {
    try {
        server = app.listen(PORT, async () => {
            console.log(`\n======================================================`);
            console.log(`🧪 NBSZ Barcode Integration Test Suite`);
            console.log(`📡 Server listening on port ${PORT}`);
            console.log(`======================================================`);

            try {
                await run();
            } catch (err) {
                console.error('\n❌ Unhandled error during test execution:', err);
                results.push({ name: 'Suite execution', passed: false, detail: err.message });
            } finally {
                await cleanup();
                if (db) await db.end();
                server.close(() => {
                    const total = results.length;
                    const passed = results.filter((r) => r.passed).length;
                    const failed = total - passed;

                    console.log(`\n======================================================`);
                    console.log(`📊 Barcode Test Results: ${passed}/${total} passed (${failed} failed)`);
                    console.log(`======================================================\n`);
                    process.exit(failed > 0 ? 1 : 0);
                });
            }
        });
    } catch (err) {
        console.error('Failed to start test server:', err);
        process.exit(1);
    }
})();
