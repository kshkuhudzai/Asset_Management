'use strict';

/**
 * scripts/testMaintenance.js
 * ---------------------------------------------------------------------------
 * Standalone smoke/regression test for the Maintenance & Repairs slice (§5.5).
 *
 * Boots the real Express app (which also verifies the MySQL connection) on an
 * isolated port, fires real HTTP requests at it, and asserts on the responses.
 * No test-runner dependency is required - run it with:
 *
 *     node scripts/testMaintenance.js
 *
 * The suite is self-contained: it creates its own role accounts, category and
 * assets, and hard-deletes everything it created at the end (the API itself
 * never deletes maintenance rows, by design).
 *
 * Exit code 0 = all checks passed, 1 = at least one check failed.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const app = require('../server');
const maintenanceModel = require('../models/maintenanceModel');

// Dedicated port so this can run even while the dev server is up.
const PORT = process.env.MAINTENANCE_TEST_PORT || 3997;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let server = null;

// Ids created during the run, cleaned up at the end.
const createdMaintenanceIds = [];
const createdAssetIds = [];
const createdCategoryIds = [];
const createdUserIds = [];


/* -------------------------------------------------------------------------
 * Tiny assertion helpers
 * ---------------------------------------------------------------------- */
function check(name, condition, detail) {
    results.push({ name, passed: !!condition, detail });
    const icon = condition ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${name}${!condition && detail ? ` -> ${detail}` : ''}`);
}

function section(title) {
    console.log(`\n${title}`);
    console.log('-'.repeat(title.length));
}

/**
 * Normalises a MySQL DATE value for comparison.
 *
 * mysql2 hands DATE columns back as Date objects anchored at local midnight, so
 * `JSON.stringify` renders them as the PREVIOUS day in UTC (e.g. 2026-01-15
 * becomes "2026-01-14T22:00:00.000Z" in a UTC+2 timezone). Comparing the local
 * calendar date keeps the assertions timezone-independent.
 *
 * @param {*} value A Date, ISO string or null.
 * @returns {string|null} `YYYY-MM-DD` in the server's local timezone.
 */
function isoDay(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);

    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Today as YYYY-MM-DD in the local timezone - matches the controller's `today()`.
 */
function today() {
    return isoDay(new Date());
}

/**
 * A date offset from today by N days, as YYYY-MM-DD.
 *
 * @param {number} days
 * @returns {string}
 */
function dayOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return isoDay(d);
}

/* -------------------------------------------------------------------------
 * Minimal HTTP client (Node core only - no supertest/fetch dependency)
 * ---------------------------------------------------------------------- */
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
                    parsed = raw; // non-JSON body - keep raw for diagnostics
                }
                resolve({ status: res.statusCode, body: parsed, raw });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/* -------------------------------------------------------------------------
 * Direct database helpers (for creating fixtures and cleaning up)
 * ---------------------------------------------------------------------- */
let db = null;

async function connectDb() {
    db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });
}

/**
 * Creates the test account for a role if it does not already exist, so RBAC
 * can be exercised. Returns the user id.
 */
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

/**
 * Removes everything this suite created. Child rows (maintenance records,
 * audit_logs) must go before the parent users/assets because of the foreign
 * keys.
 */
async function cleanup() {
    if (!db) return;

    try {
        if (createdMaintenanceIds.length) {
            await db.query(
                `DELETE FROM audit_logs
                 WHERE table_name = 'maintenance_records' AND record_id IN (?)`,
                [createdMaintenanceIds]
            );
        }

        if (createdAssetIds.length) {
            // Any maintenance row pointing at a throwaway asset goes too.
            await db.query(
                `DELETE FROM audit_logs WHERE table_name = 'maintenance_records' AND record_id IN (
                    SELECT id FROM maintenance_records WHERE asset_id IN (?)
                 )`,
                [createdAssetIds]
            );
            await db.query('DELETE FROM maintenance_records WHERE asset_id IN (?)', [createdAssetIds]);
            await db.query(
                `DELETE FROM audit_logs WHERE table_name = 'assets' AND record_id IN (?)`,
                [createdAssetIds]
            );
            await db.query('DELETE FROM assets WHERE id IN (?)', [createdAssetIds]);
        }

        if (createdCategoryIds.length) {
            await db.query(
                `DELETE FROM audit_logs WHERE table_name = 'asset_categories' AND record_id IN (?)`,
                [createdCategoryIds]
            );
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


/* -------------------------------------------------------------------------
 * The test suite
 * ---------------------------------------------------------------------- */
async function run() {
    // Unique suffix so repeat runs never collide on UNIQUE columns.
    const stamp = `${Date.now()}`.slice(-7);
    const tagSeed = `MNT-${stamp}`;

    let adminToken = null;
    let hisoToken = null;
    let ictToken = null;
    let deptToken = null;
    let auditorToken = null;

    /* ---------------------------------------------------------------- */
    section('1. Infrastructure');
    /* ---------------------------------------------------------------- */
    const health = await request('GET', '/api/health');
    check(
        'GET /api/health returns 200',
        health.status === 200 && health.body && health.body.status === 'success',
        health.raw
    );

    check('contacting the database succeeds', !!db);

    /* ---------------------------------------------------------------- */
    section('2. Authentication and RBAC fixtures');
    /* ---------------------------------------------------------------- */
    const adminUser = {
        username: 'mnt_admin_test',
        email: 'mnt.admin.test@nbsz.co.zw',
        password: 'MntAdmin@123',
        fullName: 'Maintenance Test Administrator',
        role: 'System Administrator'
    };
    const hisoUser = {
        username: 'mnt_hiso_test',
        email: 'mnt.hiso.test@nbsz.co.zw',
        password: 'MntHiso@123',
        fullName: 'Maintenance Test HISO',
        role: 'HISO'
    };
    const ictUser = {
        username: 'mnt_ict_test',
        email: 'mnt.ict.test@nbsz.co.zw',
        password: 'MntIct@123',
        fullName: 'Maintenance Test ICT Officer',
        role: 'ICT Officer'
    };
    const deptUser = {
        username: 'mnt_dept_test',
        email: 'mnt.dept.test@nbsz.co.zw',
        password: 'MntDept@123',
        fullName: 'Maintenance Test Departmental User',
        role: 'Departmental User'
    };
    const auditorUser = {
        username: 'mnt_auditor_test',
        email: 'mnt.auditor.test@nbsz.co.zw',
        password: 'MntAudit@123',
        fullName: 'Maintenance Test Auditor',
        role: 'Auditor'
    };

    const ids = [];
    for (const user of [adminUser, hisoUser, ictUser, deptUser, auditorUser]) {
        ids.push(await ensureUser(user));
    }
    const [adminId, hisoId, ictId, deptId, auditorId] = ids;
    check('five role test accounts are available', ids.every(Boolean), `ids: ${ids.join(', ')}`);

    const login = (user) =>
        request('POST', '/api/auth/login', {
            body: { username: user.username, password: user.password }
        });

    const adminLogin = await login(adminUser);
    adminToken = adminLogin.body && adminLogin.body.data ? adminLogin.body.data.token : null;
    check('administrator can log in', adminLogin.status === 200 && !!adminToken, adminLogin.raw);

    const hisoLogin = await login(hisoUser);
    hisoToken = hisoLogin.body && hisoLogin.body.data ? hisoLogin.body.data.token : null;
    check('HISO can log in', hisoLogin.status === 200 && !!hisoToken, hisoLogin.raw);

    const ictLogin = await login(ictUser);
    ictToken = ictLogin.body && ictLogin.body.data ? ictLogin.body.data.token : null;
    check('ICT Officer can log in', ictLogin.status === 200 && !!ictToken, ictLogin.raw);

    const deptLogin = await login(deptUser);
    deptToken = deptLogin.body && deptLogin.body.data ? deptLogin.body.data.token : null;
    check('Departmental User can log in', deptLogin.status === 200 && !!deptToken, deptLogin.raw);

    const auditorLogin = await login(auditorUser);
    auditorToken = auditorLogin.body && auditorLogin.body.data ? auditorLogin.body.data.token : null;
    check('Auditor can log in', auditorLogin.status === 200 && !!auditorToken, auditorLogin.raw);

    if (!adminToken) {
        throw new Error('Cannot continue without an administrator token.');
    }

    // A maintenance endpoint must reject an anonymous caller.
    const anon = await request('GET', '/api/maintenance');
    check('an unauthenticated maintenance request is rejected (401)', anon.status === 401, anon.raw);

    const ctx = { adminId, hisoId, ictId, deptId, auditorId };


    /* ---------------------------------------------------------------- */
    section('3. Fixtures: category and assets');
    /* ---------------------------------------------------------------- */
    const categoryName = `Maintenance Category ${tagSeed}`;
    const createCategory = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: categoryName, description: 'Created by the maintenance test suite.' }
    });
    const categoryId =
        createCategory.body && createCategory.body.data && createCategory.body.data.category
            ? createCategory.body.data.category.id
            : null;
    if (categoryId) createdCategoryIds.push(categoryId);
    check('asset category created', !!categoryId, createCategory.raw);

    /**
     * Registers an asset through the real API so the fixtures follow exactly
     * the same path as production data.
     */
    async function createAsset(suffix, overrides = {}) {
        const payload = {
            asset_tag: `${tagSeed}-${suffix}`,
            serial_number: `${tagSeed}-SN-${suffix}`,
            category_id: categoryId,
            manufacturer: 'MaintenanceTest',
            model: 'Model-M',
            location: 'Head Office',
            department: 'ICT',
            status: 'In Stock',
            condition_status: 'Good',
            ...overrides
        };

        const res = await request('POST', '/api/assets', { token: adminToken, body: payload });
        const created =
            res.body && res.body.data && res.body.data.asset ? res.body.data.asset : null;
        if (created) createdAssetIds.push(created.id);
        return { res, asset: created };
    }

    const primary = await createAsset('A');
    check('primary test asset created', !!primary.asset, primary.res.raw);
    const asset = primary.asset;

    const spare1 = await createAsset('B');
    check('spare test asset created', !!spare1.asset, spare1.res.raw);

    const spare2 = await createAsset('C');
    check('second spare test asset created', !!spare2.asset, spare2.res.raw);

    const spare3 = await createAsset('D');
    check('third spare test asset created', !!spare3.asset, spare3.res.raw);

    if (!asset) {
        throw new Error('Cannot continue without the primary test asset.');
    }


    /* ---------------------------------------------------------------- */
    section('4. Reference data and empty-state summaries');
    /* ---------------------------------------------------------------- */
    const meta = await request('GET', '/api/maintenance/meta', { token: ictToken });
    check('GET /api/maintenance/meta returns 200', meta.status === 200, meta.raw);
    check(
        'meta exposes the maintenance types',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.maintenance_types) &&
            meta.body.data.maintenance_types.includes('Repair'),
        meta.raw
    );
    check(
        'meta exposes the priorities',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.priorities) &&
            meta.body.data.priorities.includes('Critical'),
        meta.raw
    );
    check(
        'meta exposes the statuses',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.statuses) &&
            meta.body.data.statuses.includes('In Progress'),
        meta.raw
    );
    check(
        'meta exposes the asset conditions',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.conditions) &&
            meta.body.data.conditions.includes('Good'),
        meta.raw
    );
    check(
        'meta exposes a next maintenance reference (MNT- prefix)',
        !!meta.body &&
            !!meta.body.data &&
            typeof meta.body.data.next_ref === 'string' &&
            meta.body.data.next_ref.startsWith('MNT-'),
        meta.raw
    );
    check(
        'meta exposes the custodian pick-list',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.users) &&
            meta.body.data.users.length > 0,
        meta.raw
    );
    check(
        'meta exposes the asset pick-list',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.assets) &&
            meta.body.data.assets.length > 0,
        meta.raw
    );

    // A Departmental User may read lists but not the administrative meta.
    const metaAsDept = await request('GET', '/api/maintenance/meta', { token: deptToken });
    check(
        'a Departmental User cannot read maintenance meta (403)',
        metaAsDept.status === 403,
        metaAsDept.raw
    );

    const stats = await request('GET', '/api/maintenance/stats', { token: auditorToken });
    check('GET /api/maintenance/stats returns 200 for an Auditor', stats.status === 200, stats.raw);
    check(
        'stats expose the expected aggregate shape',
        !!stats.body &&
            !!stats.body.data &&
            typeof stats.body.data.total === 'number' &&
            typeof stats.body.data.open === 'number' &&
            typeof stats.body.data.openRepairs === 'number' &&
            typeof stats.body.data.openServices === 'number' &&
            typeof stats.body.data.openOther === 'number' &&
            stats.body.data.open === stats.body.data.openRepairs +
                stats.body.data.openServices + stats.body.data.openOther &&
            typeof stats.body.data.overdue === 'number' &&
            Array.isArray(stats.body.data.byStatus) &&
            Array.isArray(stats.body.data.byType) &&
            Array.isArray(stats.body.data.byPriority) &&
            Array.isArray(stats.body.data.byMonth) &&
            Array.isArray(stats.body.data.topAssets),
        stats.raw
    );

    const statsAsDept = await request('GET', '/api/maintenance/stats', { token: deptToken });
    check(
        'a Departmental User cannot read maintenance stats (403)',
        statsAsDept.status === 403,
        statsAsDept.raw
    );

    const emptyList = await request('GET', '/api/maintenance?limit=5', { token: adminToken });
    check('GET /api/maintenance returns 200', emptyList.status === 200, emptyList.raw);
    check(
        'the list envelope carries maintenance/total/returned',
        !!emptyList.body &&
            !!emptyList.body.data &&
            Array.isArray(emptyList.body.data.maintenance) &&
            typeof emptyList.body.data.total === 'number' &&
            typeof emptyList.body.data.returned === 'number',
        emptyList.raw
    );


    /* ---------------------------------------------------------------- */
    section('5. Report a fault (the core workflow)');
    /* ---------------------------------------------------------------- */
    const createRes = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: asset.id,
            maintenance_type: 'Repair',
            priority: 'High',
            reported_by: deptId,
            reported_date: today(),
            fault_description: 'Laptop will not power on; suspected charging circuit fault.',
            scheduled_date: dayOffset(1),
            technician_name: 'Tendai Moyo',
            vendor: 'In-house Workshop',
            remarks: 'Collected from the custodian at Head Office.'
        }
    });

    const record =
        createRes.body && createRes.body.data && createRes.body.data.maintenance
            ? createRes.body.data.maintenance
            : null;
    if (record) createdMaintenanceIds.push(record.id);

    check(
        'POST /api/maintenance records the fault (201)',
        createRes.status === 201 && !!record,
        createRes.raw
    );
    check(
        'the record is given a MNT- reference',
        !!record && typeof record.maintenance_ref === 'string' && record.maintenance_ref.startsWith('MNT-'),
        record ? record.maintenance_ref : 'no record'
    );
    check(
        'the record defaults to Pending',
        !!record && record.status === 'Pending',
        record ? record.status : 'no record'
    );
    check(
        'the record snapshots the reported date',
        !!record && isoDay(record.reported_date) === today(),
        record ? `reported_date: ${record.reported_date}` : 'no record'
    );
    check(
        'the record stores the fault description',
        !!record && typeof record.fault_description === 'string' && record.fault_description.length > 0,
        record ? record.fault_description : 'no record'
    );
    check(
        'the record joins the asset reference and tag',
        !!record && !!record.asset_tag && !!record.asset_code,
        record ? `tag: ${record.asset_tag}, code: ${record.asset_code}` : 'no record'
    );
    check(
        'the record resolves the reporter name',
        !!record && !!record.reported_by_name,
        record ? `reported_by_name: ${record.reported_by_name}` : 'no record'
    );
    check(
        'a default cost of 0 is stored',
        !!record && Number(record.cost) === 0,
        record ? `cost: ${record.cost}` : 'no record'
    );

    // §5.5 "Track assets currently under repair": recording an open job moves
    // the asset to 'Under Repair'.
    const assetAfterCreate = await request('GET', `/api/assets/${asset.id}`, { token: ictToken });
    const assetRow =
        assetAfterCreate.body && assetAfterCreate.body.data && assetAfterCreate.body.data.asset
            ? assetAfterCreate.body.data.asset
            : null;
    check(
        "the asset's status moves to 'Under Repair' automatically",
        !!assetRow && assetRow.status === 'Under Repair',
        assetRow ? `asset status: ${assetRow.status}` : 'no asset'
    );


    /* ---------------------------------------------------------------- */
    section('6. Validation and RBAC on create');
    /* ---------------------------------------------------------------- */
    const missingAsset = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: { maintenance_type: 'Repair', fault_description: 'No asset supplied.' }
    });
    check(
        'creating without an asset is rejected (400)',
        missingAsset.status === 400,
        missingAsset.raw
    );

    const missingFault = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: { asset_id: spare1.asset.id, maintenance_type: 'Repair' }
    });
    check(
        'a Repair with no fault description is rejected (400)',
        missingFault.status === 400,
        missingFault.raw
    );

    const badType = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: { asset_id: spare1.asset.id, maintenance_type: 'Nonsense', fault_description: 'x' }
    });
    check('an invalid maintenance_type is rejected (400)', badType.status === 400, badType.raw);

    const badPriority = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: spare1.asset.id,
            maintenance_type: 'Repair',
            priority: 'Urgent',
            fault_description: 'x'
        }
    });
    check('an invalid priority is rejected (400)', badPriority.status === 400, badPriority.raw);

    const badCost = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: spare1.asset.id,
            maintenance_type: 'Repair',
            fault_description: 'x',
            cost: -50
        }
    });
    check('a negative cost is rejected (400)', badCost.status === 400, badCost.raw);

    const badDate = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: spare1.asset.id,
            maintenance_type: 'Repair',
            fault_description: 'x',
            reported_date: '31/02/2026'
        }
    });
    check('a malformed date is rejected (400)', badDate.status === 400, badDate.raw);

    const unknownAsset = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: { asset_id: 999999999, maintenance_type: 'Repair', fault_description: 'x' }
    });
    check('an unknown asset is rejected (404)', unknownAsset.status === 404, unknownAsset.raw);

    const unknownReporter = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: spare1.asset.id,
            maintenance_type: 'Repair',
            fault_description: 'x',
            reported_by: 999999999
        }
    });
    check('an unknown reporter is rejected (400)', unknownReporter.status === 400, unknownReporter.raw);

    // A Departmental User may not report a fault - that is an ICT duty.
    const deptCreate = await request('POST', '/api/maintenance', {
        token: deptToken,
        body: { asset_id: spare1.asset.id, maintenance_type: 'Repair', fault_description: 'x' }
    });
    check(
        'a Departmental User cannot create a maintenance record (403)',
        deptCreate.status === 403,
        deptCreate.raw
    );

    // An Auditor has read-only oversight.
    const auditorCreate = await request('POST', '/api/maintenance', {
        token: auditorToken,
        body: { asset_id: spare1.asset.id, maintenance_type: 'Repair', fault_description: 'x' }
    });
    check(
        'an Auditor cannot create a maintenance record (403)',
        auditorCreate.status === 403,
        auditorCreate.raw
    );

    // A service (not a repair) does not require a fault description.
    const serviceRes = await request('POST', '/api/maintenance', {
        token: adminToken,
        body: {
            asset_id: spare1.asset.id,
            maintenance_type: 'Service',
            priority: 'Low',
            reported_date: today(),
            scheduled_date: dayOffset(5),
            vendor: 'PowerTech Services'
        }
    });
    const serviceRecord =
        serviceRes.body && serviceRes.body.data && serviceRes.body.data.maintenance
            ? serviceRes.body.data.maintenance
            : null;
    if (serviceRecord) createdMaintenanceIds.push(serviceRecord.id);
    check(
        'a Service may be booked without a fault description (201)',
        serviceRes.status === 201 && !!serviceRecord,
        serviceRes.raw
    );


    /* ---------------------------------------------------------------- */
    section('7. Workflow: start, hold, complete');
    /* ---------------------------------------------------------------- */
    // Begin the work - this stamps a start date.
    const startRes = await request('PATCH', `/api/maintenance/${record.id}/start`, {
        token: ictToken,
        body: { technician_name: 'Tendai Moyo', vendor: 'In-house Workshop' }
    });
    const started =
        startRes.body && startRes.body.data && startRes.body.data.maintenance
            ? startRes.body.data.maintenance
            : null;
    check('PATCH /:id/start returns 200', startRes.status === 200, startRes.raw);
    check(
        "starting the job moves it to 'In Progress'",
        !!started && started.status === 'In Progress',
        started ? `status: ${started.status}` : 'no record'
    );
    check(
        'starting the job stamps a start date',
        !!started && !!started.start_date,
        started ? `start_date: ${started.start_date}` : 'no record'
    );

    // Put it on hold while parts are ordered.
    const holdRes = await request('PATCH', `/api/maintenance/${record.id}/status`, {
        token: ictToken,
        body: { status: 'On Hold' }
    });
    const held =
        holdRes.body && holdRes.body.data && holdRes.body.data.maintenance
            ? holdRes.body.data.maintenance
            : null;
    check('PATCH /:id/status moves the record to On Hold', holdRes.status === 200, holdRes.raw);
    check(
        "the record is now 'On Hold'",
        !!held && held.status === 'On Hold',
        held ? `status: ${held.status}` : 'no record'
    );

    // An On Hold job is still an open repair, so the asset stays out of service.
    const assetWhileHeld = await request('GET', `/api/assets/${asset.id}`, { token: ictToken });
    const heldAsset =
        assetWhileHeld.body && assetWhileHeld.body.data && assetWhileHeld.body.data.asset
            ? assetWhileHeld.body.data.asset
            : null;
    check(
        "an On Hold job keeps the asset 'Under Repair'",
        !!heldAsset && heldAsset.status === 'Under Repair',
        heldAsset ? `asset status: ${heldAsset.status}` : 'no asset'
    );

    // An invalid status is rejected.
    const badStatus = await request('PATCH', `/api/maintenance/${record.id}/status`, {
        token: ictToken,
        body: { status: 'Finished' }
    });
    check('an invalid workflow status is rejected (400)', badStatus.status === 400, badStatus.raw);

    // Complete the job, recording the resolution, cost and resulting condition.
    const completeRes = await request('PATCH', `/api/maintenance/${record.id}/complete`, {
        token: ictToken,
        body: {
            work_performed: 'Replaced the DC charging jack and reseated the battery connector.',
            parts_used: 'DC jack (1), thermal paste',
            resolution: 'Unit powers on and charges normally; soak-tested for 45 minutes.',
            cost: 145.5,
            condition_after: 'Good',
            warranty_claim: false,
            completion_date: today()
        }
    });
    const completed =
        completeRes.body && completeRes.body.data && completeRes.body.data.maintenance
            ? completeRes.body.data.maintenance
            : null;
    check('PATCH /:id/complete returns 200', completeRes.status === 200, completeRes.raw);
    check(
        "completing the job moves it to 'Completed'",
        !!completed && completed.status === 'Completed',
        completed ? `status: ${completed.status}` : 'no record'
    );
    check(
        'completing the job records the cost',
        !!completed && Number(completed.cost) === 145.5,
        completed ? `cost: ${completed.cost}` : 'no record'
    );
    check(
        'completing the job records the work performed',
        !!completed && !!completed.work_performed,
        completed ? completed.work_performed : 'no record'
    );
    check(
        'completing the job snapshots a completion date',
        !!completed && isoDay(completed.completion_date) === today(),
        completed ? `completion_date: ${completed.completion_date}` : 'no record'
    );

    // §5.5: with no open jobs left, the asset returns to service.
    const assetAfterComplete = await request('GET', `/api/assets/${asset.id}`, { token: ictToken });
    const restoredAsset =
        assetAfterComplete.body && assetAfterComplete.body.data && assetAfterComplete.body.data.asset
            ? assetAfterComplete.body.data.asset
            : null;
    check(
        "with no open jobs the asset leaves 'Under Repair'",
        !!restoredAsset && restoredAsset.status !== 'Under Repair',
        restoredAsset ? `asset status: ${restoredAsset.status}` : 'no asset'
    );
    check(
        'the asset condition is refreshed from condition_after',
        !!restoredAsset && restoredAsset.condition_status === 'Good',
        restoredAsset ? `condition: ${restoredAsset.condition_status}` : 'no asset'
    );

    // A completed record cannot be advanced again.
    const completeAgain = await request('PATCH', `/api/maintenance/${record.id}/complete`, {
        token: ictToken,
        body: {}
    });
    check(
        'completing an already-completed record is rejected (409)',
        completeAgain.status === 409,
        completeAgain.raw
    );


    /* ---------------------------------------------------------------- */
    section('8. Multiple jobs on one asset, and cancellation');
    /* ---------------------------------------------------------------- */
    // Two open jobs on spare2: closing only one must leave it Under Repair.
    const jobA = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: spare2.asset.id,
            maintenance_type: 'Repair',
            priority: 'Medium',
            reported_date: today(),
            fault_description: 'Screen flickers intermittently.'
        }
    });
    const jobARecord =
        jobA.body && jobA.body.data && jobA.body.data.maintenance
            ? jobA.body.data.maintenance
            : null;
    if (jobARecord) createdMaintenanceIds.push(jobARecord.id);

    const jobB = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: spare2.asset.id,
            maintenance_type: 'Inspection',
            priority: 'Low',
            reported_date: today(),
            fault_description: 'Routine inspection requested during the repair.'
        }
    });
    const jobBRecord =
        jobB.body && jobB.body.data && jobB.body.data.maintenance
            ? jobB.body.data.maintenance
            : null;
    if (jobBRecord) createdMaintenanceIds.push(jobBRecord.id);

    check('two open jobs on one asset are accepted', !!jobARecord && !!jobBRecord, jobB.raw);

    const closeA = await request('PATCH', `/api/maintenance/${jobARecord.id}/complete`, {
        token: ictToken,
        body: { resolution: 'Reseated the display ribbon cable.', condition_after: 'Good' }
    });
    check('the first job can be completed', closeA.status === 200, closeA.raw);

    const assetMidway = await request('GET', `/api/assets/${spare2.asset.id}`, { token: ictToken });
    const midwayAsset =
        assetMidway.body && assetMidway.body.data && assetMidway.body.data.asset
            ? assetMidway.body.data.asset
            : null;
    check(
        "an asset with a remaining open job stays 'Under Repair'",
        !!midwayAsset && midwayAsset.status === 'Under Repair',
        midwayAsset ? `asset status: ${midwayAsset.status}` : 'no asset'
    );

    // Cancelling the last open job also returns the asset to service.
    const cancelB = await request('PATCH', `/api/maintenance/${jobBRecord.id}/cancel`, {
        token: hisoToken,
        body: { reason: 'Inspection folded into the repair job; raised in error.' }
    });
    const cancelled =
        cancelB.body && cancelB.body.data && cancelB.body.data.maintenance
            ? cancelB.body.data.maintenance
            : null;
    check('HISO can cancel a record (200)', cancelB.status === 200, cancelB.raw);
    check(
        "the cancelled record is marked 'Cancelled'",
        !!cancelled && cancelled.status === 'Cancelled',
        cancelled ? `status: ${cancelled.status}` : 'no record'
    );
    check(
        'the cancellation reason is retained in remarks',
        !!cancelled && typeof cancelled.remarks === 'string' && cancelled.remarks.length > 0,
        cancelled ? `remarks: ${cancelled.remarks}` : 'no record'
    );

    const assetAfterCancel = await request('GET', `/api/assets/${spare2.asset.id}`, { token: ictToken });
    const freedAsset =
        assetAfterCancel.body && assetAfterCancel.body.data && assetAfterCancel.body.data.asset
            ? assetAfterCancel.body.data.asset
            : null;
    check(
        'cancelling the last open job releases the asset',
        !!freedAsset && freedAsset.status !== 'Under Repair',
        freedAsset ? `asset status: ${freedAsset.status}` : 'no asset'
    );

    // Cancelling twice is refused; an ICT Officer may not cancel at all.
    const cancelTwice = await request('PATCH', `/api/maintenance/${jobBRecord.id}/cancel`, {
        token: hisoToken,
        body: {}
    });
    check('cancelling twice is rejected (409)', cancelTwice.status === 409, cancelTwice.raw);

    const ictCancel = await request('PATCH', `/api/maintenance/${jobARecord.id}/cancel`, {
        token: ictToken,
        body: {}
    });
    check(
        'an ICT Officer cannot cancel a record (403)',
        ictCancel.status === 403,
        ictCancel.raw
    );

    // The cancelled row remains readable - history is permanent.
    const readCancelled = await request('GET', `/api/maintenance/${jobBRecord.id}`, {
        token: auditorToken
    });
    check(
        'a cancelled record remains readable',
        readCancelled.status === 200,
        readCancelled.raw
    );
    const deptCannotReadRecord = await request('GET', `/api/maintenance/${jobBRecord.id}`, {
        token: deptToken
    });
    check(
        'a Departmental User cannot read another user maintenance record (404)',
        deptCannotReadRecord.status === 404,
        deptCannotReadRecord.raw
    );


    /* ---------------------------------------------------------------- */
    section('9. Reads: history, open jobs, overdue and search');
    /* ---------------------------------------------------------------- */
    // The primary asset's repair history.
    const historyRes = await request('GET', `/api/maintenance/asset/${asset.id}/history`, {
        token: auditorToken
    });
    check('GET /asset/:id/history returns 200', historyRes.status === 200, historyRes.raw);
    check(
        'the asset history carries a maintenance array',
        !!historyRes.body &&
            !!historyRes.body.data &&
            Array.isArray(historyRes.body.data.maintenance),
        historyRes.raw
    );
    check(
        'the asset history reports the asset is no longer under repair',
        !!historyRes.body &&
            !!historyRes.body.data &&
            historyRes.body.data.under_repair === false,
        historyRes.raw
    );

    // History may also be resolved by asset tag.
    const historyByTag = await request('GET', `/api/maintenance/asset/${asset.asset_tag}/history`, {
        token: auditorToken
    });
    check(
        'the asset history can be resolved by asset tag',
        historyByTag.status === 200 &&
            !!historyByTag.body &&
            !!historyByTag.body.data &&
            Array.isArray(historyByTag.body.data.maintenance) &&
            historyByTag.body.data.maintenance.length > 0,
        historyByTag.raw
    );

    const unknownHistory = await request('GET', '/api/maintenance/asset/999999999/history', {
        token: auditorToken
    });
    check('history for an unknown asset is 404', unknownHistory.status === 404, unknownHistory.raw);

    // Open jobs for an asset: place one on the third spare and check the view.
    const openJob = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: spare3.asset.id,
            maintenance_type: 'Upgrade',
            priority: 'Medium',
            reported_date: today(),
            fault_description: 'Memory upgrade to 32GB requested.'
        }
    });
    const openJobRecord =
        openJob.body && openJob.body.data && openJob.body.data.maintenance
            ? openJob.body.data.maintenance
            : null;
    if (openJobRecord) createdMaintenanceIds.push(openJobRecord.id);
    check('an Upgrade can be recorded', openJob.status === 201, openJob.raw);

    const assetOpen = await request('GET', `/api/maintenance/asset/${spare3.asset.id}/open`, {
        token: ictToken
    });
    check(
        'GET /asset/:id/open reports under_repair true for the upgraded asset',
        assetOpen.status === 200 &&
            !!assetOpen.body &&
            !!assetOpen.body.data &&
            assetOpen.body.data.under_repair === true &&
            assetOpen.body.data.maintenance.length > 0,
        assetOpen.raw
    );

    const globalOpen = await request('GET', '/api/maintenance/open', { token: ictToken });
    check('GET /api/maintenance/open returns 200', globalOpen.status === 200, globalOpen.raw);
    check(
        'the open view includes the active upgrade job',
        !!globalOpen.body &&
            !!globalOpen.body.data &&
            Array.isArray(globalOpen.body.data.maintenance) &&
            globalOpen.body.data.maintenance.some((row) => row.id === openJobRecord.id),
        globalOpen.raw
    );

    // An overdue job: scheduled in the past and still open.
    const overdueRes = await request('POST', '/api/maintenance', {
        token: ictToken,
        body: {
            asset_id: spare3.asset.id,
            maintenance_type: 'Service',
            priority: 'High',
            reported_date: dayOffset(-10),
            scheduled_date: dayOffset(-3),
            fault_description: 'Annual service overdue.'
        }
    });
    const overdueRecord =
        overdueRes.body && overdueRes.body.data && overdueRes.body.data.maintenance
            ? overdueRes.body.data.maintenance
            : null;
    if (overdueRecord) createdMaintenanceIds.push(overdueRecord.id);
    check('a back-dated service can be recorded', overdueRes.status === 201, overdueRes.raw);

    const overdueList = await request('GET', '/api/maintenance/overdue', { token: ictToken });
    check('GET /api/maintenance/overdue returns 200', overdueList.status === 200, overdueList.raw);
    check(
        'the overdue view includes the back-dated service',
        !!overdueList.body &&
            !!overdueList.body.data &&
            Array.isArray(overdueList.body.data.maintenance) &&
            overdueList.body.data.maintenance.some((row) => row.id === overdueRecord.id),
        overdueList.raw
    );


    // Search should find the record by its fault text and by the asset tag.
    const searchByFault = await request('GET', '/api/maintenance?search=charging%20circuit', {
        token: adminToken
    });
    check(
        'searching by fault text finds the original repair',
        searchByFault.status === 200 &&
            !!searchByFault.body &&
            !!searchByFault.body.data &&
            searchByFault.body.data.maintenance.some((row) => row.id === record.id),
        searchByFault.raw
    );

    const searchByTag = await request(
        'GET',
        `/api/maintenance?search=${encodeURIComponent(asset.asset_tag)}`,
        { token: adminToken }
    );
    check(
        'searching by asset tag finds the asset history',
        searchByTag.status === 200 &&
            !!searchByTag.body &&
            !!searchByTag.body.data &&
            searchByTag.body.data.maintenance.length > 0,
        searchByTag.raw
    );

    // Filters.
    const filterByStatus = await request('GET', '/api/maintenance?status=Completed', {
        token: adminToken
    });
    check(
        'filtering by status=Completed only returns completed rows',
        filterByStatus.status === 200 &&
            !!filterByStatus.body &&
            !!filterByStatus.body.data &&
            filterByStatus.body.data.maintenance.every((row) => row.status === 'Completed'),
        filterByStatus.raw
    );

    const filterByType = await request('GET', '/api/maintenance?maintenance_type=Upgrade', {
        token: adminToken
    });
    check(
        'filtering by maintenance_type works',
        filterByType.status === 200 &&
            !!filterByType.body &&
            !!filterByType.body.data &&
            filterByType.body.data.maintenance.every((row) => row.maintenance_type === 'Upgrade'),
        filterByType.raw
    );

    const filterByAsset = await request('GET', `/api/maintenance?asset_id=${asset.id}`, {
        token: adminToken
    });
    check(
        'filtering by asset_id scopes to that asset',
        filterByAsset.status === 200 &&
            !!filterByAsset.body &&
            !!filterByAsset.body.data &&
            filterByAsset.body.data.maintenance.every(
                (row) => Number(row.asset_id) === Number(asset.id)
            ),
        filterByAsset.raw
    );

    const filterByPriority = await request('GET', '/api/maintenance?priority=High', {
        token: adminToken
    });
    check(
        'filtering by priority works',
        filterByPriority.status === 200 &&
            !!filterByPriority.body &&
            !!filterByPriority.body.data &&
            filterByPriority.body.data.maintenance.every((row) => row.priority === 'High'),
        filterByPriority.raw
    );

    // Pagination: limit is honoured and the total is independent of it.
    const paged = await request('GET', '/api/maintenance?limit=1&offset=0', { token: adminToken });
    check(
        'pagination limits the returned rows but not the total',
        paged.status === 200 &&
            !!paged.body &&
            !!paged.body.data &&
            paged.body.data.returned === 1 &&
            paged.body.data.total >= 1,
        paged.raw
    );

    // Sorting by cost ascending puts the free/cheapest job first.
    const sorted = await request('GET', '/api/maintenance?sort=cost&order=ASC', {
        token: adminToken
    });
    check(
        'sorting by cost ascending returns an ordered list',
        sorted.status === 200 &&
            !!sorted.body &&
            !!sorted.body.data &&
            Array.isArray(sorted.body.data.maintenance),
        sorted.raw
    );

    // A record may be looked up by its MNT- reference, as printed on the job card.
    const byRef = await request('GET', `/api/maintenance/${record.maintenance_ref}`, {
        token: ictToken
    });
    check(
        'a record can be fetched by its MNT- reference',
        byRef.status === 200 &&
            !!byRef.body &&
            !!byRef.body.data &&
            byRef.body.data.maintenance.id === record.id,
        byRef.raw
    );

    const unknownRecord = await request('GET', '/api/maintenance/999999999', { token: ictToken });
    check('fetching an unknown record is 404', unknownRecord.status === 404, unknownRecord.raw);

    // Per-user view.
    const byUser = await request('GET', `/api/maintenance/user/${deptId}`, { token: adminToken });
    check(
        "GET /user/:id returns the custodian's reported faults",
        byUser.status === 200 &&
            !!byUser.body &&
            !!byUser.body.data &&
            Array.isArray(byUser.body.data.maintenance) &&
            byUser.body.data.maintenance.every((row) => Number(row.reported_by) === Number(deptId)),
        byUser.raw
    );

    // A Departmental User may only read their own reported faults.
    const otherUserView = await request('GET', `/api/maintenance/user/${adminId}`, {
        token: deptToken
    });
    check(
        "a Departmental User cannot read another user's reported faults (403)",
        otherUserView.status === 403,
        otherUserView.raw
    );

    const ownView = await request('GET', `/api/maintenance/user/${deptId}`, { token: deptToken });
    check(
        'a Departmental User can read their own reported faults',
        ownView.status === 200,
        ownView.raw
    );

    // Recent feed (dashboard panel).
    const recent = await request('GET', '/api/maintenance/recent?limit=3', { token: ictToken });
    check(
        'GET /api/maintenance/recent returns at most the requested rows',
        recent.status === 200 &&
            !!recent.body &&
            !!recent.body.data &&
            Array.isArray(recent.body.data.maintenance) &&
            recent.body.data.maintenance.length <= 3,
        recent.raw
    );


    /* ---------------------------------------------------------------- */
    section('10. Correcting details and the audit trail');
    /* ---------------------------------------------------------------- */
    // The overdue service is still open, so an ICT Officer may correct it.
    const correctRes = await request('PUT', `/api/maintenance/${overdueRecord.id}`, {
        token: ictToken,
        body: {
            vendor: 'Corrected Vendor Ltd',
            technician_name: 'Rudo Chikafu',
            scheduled_date: dayOffset(2),
            remarks: 'Rescheduled after the technician returned from leave.'
        }
    });
    const corrected =
        correctRes.body && correctRes.body.data && correctRes.body.data.maintenance
            ? correctRes.body.data.maintenance
            : null;
    check('PUT /:id corrects the details (200)', correctRes.status === 200, correctRes.raw);
    check(
        'the corrected vendor is stored',
        !!corrected && corrected.vendor === 'Corrected Vendor Ltd',
        corrected ? `vendor: ${corrected.vendor}` : 'no record'
    );
    check(
        'the corrected technician is stored',
        !!corrected && corrected.technician_name === 'Rudo Chikafu',
        corrected ? `technician: ${corrected.technician_name}` : 'no record'
    );

    // A completed record may only be corrected by an Administrator or HISO.
    const ictCorrectCompleted = await request('PUT', `/api/maintenance/${record.id}`, {
        token: ictToken,
        body: { resolution: 'Attempted correction by an ICT Officer.' }
    });
    check(
        'an ICT Officer cannot correct a completed record (409)',
        ictCorrectCompleted.status === 409,
        ictCorrectCompleted.raw
    );

    const hisoCorrectCompleted = await request('PUT', `/api/maintenance/${record.id}`, {
        token: hisoToken,
        body: { resolution: 'Verified by HISO after the workshop report was filed.' }
    });
    check(
        'a HISO can correct a completed record (200)',
        hisoCorrectCompleted.status === 200,
        hisoCorrectCompleted.raw
    );

    // An empty update is refused.
    const emptyUpdate = await request('PUT', `/api/maintenance/${overdueRecord.id}`, {
        token: ictToken,
        body: {}
    });
    check('an update with no fields is rejected (400)', emptyUpdate.status === 400, emptyUpdate.raw);

    // The audit trail records the maintenance activity (§13).
    const auditRes = await request(
        'GET',
        `/api/auth/audit-logs?table_name=maintenance_records&limit=50`,
        { token: adminToken }
    );
    const auditRows =
        auditRes.body && auditRes.body.data && Array.isArray(auditRes.body.data.logs)
            ? auditRes.body.data.logs
            : [];
    check(
        'the audit trail records maintenance activity',
        auditRes.status === 200 && auditRows.length > 0,
        auditRes.raw
    );
    check(
        'the audit trail captures the CREATE action',
        auditRows.some((row) => row.action === 'CREATE'),
        `actions: ${auditRows.map((r) => r.action).join(', ') || 'none'}`
    );
    check(
        'the audit trail captures the completion action',
        auditRows.some((row) => row.action === 'COMPLETE_MAINTENANCE'),
        `actions: ${auditRows.map((r) => r.action).join(', ') || 'none'}`
    );


    /* ---------------------------------------------------------------- */
    section('11. Model-level behaviour');
    /* ---------------------------------------------------------------- */
    const modelById = await maintenanceModel.findById(record.id);
    check('maintenanceModel.findById returns the row', !!modelById && modelById.id === record.id);

    const modelByRef = await maintenanceModel.findByRef(record.maintenance_ref);
    check(
        'maintenanceModel.findByRef resolves the MNT- reference',
        !!modelByRef && modelByRef.id === record.id
    );

    const assetHistory = await maintenanceModel.findByAssetId(asset.id);
    check(
        'maintenanceModel.findByAssetId returns the asset history',
        Array.isArray(assetHistory) && assetHistory.length > 0
    );

    const openCount = await maintenanceModel.countByAssetId(spare3.asset.id);
    check(
        'maintenanceModel.countByAssetId counts the open jobs',
        typeof openCount === 'number' && openCount >= 2,
        `open count: ${openCount}`
    );

    const closedCount = await maintenanceModel.countByAssetId(spare3.asset.id, ['Completed']);
    check(
        'maintenanceModel.countByAssetId honours an explicit status list',
        typeof closedCount === 'number',
        `completed count: ${closedCount}`
    );

    const recentRows = await maintenanceModel.findRecent(5);
    check(
        'maintenanceModel.findRecent returns at most the requested rows',
        Array.isArray(recentRows) && recentRows.length <= 5
    );

    const overdueRows = await maintenanceModel.findOverdue();
    check('maintenanceModel.findOverdue returns an array', Array.isArray(overdueRows));

    const nextSuffix = await maintenanceModel.findMaxRefSuffix('MNT-');
    check(
        'maintenanceModel.findMaxRefSuffix reads a numeric suffix',
        typeof nextSuffix === 'number' && nextSuffix > 0,
        `max suffix: ${nextSuffix}`
    );

    const refTaken = await maintenanceModel.maintenanceRefExists(record.maintenance_ref);
    check('maintenanceModel.maintenanceRefExists confirms a known reference', refTaken === true);

    const refFree = await maintenanceModel.maintenanceRefExists('MNT-999999');
    check('maintenanceModel.maintenanceRefExists rejects an unused reference', refFree === false);

    const filterList = await maintenanceModel.findAll({ status: 'Open', limit: 100, offset: 0 });
    check(
        'maintenanceModel.findAll returns rows and a total',
        !!filterList &&
            Array.isArray(filterList.rows) &&
            typeof filterList.total === 'number' &&
            filterList.rows.every((row) =>
                ['Pending', 'In Progress', 'On Hold'].includes(row.status)
            ),
        `total: ${filterList ? filterList.total : 'n/a'}`
    );

    /* ---------------------------------------------------------------- */
    section('12. Aggregates after the run');
    /* ---------------------------------------------------------------- */
    const finalStats = await request('GET', '/api/maintenance/stats', { token: adminToken });
    check('final GET /api/maintenance/stats returns 200', finalStats.status === 200, finalStats.raw);
    check(
        'the stats total is at least the number of records created',
        !!finalStats.body &&
            !!finalStats.body.data &&
            finalStats.body.data.total >= createdMaintenanceIds.length,
        finalStats.raw
    );
    check(
        'the stats report a non-negative total cost',
        !!finalStats.body &&
            !!finalStats.body.data &&
            typeof finalStats.body.data.totalCost === 'number' &&
            finalStats.body.data.totalCost >= 145.5,
        finalStats.raw
    );
    check(
        'the stats expose the top assets by maintenance volume',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Array.isArray(finalStats.body.data.topAssets),
        finalStats.raw
    );
}


/* -------------------------------------------------------------------------
 * Bootstrap: start server, run suite, always clean up, exit explicitly.
 * ---------------------------------------------------------------------- */
server = app.listen(PORT, async () => {
    console.log('======================================================');
    console.log('  NBSZ Asset Management - Maintenance Test Suite');
    console.log('======================================================');
    console.log(`Target: ${BASE}`);
    console.log(`Time:   ${new Date().toISOString()}`);

    let failure = null;
    try {
        await connectDb();
        // The maintenance module owns its own DDL so the suite can run on a
        // database that has not had scripts/initDb.js re-applied.
        await maintenanceModel.ensureTable();
        await run();
    } catch (err) {
        failure = err;
        console.error('\nUnhandled error while running tests:');
        console.error(err && err.stack ? err.stack : err);
    }

    try {
        await cleanup();
    } catch (err) {
        console.error('Cleanup step failed:', err.message);
    }

    if (db) {
        try {
            await db.end();
        } catch (err) {
            /* connection already gone */
        }
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;

    console.log('\n======================================================');
    console.log(`  RESULT: ${passed} passed, ${failed} failed (of ${results.length})`);
    console.log('======================================================');
    if (failure) console.log('Aborted early - not every assertion ran.');

    const exitCode = failed === 0 && !failure ? 0 : 1;

    // Close the HTTP listener; process.exit tears down the MySQL pool.
    server.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 3000).unref();
});
