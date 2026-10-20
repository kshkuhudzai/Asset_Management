'use strict';

/**
 * scripts/testWarranty.js
 * ---------------------------------------------------------------------------
 * Standalone smoke/regression test for the Warranty & Contract Monitoring slice
 * (§5.6).
 *
 * Boots the real Express app (which also verifies the MySQL connection) on an
 * isolated port, fires real HTTP requests at it, and asserts on the responses.
 * No test-runner dependency is required - run it with:
 *
 *     node scripts/testWarranty.js
 *
 * The suite is self-contained: it creates its own role accounts, category and
 * assets, and hard-deletes everything it created at the end (the API itself
 * never deletes warranty rows, by design).
 *
 * Exit code 0 = all checks passed, 1 = at least one check failed.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const app = require('../server');
const warrantyModel = require('../models/warrantyModel');

// Dedicated port so this can run even while the dev server is up.
const PORT = process.env.WARRANTY_TEST_PORT || 3998;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let server = null;

// Ids created during the run, cleaned up at the end.
const createdWarrantyIds = [];
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

/** Today as YYYY-MM-DD in the local timezone - matches the controller's `today()`. */
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
 * Removes everything this suite created. Child rows (warranty records,
 * audit_logs) must go before the parent users/assets because of the foreign
 * keys.
 */
async function cleanup() {
    if (!db) return;

    try {
        if (createdWarrantyIds.length) {
            await db.query(
                `DELETE FROM audit_logs
                 WHERE table_name = 'warranties' AND record_id IN (?)`,
                [createdWarrantyIds]
            );
            // Renewals may have cleared renewed_from via ON DELETE SET NULL, but
            // delete the successors first so the FK never blocks.
            await db.query('DELETE FROM warranties WHERE id IN (?)', [createdWarrantyIds]);
        }

        if (createdAssetIds.length) {
            await db.query(
                `DELETE FROM audit_logs WHERE table_name = 'warranties' AND record_id IN (
                    SELECT id FROM warranties WHERE asset_id IN (?)
                 )`,
                [createdAssetIds]
            );
            await db.query('DELETE FROM warranties WHERE asset_id IN (?)', [createdAssetIds]);
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
    const tagSeed = `WAR-${stamp}`;

    let adminToken = null;
    let hisoToken = null;
    let ictToken = null;
    let deptToken = null;
    let auditorToken = null;

    /* ---------------------------------------------------------------- */
    section('1. Infrastructure');
    /* ---------------------------------------------------------------- */
    const health = await request('GET', '/api/health');
    check('GET /api/health returns 200', health.status === 200, health.raw);

    const adminUser = {
        username: 'wty_admin_test',
        email: 'wty.admin.test@nbsz.co.zw',
        password: 'WtyAdmin@123',
        fullName: 'Warranty Test Administrator',
        role: 'System Administrator'
    };
    const hisoUser = {
        username: 'wty_hiso_test',
        email: 'wty.hiso.test@nbsz.co.zw',
        password: 'WtyHiso@123',
        fullName: 'Warranty Test HISO',
        role: 'HISO'
    };
    const ictUser = {
        username: 'wty_ict_test',
        email: 'wty.ict.test@nbsz.co.zw',
        password: 'WtyIct@123',
        fullName: 'Warranty Test ICT Officer',
        role: 'ICT Officer'
    };
    const deptUser = {
        username: 'wty_dept_test',
        email: 'wty.dept.test@nbsz.co.zw',
        password: 'WtyDept@123',
        fullName: 'Warranty Test Departmental User',
        role: 'Departmental User'
    };
    const auditorUser = {
        username: 'wty_auditor_test',
        email: 'wty.auditor.test@nbsz.co.zw',
        password: 'WtyAudit@123',
        fullName: 'Warranty Test Auditor',
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

    // A warranty endpoint must reject an anonymous caller.
    const anon = await request('GET', '/api/warranties');
    check('an unauthenticated warranty request is rejected (401)', anon.status === 401, anon.raw);

    const ctx = { adminId, hisoId, ictId, deptId, auditorId };



    /* ---------------------------------------------------------------- */
    section('2. Fixtures: category and assets');
    /* ---------------------------------------------------------------- */
    const categoryName = `Warranty Category ${tagSeed}`;
    const createCategory = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: categoryName, description: 'Created by the warranty test suite.' }
    });
    const categoryId =
        createCategory.body && createCategory.body.data && createCategory.body.data.category
            ? createCategory.body.data.category.id
            : null;
    if (categoryId) createdCategoryIds.push(categoryId);
    check('asset category created', !!categoryId, createCategory.raw);

    /**
     * Registers an asset through the real API so the fixtures follow exactly
     * the same path as production data. The register warranty columns are left
     * empty here so the derived/registered warranty paths can be tested
     * separately.
     */
    async function createAsset(suffix, overrides = {}) {
        const payload = {
            asset_tag: `${tagSeed}-${suffix}`,
            serial_number: `${tagSeed}-SN-${suffix}`,
            category_id: categoryId,
            manufacturer: 'WarrantyTest',
            model: 'Model-W',
            location: 'Head Office',
            department: 'ICT',
            status: 'In Stock',
            condition_status: 'Good',
            ...overrides
        };

        const res = await request('POST', '/api/assets', { token: adminToken, body: payload });
        const created = res.body && res.body.data && res.body.data.asset ? res.body.data.asset : null;
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

    // An asset registered with warranty columns filled in, so the derived
    // (register-sourced) warranty path can be exercised.
    const registered = await createAsset('D', {
        warranty_provider: 'Register Provider Ltd',
        warranty_start: dayOffset(-30),
        warranty_end: dayOffset(30),
        warranty_ref: `${tagSeed}-REGWR`
    });
    check('asset with register warranty created', !!registered.asset, registered.res.raw);

    // An asset whose register warranty has already lapsed.
    const lapsed = await createAsset('E', {
        warranty_provider: 'Expired Provider Ltd',
        warranty_start: dayOffset(-800),
        warranty_end: dayOffset(-400),
        warranty_ref: `${tagSeed}-OLDWR`
    });
    check('asset with expired register warranty created', !!lapsed.asset, lapsed.res.raw);

    if (!asset) {
        throw new Error('Cannot continue without the primary test asset.');
    }



    /* ---------------------------------------------------------------- */
    section('3. Reference data (meta, stats)');
    /* ---------------------------------------------------------------- */
    const meta = await request('GET', '/api/warranties/meta', { token: ictToken });
    check('GET /api/warranties/meta returns 200', meta.status === 200, meta.raw);
    check(
        'meta exposes the warranty types',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.warranty_types) &&
            meta.body.data.warranty_types.includes('Asset Warranty') &&
            meta.body.data.warranty_types.includes('Support Contract'),
        meta.raw
    );
    check(
        'meta exposes the contract types',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.contract_types) &&
            meta.body.data.contract_types.includes('Maintenance Contract'),
        meta.raw
    );
    check(
        'meta exposes the lifecycle statuses',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.statuses) &&
            meta.body.data.statuses.includes('Expiring Soon') &&
            meta.body.data.statuses.includes('Cancelled'),
        meta.raw
    );
    check(
        'meta exposes the default expiry window (90 days)',
        !!meta.body && !!meta.body.data && meta.body.data.default_expiring_days === 90,
        meta.raw
    );
    check(
        'meta exposes a next warranty reference (WAR- prefix)',
        !!meta.body &&
            !!meta.body.data &&
            typeof meta.body.data.next_ref === 'string' &&
            meta.body.data.next_ref.startsWith('WAR-'),
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
    check(
        'meta exposes the custodian pick-list',
        !!meta.body && !!meta.body.data && Array.isArray(meta.body.data.users),
        meta.raw
    );

    const stats = await request('GET', '/api/warranties/stats', { token: auditorToken });
    check('GET /api/warranties/stats returns 200 for an Auditor', stats.status === 200, stats.raw);
    check(
        'stats report the register-derived warranty count',
        !!stats.body &&
            !!stats.body.data &&
            typeof stats.body.data.derivedFromRegister === 'number' &&
            stats.body.data.derivedFromRegister > 0,
        stats.raw
    );
    check(
        'stats echo the expiry window used',
        !!stats.body && !!stats.body.data && stats.body.data.expiringDays === 90,
        stats.raw
    );

    const statsWindowed = await request('GET', '/api/warranties/stats?days=30', {
        token: adminToken
    });
    check(
        'stats accept a configurable expiry window (?days=30)',
        statsWindowed.status === 200 &&
            !!statsWindowed.body &&
            !!statsWindowed.body.data &&
            statsWindowed.body.data.expiringDays === 30,
        statsWindowed.raw
    );

    // A Departmental User may read the register but not the aggregate figures.
    const deptStats = await request('GET', '/api/warranties/stats', { token: deptToken });
    check('a Departmental User is refused stats (403)', deptStats.status === 403, deptStats.raw);

    const deptMeta = await request('GET', '/api/warranties/meta', { token: deptToken });
    check('a Departmental User is refused meta (403)', deptMeta.status === 403, deptMeta.raw);



    /* ---------------------------------------------------------------- */
    section('4. Register-derived warranties (§6 coverage is visible)');
    /* ---------------------------------------------------------------- */
    const derivedList = await request(
        'GET',
        `/api/warranties?search=${encodeURIComponent(tagSeed)}&include_derived=true&limit=50`,
        { token: adminToken }
    );
    check('GET /api/warranties returns 200', derivedList.status === 200, derivedList.raw);

    const derivedRows =
        derivedList.body && derivedList.body.data && Array.isArray(derivedList.body.data.warranties)
            ? derivedList.body.data.warranties
            : [];

    check(
        'the list reports a derived count',
        !!derivedList.body &&
            !!derivedList.body.data &&
            typeof derivedList.body.data.derived === 'number' &&
            derivedList.body.data.derived >= 2,
        derivedList.raw
    );

    check(
        'register warranties appear with source=asset_register',
        derivedRows.some((row) => row.source === 'asset_register'),
        `sources: ${derivedRows.map((r) => r.source).join(', ') || 'none'}`
    );

    const derivedHealthy = derivedRows.filter(
        (row) => row.source === 'asset_register' && row.asset_id === registered.asset.id
    )[0];
    check(
        'the in-window register warranty is reported as Expiring Soon',
        !!derivedHealthy && derivedHealthy.coverage_state === 'Expiring Soon',
        derivedHealthy ? `state: ${derivedHealthy.coverage_state}` : 'not found'
    );
    check(
        'the register warranty carries the provider from the asset',
        !!derivedHealthy && derivedHealthy.provider === 'Register Provider Ltd',
        derivedHealthy ? `provider: ${derivedHealthy.provider}` : 'not found'
    );
    check(
        'the register warranty exposes a synthetic asset-<id> key',
        !!derivedHealthy && String(derivedHealthy.id) === `asset-${registered.asset.id}`,
        derivedHealthy ? `id: ${derivedHealthy.id}` : 'not found'
    );

    const derivedLapsed = derivedRows.filter(
        (row) => row.source === 'asset_register' && row.asset_id === lapsed.asset.id
    )[0];
    check(
        'a lapsed register warranty is reported as Expired',
        !!derivedLapsed && derivedLapsed.coverage_state === 'Expired',
        derivedLapsed ? `state: ${derivedLapsed.coverage_state}` : 'not found'
    );
    check(
        'the lapsed register warranty has a negative days_remaining',
        !!derivedLapsed && Number(derivedLapsed.days_remaining) < 0,
        derivedLapsed ? `days: ${derivedLapsed.days_remaining}` : 'not found'
    );

    // include_derived=false must hide the register rows.
    const storedOnly = await request(
        'GET',
        `/api/warranties?search=${encodeURIComponent(tagSeed)}&include_derived=false&limit=50`,
        { token: adminToken }
    );
    check(
        'include_derived=false hides the register rows',
        storedOnly.status === 200 &&
            !!storedOnly.body &&
            !!storedOnly.body.data &&
            storedOnly.body.data.warranties.every((row) => row.source !== 'asset_register'),
        storedOnly.raw
    );

    // A derived record must be read-only.
    const derivedRead = await request('GET', `/api/warranties/asset-${registered.asset.id}`, {
        token: adminToken
    });
    check(
        'a derived warranty can be fetched by its asset-<id> key',
        derivedRead.status === 200 &&
            !!derivedRead.body &&
            !!derivedRead.body.data &&
            derivedRead.body.data.warranty.source === 'asset_register',
        derivedRead.raw
    );

    const derivedEdit = await request('PUT', `/api/warranties/asset-${registered.asset.id}`, {
        token: adminToken,
        body: { title: 'Attempted edit of a derived row' }
    });
    check(
        'a derived warranty cannot be edited through this module (409)',
        derivedEdit.status === 409,
        derivedEdit.raw
    );

    const derivedCancel = await request(
        'PATCH',
        `/api/warranties/asset-${registered.asset.id}/cancel`,
        { token: adminToken, body: { reason: 'Should be refused' } }
    );
    check(
        'a derived warranty cannot be cancelled through this module (409)',
        derivedCancel.status === 409,
        derivedCancel.raw
    );



    /* ---------------------------------------------------------------- */
    section('5. Recording a warranty (§5.6 provider / start / expiry)');
    /* ---------------------------------------------------------------- */
    const createRes = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            asset_id: asset.id,
            warranty_type: 'Asset Warranty',
            title: 'Three-year on-site warranty',
            contract_ref: `ACME-${stamp}`,
            provider: 'Acme Technology Zimbabwe',
            provider_contact: 'Rudo Chikafu',
            provider_email: 'support@acme.co.zw',
            provider_phone: '+263 242 700 100',
            start_date: today(),
            expiry_date: dayOffset(365),
            notice_period_days: 30,
            auto_renew: false,
            coverage_details: 'Parts, labour and on-site callout.',
            excluded_items: 'Accidental damage and theft.',
            contract_value: 450.5,
            currency: 'usd',
            payment_terms: 'Net 30',
            remarks: 'Signed during the Q1 procurement round.'
        }
    });

    check('POST /api/warranties creates a record (201)', createRes.status === 201, createRes.raw);

    const record =
        createRes.body && createRes.body.data && createRes.body.data.warranty
            ? createRes.body.data.warranty
            : null;
    if (record) createdWarrantyIds.push(record.id);

    check('the created record is returned', !!record, createRes.raw);
    check(
        'the server mints a WAR- reference',
        !!record && typeof record.warranty_ref === 'string' && record.warranty_ref.startsWith('WAR-'),
        record ? `ref: ${record.warranty_ref}` : 'no record'
    );
    check(
        'the provider is stored (§5.6)',
        !!record && record.provider === 'Acme Technology Zimbabwe',
        record ? `provider: ${record.provider}` : 'no record'
    );
    check(
        'the start date is stored (§5.6)',
        !!record && isoDay(record.start_date) === today(),
        record ? `start: ${isoDay(record.start_date)}` : 'no record'
    );
    check(
        'the expiry date is stored (§5.6)',
        !!record && isoDay(record.expiry_date) === dayOffset(365),
        record ? `expiry: ${isoDay(record.expiry_date)}` : 'no record'
    );
    check(
        'the currency is normalised to upper case',
        !!record && record.currency === 'USD',
        record ? `currency: ${record.currency}` : 'no record'
    );
    check(
        'the contract value is stored as a number',
        !!record && Number(record.contract_value) === 450.5,
        record ? `value: ${record.contract_value}` : 'no record'
    );
    check(
        'the asset context is joined onto the record',
        !!record && record.asset_tag === asset.asset_tag,
        record ? `asset_tag: ${record.asset_tag}` : 'no record'
    );
    check(
        'days_remaining is computed for the new record',
        !!record && Number(record.days_remaining) >= 364 && Number(record.days_remaining) <= 366,
        record ? `days: ${record.days_remaining}` : 'no record'
    );
    check(
        'a warranty beyond the 90-day window is Active, not Expiring Soon',
        !!record && record.coverage_state === 'Active',
        record ? `state: ${record.coverage_state}` : 'no record'
    );
    check(
        'the record is attributed to its creator',
        !!record && record.created_by === ictId,
        record ? `created_by: ${record.created_by}` : 'no record'
    );


    // A short-dated warranty must fall into the alert window.
    const soonRes = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            asset_id: spare1.asset.id,
            warranty_type: 'Extended Warranty',
            title: 'Short extension',
            provider: 'Acme Technology Zimbabwe',
            start_date: today(),
            expiry_date: dayOffset(20),
            contract_value: 99
        }
    });
    const soonRecord =
        soonRes.body && soonRes.body.data && soonRes.body.data.warranty
            ? soonRes.body.data.warranty
            : null;
    if (soonRecord) createdWarrantyIds.push(soonRecord.id);
    check('a short-dated warranty is created (201)', soonRes.status === 201, soonRes.raw);
    check(
        'a warranty inside the 90-day window is Expiring Soon',
        !!soonRecord && soonRecord.coverage_state === 'Expiring Soon',
        soonRecord ? `state: ${soonRecord.coverage_state}` : 'no record'
    );

    // A site-wide contract with no asset.
    const contractRes = await request('POST', '/api/warranties', {
        token: hisoToken,
        body: {
            warranty_type: 'Maintenance Contract',
            title: 'Head office air-conditioning maintenance',
            contract_ref: `FAC-${stamp}`,
            provider: 'Facilities Management Ltd',
            provider_contact: 'Nyasha Banda',
            provider_email: 'fm@facilities.co.zw',
            start_date: today(),
            expiry_date: dayOffset(200),
            notice_period_days: 60,
            auto_renew: true,
            contract_value: 12000,
            currency: 'USD',
            coverage_details: 'Quarterly servicing of all CRAC units.'
        }
    });
    const contract =
        contractRes.body && contractRes.body.data && contractRes.body.data.warranty
            ? contractRes.body.data.warranty
            : null;
    if (contract) createdWarrantyIds.push(contract.id);
    check(
        'a site-wide contract with no asset is created (201)',
        contractRes.status === 201,
        contractRes.raw
    );
    check(
        'a site-wide contract stores a null asset_id',
        !!contract && contract.asset_id === null,
        contract ? `asset_id: ${contract.asset_id}` : 'no record'
    );
    check(
        'auto_renew is persisted as a boolean',
        !!contract && Number(contract.auto_renew) === 1,
        contract ? `auto_renew: ${contract.auto_renew}` : 'no record'
    );



    /* ---------------------------------------------------------------- */
    section('6. Validation rules');
    /* ---------------------------------------------------------------- */
    // Missing dates.
    const noDates = await request('POST', '/api/warranties', {
        token: ictToken,
        body: { provider: 'Incomplete Ltd' }
    });
    check('a warranty with no dates is rejected (400)', noDates.status === 400, noDates.raw);
    check(
        'the missing start_date is reported on the right field',
        !!noDates.body &&
            Array.isArray(noDates.body.errors) &&
            noDates.body.errors.some((e) => e.field === 'start_date'),
        noDates.raw
    );
    check(
        'the missing expiry_date is reported on the right field',
        !!noDates.body &&
            Array.isArray(noDates.body.errors) &&
            noDates.body.errors.some((e) => e.field === 'expiry_date'),
        noDates.raw
    );

    // Expiry before start.
    const badWindow = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            provider: 'Backwards Ltd',
            start_date: dayOffset(30),
            expiry_date: dayOffset(10)
        }
    });
    check(
        'an expiry date before the start date is rejected (400)',
        badWindow.status === 400,
        badWindow.raw
    );
    check(
        'the inverted window is reported on expiry_date',
        !!badWindow.body &&
            Array.isArray(badWindow.body.errors) &&
            badWindow.body.errors.some((e) => e.field === 'expiry_date'),
        badWindow.raw
    );

    // Expiry equal to start (a zero-length warranty).
    const zeroWindow = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            provider: 'Same Day Ltd',
            start_date: today(),
            expiry_date: today()
        }
    });
    check(
        'a zero-length warranty window is rejected (400)',
        zeroWindow.status === 400,
        zeroWindow.raw
    );

    // A nonsense calendar date.
    const badDate = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            provider: 'Impossible Ltd',
            start_date: '2026-02-31',
            expiry_date: '2026-12-31'
        }
    });
    check('an impossible calendar date is rejected (400)', badDate.status === 400, badDate.raw);

    // An unknown warranty type.
    const badType = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            provider: 'Odd Type Ltd',
            warranty_type: 'Lifetime Guarantee',
            start_date: today(),
            expiry_date: dayOffset(100)
        }
    });
    check('an unknown warranty_type is rejected (400)', badType.status === 400, badType.raw);

    // A negative contract value.
    const badValue = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            provider: 'Negative Ltd',
            start_date: today(),
            expiry_date: dayOffset(100),
            contract_value: -5
        }
    });
    check('a negative contract_value is rejected (400)', badValue.status === 400, badValue.raw);

    // A malformed provider e-mail.
    const badEmail = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            provider: 'Bad Email Ltd',
            provider_email: 'not-an-email',
            start_date: today(),
            expiry_date: dayOffset(100)
        }
    });
    check('a malformed provider_email is rejected (400)', badEmail.status === 400, badEmail.raw);
    check(
        'the malformed e-mail is reported on provider_email',
        !!badEmail.body &&
            Array.isArray(badEmail.body.errors) &&
            badEmail.body.errors.some((e) => e.field === 'provider_email'),
        badEmail.raw
    );

    // A bad notice period.
    const badNotice = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            provider: 'Bad Notice Ltd',
            start_date: today(),
            expiry_date: dayOffset(100),
            notice_period_days: 12.5
        }
    });
    check(
        'a fractional notice_period_days is rejected (400)',
        badNotice.status === 400,
        badNotice.raw
    );

    // A non-existent asset.
    const ghostAsset = await request('POST', '/api/warranties', {
        token: ictToken,
        body: {
            asset_id: 999999999,
            provider: 'Ghost Ltd',
            start_date: today(),
            expiry_date: dayOffset(100)
        }
    });
    check(
        'a warranty for an unknown asset is rejected (404)',
        ghostAsset.status === 404,
        ghostAsset.raw
    );


    // A disposed / retired asset should not be covered.
    const disposedAsset = await request('POST', '/api/assets', {
        token: adminToken,
        body: {
            asset_tag: `${tagSeed}-F`,
            serial_number: `${tagSeed}-SN-F`,
            category_id: categoryId,
            manufacturer: 'WarrantyTest',
            model: 'Model-W',
            location: 'Head Office',
            department: 'ICT',
            status: 'Disposed',
            condition_status: 'Obsolete'
        }
    });
    const disposed =
        disposedAsset.body && disposedAsset.body.data && disposedAsset.body.data.asset
            ? disposedAsset.body.data.asset
            : null;
    if (disposed) createdAssetIds.push(disposed.id);
    check('a disposed fixture asset was created', !!disposed, disposedAsset.raw);

    if (disposed) {
        const coverDisposed = await request('POST', '/api/warranties', {
            token: ictToken,
            body: {
                asset_id: disposed.id,
                provider: 'Waste of Money Ltd',
                start_date: today(),
                expiry_date: dayOffset(100)
            }
        });
        check(
            'a disposed asset cannot be covered (400)',
            coverDisposed.status === 400,
            coverDisposed.raw
        );
    }



    /* ---------------------------------------------------------------- */
    section('7. Upcoming-expiry alerts (§5.6 / §12)');
    /* ---------------------------------------------------------------- */
    const expiring = await request('GET', '/api/warranties/expiring', { token: auditorToken });
    check('GET /api/warranties/expiring returns 200', expiring.status === 200, expiring.raw);
    check(
        'the alert list reports the window it used',
        !!expiring.body && !!expiring.body.data && expiring.body.data.expiring_days === 90,
        expiring.raw
    );

    const expiringRows =
        expiring.body && expiring.body.data && Array.isArray(expiring.body.data.warranties)
            ? expiring.body.data.warranties
            : [];

    check(
        'the stored short-dated warranty is raised as an alert',
        expiringRows.some((row) => row.warranty_ref === soonRecord.warranty_ref),
        `refs: ${expiringRows.map((r) => r.warranty_ref).join(', ') || 'none'}`
    );
    check(
        'the register-derived warranty is raised as an alert',
        expiringRows.some((row) => String(row.id) === `asset-${registered.asset.id}`),
        `ids: ${expiringRows.map((r) => r.id).join(', ') || 'none'}`
    );
    check(
        'an already-expired warranty is excluded from the alert list',
        !expiringRows.some((row) => String(row.id) === `asset-${lapsed.asset.id}`),
        'lapsed asset appeared in the alert list'
    );
    check(
        'a cancelled warranty is excluded from the alert list',
        !expiringRows.some((row) => row.status === 'Cancelled'),
        'a cancelled row appeared in the alert list'
    );
    check(
        'the alert list is sorted by the most imminent expiry first',
        expiringRows.length < 2 ||
            new Date(expiringRows[0].expiry_date).getTime() <=
                new Date(expiringRows[1].expiry_date).getTime(),
        `first two: ${expiringRows.slice(0, 2).map((r) => isoDay(r.expiry_date)).join(', ')}`
    );

    // The window must be configurable (§12).
    const narrow = await request('GET', '/api/warranties/expiring?days=25', { token: adminToken });
    const narrowRows =
        narrow.body && narrow.body.data && Array.isArray(narrow.body.data.warranties)
            ? narrow.body.data.warranties
            : [];
    check(
        'a narrower window (?days=25) is honoured',
        narrow.status === 200 &&
            !!narrow.body &&
            !!narrow.body.data &&
            narrow.body.data.expiring_days === 25,
        narrow.raw
    );
    check(
        'the 20-day warranty still appears in a 25-day window',
        narrowRows.some((row) => row.warranty_ref === soonRecord.warranty_ref),
        `refs: ${narrowRows.map((r) => r.warranty_ref).join(', ') || 'none'}`
    );
    check(
        'a 25-day window is narrower than the default 90-day one',
        narrowRows.length <= expiringRows.length,
        `25d: ${narrowRows.length}, 90d: ${expiringRows.length}`
    );

    const expiredList = await request('GET', '/api/warranties/expired', { token: ictToken });
    check('GET /api/warranties/expired returns 200', expiredList.status === 200, expiredList.raw);

    /* ---------------------------------------------------------------- */
    section('8. Support and maintenance contracts (§5.6)');
    /* ---------------------------------------------------------------- */
    const contracts = await request('GET', '/api/warranties/contracts', { token: adminToken });
    check('GET /api/warranties/contracts returns 200', contracts.status === 200, contracts.raw);

    const contractRows =
        contracts.body && contracts.body.data && Array.isArray(contracts.body.data.warranties)
            ? contracts.body.data.warranties
            : [];
    check(
        'the site-wide maintenance contract is listed',
        contractRows.some((row) => row.warranty_ref === contract.warranty_ref),
        `refs: ${contractRows.map((r) => r.warranty_ref).join(', ') || 'none'}`
    );
    check(
        'every listed contract is a contract type, not a per-asset warranty',
        contractRows.every((row) =>
            [
                'Support Contract',
                'Maintenance Contract',
                'Service Level Agreement',
                'Licence Support'
            ].includes(row.warranty_type)
        ),
        `types: ${[...new Set(contractRows.map((r) => r.warranty_type))].join(', ') || 'none'}`
    );
    check(
        'a per-asset warranty is not returned by the contracts view',
        !contractRows.some((row) => row.warranty_ref === record.warranty_ref),
        'the asset warranty leaked into the contracts view'
    );
    check(
        'the contracts view only returns cover still in force by default',
        contracts.body.data.active_only === true,
        contracts.raw
    );

    const allContracts = await request(
        'GET',
        '/api/warranties/contracts?active_only=false',
        { token: adminToken }
    );
    check(
        'active_only=false is accepted',
        allContracts.status === 200 &&
            !!allContracts.body &&
            !!allContracts.body.data &&
            allContracts.body.data.active_only === false,
        allContracts.raw
    );



    /* ---------------------------------------------------------------- */
    section('9. Per-asset coverage and single-record reads');
    /* ---------------------------------------------------------------- */
    const assetCoverage = await request(
        'GET',
        `/api/warranties/asset/${encodeURIComponent(asset.asset_tag)}`,
        { token: adminToken }
    );
    check('GET /api/warranties/asset/:tag returns 200', assetCoverage.status === 200, assetCoverage.raw);
    check(
        'per-asset coverage lists the stored warranty',
        !!assetCoverage.body &&
            !!assetCoverage.body.data &&
            Array.isArray(assetCoverage.body.data.warranties) &&
            assetCoverage.body.data.warranties.some((row) => row.warranty_ref === record.warranty_ref),
        assetCoverage.raw
    );
    check(
        'per-asset coverage reports whether the asset is under warranty',
        !!assetCoverage.body &&
            !!assetCoverage.body.data &&
            assetCoverage.body.data.under_warranty === true,
        assetCoverage.raw
    );
    check(
        'per-asset coverage returns the register warranty window too',
        !!assetCoverage.body &&
            !!assetCoverage.body.data &&
            !!assetCoverage.body.data.register_warranty &&
            assetCoverage.body.data.register_warranty.read_only === true,
        assetCoverage.raw
    );

    const missingAsset = await request('GET', '/api/warranties/asset/NOPE-9999', {
        token: adminToken
    });
    check('an unknown asset returns 404', missingAsset.status === 404, missingAsset.raw);

    // Single record by numeric id and by WAR- reference.
    const byId = await request('GET', `/api/warranties/${record.id}`, { token: adminToken });
    check('GET /api/warranties/:id returns 200', byId.status === 200, byId.raw);
    const deptCannotReadWarranty = await request('GET', `/api/warranties/${record.id}`, {
        token: deptToken
    });
    check(
        'a Departmental User cannot read warranty details for an unassigned asset (404)',
        deptCannotReadWarranty.status === 404,
        deptCannotReadWarranty.raw
    );

    const byRef = await request('GET', `/api/warranties/${record.warranty_ref}`, { token: adminToken });
    check(
        'GET /api/warranties/:ref resolves the WAR- reference',
        byRef.status === 200 &&
            !!byRef.body &&
            !!byRef.body.data &&
            byRef.body.data.warranty.id === record.id,
        byRef.raw
    );

    const missing = await request('GET', '/api/warranties/999999999', { token: adminToken });
    check('an unknown warranty id returns 404', missing.status === 404, missing.raw);


    /* ---------------------------------------------------------------- */
    section('10. Correcting a record');
    /* ---------------------------------------------------------------- */
    const correct = await request('PUT', `/api/warranties/${record.id}`, {
        token: ictToken,
        body: {
            provider: 'Corrected Provider Ltd',
            title: 'Corrected on-site warranty',
            notice_period_days: 45,
            remarks: 'Re-negotiated after the annual supplier review.'
        }
    });
    const corrected =
        correct.body && correct.body.data && correct.body.data.warranty
            ? correct.body.data.warranty
            : null;
    check('PUT /:id corrects the details (200)', correct.status === 200, correct.raw);
    check(
        'the corrected provider is stored',
        !!corrected && corrected.provider === 'Corrected Provider Ltd',
        corrected ? `provider: ${corrected.provider}` : 'no record'
    );
    check(
        'the corrected notice period is stored',
        !!corrected && Number(corrected.notice_period_days) === 45,
        corrected ? `notice: ${corrected.notice_period_days}` : 'no record'
    );
    check(
        'the untouched expiry date survives the partial update',
        !!corrected && isoDay(corrected.expiry_date) === dayOffset(365),
        corrected ? `expiry: ${isoDay(corrected.expiry_date)}` : 'no record'
    );

    // A partial update cannot create an inverted window.
    const invertPartial = await request('PUT', `/api/warranties/${record.id}`, {
        token: ictToken,
        body: { start_date: dayOffset(500) }
    });
    check(
        'a partial update that would invert the window is rejected (400)',
        invertPartial.status === 400,
        invertPartial.raw
    );

    // An empty update is refused.
    const emptyUpdate = await request('PUT', `/api/warranties/${soonRecord.id}`, {
        token: ictToken,
        body: {}
    });
    check('an update with no fields is rejected (400)', emptyUpdate.status === 400, emptyUpdate.raw);

    // PATCH is an alias of PUT.
    const patched = await request('PATCH', `/api/warranties/${soonRecord.id}`, {
        token: ictToken,
        body: { payment_terms: 'Net 60' }
    });
    check(
        'PATCH /:id is accepted as a partial update (200)',
        patched.status === 200 &&
            !!patched.body &&
            !!patched.body.data &&
            patched.body.data.warranty.payment_terms === 'Net 60',
        patched.raw
    );



    /* ---------------------------------------------------------------- */
    section('11. Renewal and cancellation');
    /* ---------------------------------------------------------------- */
    const renewRes = await request('PATCH', `/api/warranties/${record.id}/renew`, {
        token: ictToken,
        body: {
            expiry_date: dayOffset(730),
            contract_value: 700,
            title: 'Renewed: on-site warranty (2 years)',
            remarks: 'Renewed after the supplier performance review.'
        }
    });

    const renewed =
        renewRes.body && renewRes.body.data && renewRes.body.data.warranty
            ? renewRes.body.data.warranty
            : null;
    const superseded =
        renewRes.body && renewRes.body.data && renewRes.body.data.previous
            ? renewRes.body.data.previous
            : null;

    if (renewed) createdWarrantyIds.push(renewed.id);

    check('PATCH /:id/renew extends the cover (201)', renewRes.status === 201, renewRes.raw);
    check('the renewed record is returned', !!renewed, renewRes.raw);
    check(
        'renewal mints a fresh reference',
        !!renewed && renewed.warranty_ref !== record.warranty_ref,
        renewed ? `new ref: ${renewed.warranty_ref}` : 'no record'
    );
    check(
        'the renewal links back to the superseded record',
        !!renewed && renewed.renewed_from === record.id,
        renewed ? `renewed_from: ${renewed.renewed_from}` : 'no record'
    );
    check(
        'the renewal starts the day after the old cover ended',
        !!renewed && isoDay(renewed.start_date) === dayOffset(366),
        renewed ? `start: ${isoDay(renewed.start_date)}, expected: ${dayOffset(366)}` : 'no record'
    );
    check(
        'the renewal carries the new expiry date',
        !!renewed && isoDay(renewed.expiry_date) === dayOffset(730),
        renewed ? `expiry: ${isoDay(renewed.expiry_date)}` : 'no record'
    );
    check(
        'the renewal carries the restated contract value',
        !!renewed && Number(renewed.contract_value) === 700,
        renewed ? `value: ${renewed.contract_value}` : 'no record'
    );
    check(
        'the superseded record is cancelled, not deleted (§10)',
        !!superseded && superseded.status === 'Cancelled',
        superseded ? `status: ${superseded.status}` : 'no record'
    );
    check(
        'the superseded record notes what replaced it',
        !!superseded &&
            typeof superseded.cancellation_reason === 'string' &&
            superseded.cancellation_reason.includes(renewed.warranty_ref),
        superseded ? `reason: ${superseded.cancellation_reason}` : 'no record'
    );
    check(
        'the renewal response reports the previous reference',
        !!renewRes.body &&
            !!renewRes.body.data &&
            renewRes.body.data.previous_ref === record.warranty_ref,
        renewRes.raw
    );

    // Re-newing the already-superseded record must be refused.
    const renewAgain = await request('PATCH', `/api/warranties/${record.id}/renew`, {
        token: ictToken,
        body: { expiry_date: dayOffset(1000) }
    });
    check(
        'a cancelled (superseded) warranty cannot be renewed again (409)',
        renewAgain.status === 409,
        renewAgain.raw
    );

    // A renewal needs a new expiry date.
    const renewNoDate = await request('PATCH', `/api/warranties/${soonRecord.id}/renew`, {
        token: ictToken,
        body: {}
    });
    check(
        'a renewal without an expiry_date is rejected (400)',
        renewNoDate.status === 400,
        renewNoDate.raw
    );

    // A renewal cannot move the expiry to before the start.
    const renewInverted = await request('PATCH', `/api/warranties/${soonRecord.id}/renew`, {
        token: ictToken,
        body: { expiry_date: today() }
    });
    check(
        'a renewal whose new expiry is not after the start is rejected (400)',
        renewInverted.status === 400,
        renewInverted.raw
    );

    // Cancel a record outright.
    const cancelRes = await request('PATCH', `/api/warranties/${soonRecord.id}/cancel`, {
        token: hisoToken,
        body: { reason: 'Asset returned to the supplier under a credit note.' }
    });
    const cancelled =
        cancelRes.body && cancelRes.body.data && cancelRes.body.data.warranty
            ? cancelRes.body.data.warranty
            : null;
    check('PATCH /:id/cancel cancels the record (200)', cancelRes.status === 200, cancelRes.raw);
    check(
        'the cancelled record has the Cancelled status',
        !!cancelled && cancelled.status === 'Cancelled',
        cancelled ? `status: ${cancelled.status}` : 'no record'
    );
    check(
        'cancelling stamps a cancellation date',
        !!cancelled && isoDay(cancelled.cancelled_date) === today(),
        cancelled ? `date: ${isoDay(cancelled.cancelled_date)}` : 'no record'
    );
    check(
        'the cancellation reason is stored',
        !!cancelled &&
            cancelled.cancellation_reason === 'Asset returned to the supplier under a credit note.',
        cancelled ? `reason: ${cancelled.cancellation_reason}` : 'no record'
    );

    const cancelAgain = await request('PATCH', `/api/warranties/${soonRecord.id}/cancel`, {
        token: adminToken,
        body: { reason: 'Second attempt' }
    });
    check('cancelling twice is refused (409)', cancelAgain.status === 409, cancelAgain.raw);

    // Cancelled cover no longer counts as in force.
    const activeAfterCancel = await request('GET', '/api/warranties/contracts', { token: adminToken });
    check(
        'a cancelled record is an update, not a delete, so it can still be read',
        (await request('GET', `/api/warranties/${soonRecord.id}`, { token: adminToken })).status === 200,
        'the cancelled record was not readable'
    );
    check('the contracts view still responds after a cancellation', activeAfterCancel.status === 200, activeAfterCancel.raw);



    /* ---------------------------------------------------------------- */
    section('12. Role-based access control (§9)');
    /* ---------------------------------------------------------------- */
    // A Departmental User is a read-only consumer of the register.
    const deptCreate = await request('POST', '/api/warranties', {
        token: deptToken,
        body: {
            provider: 'Departmental Attempt Ltd',
            start_date: today(),
            expiry_date: dayOffset(100)
        }
    });
    check('a Departmental User cannot record a warranty (403)', deptCreate.status === 403, deptCreate.raw);

    // An Auditor is read-only oversight.
    const auditorCreate = await request('POST', '/api/warranties', {
        token: auditorToken,
        body: {
            provider: 'Auditor Attempt Ltd',
            start_date: today(),
            expiry_date: dayOffset(100)
        }
    });
    check('an Auditor cannot record a warranty (403)', auditorCreate.status === 403, auditorCreate.raw);

    const auditorUpdate = await request('PUT', `/api/warranties/${renewed.id}`, {
        token: auditorToken,
        body: { remarks: 'Auditor should not be able to write.' }
    });
    check('an Auditor cannot correct a warranty (403)', auditorUpdate.status === 403, auditorUpdate.raw);

    const auditorCancel = await request('PATCH', `/api/warranties/${renewed.id}/cancel`, {
        token: auditorToken,
        body: { reason: 'Auditor should not be able to cancel.' }
    });
    check('an Auditor cannot cancel a warranty (403)', auditorCancel.status === 403, auditorCancel.raw);

    // Cancelling is reserved to the Administrator and HISO.
    const ictCancel = await request('PATCH', `/api/warranties/${renewed.id}/cancel`, {
        token: ictToken,
        body: { reason: 'ICT Officer attempt' }
    });
    check('an ICT Officer cannot cancel a warranty (403)', ictCancel.status === 403, ictCancel.raw);

    // ...but an ICT Officer may record and correct cover.
    const ictUpdate = await request('PATCH', `/api/warranties/${renewed.id}`, {
        token: ictToken,
        body: { remarks: 'Confirmed against the signed contract schedule.' }
    });
    check('an ICT Officer can correct a warranty (200)', ictUpdate.status === 200, ictUpdate.raw);

    // The read surface is open to every authenticated role.
    const deptRead = await request('GET', '/api/warranties?limit=5', { token: deptToken });
    check('a Departmental User can read their warranty view (200)', deptRead.status === 200, deptRead.raw);

    const auditorRead = await request('GET', '/api/warranties?limit=5', { token: auditorToken });
    check('an Auditor can read the warranty register (200)', auditorRead.status === 200, auditorRead.raw);

    const deptExpiring = await request('GET', '/api/warranties/expiring', { token: deptToken });
    check('a Departmental User sees scoped expiry alerts (200)', deptExpiring.status === 200, deptExpiring.raw);


    /* ---------------------------------------------------------------- */
    section('13. Audit trail (§13)');
    /* ---------------------------------------------------------------- */
    const auditRes = await request(
        'GET',
        '/api/auth/audit-logs?table_name=warranties&limit=100',
        { token: adminToken }
    );
    const auditRows =
        auditRes.body && auditRes.body.data && Array.isArray(auditRes.body.data.logs)
            ? auditRes.body.data.logs
            : [];

    check(
        'the audit trail records warranty activity',
        auditRes.status === 200 && auditRows.length > 0,
        auditRes.raw
    );
    check(
        'the audit trail captures the CREATE action',
        auditRows.some((row) => row.action === 'CREATE'),
        `actions: ${[...new Set(auditRows.map((r) => r.action))].join(', ') || 'none'}`
    );
    check(
        'the audit trail captures the UPDATE action',
        auditRows.some((row) => row.action === 'UPDATE'),
        `actions: ${[...new Set(auditRows.map((r) => r.action))].join(', ') || 'none'}`
    );
    check(
        'the audit trail captures the RENEW action',
        auditRows.some((row) => row.action === 'RENEW'),
        `actions: ${[...new Set(auditRows.map((r) => r.action))].join(', ') || 'none'}`
    );
    check(
        'the audit trail captures the CANCEL action',
        auditRows.some((row) => row.action === 'CANCEL'),
        `actions: ${[...new Set(auditRows.map((r) => r.action))].join(', ') || 'none'}`
    );
    check(
        'the audit entries carry the acting user',
        auditRows.every((row) => row.user_id !== null && row.user_id !== undefined),
        `user ids: ${[...new Set(auditRows.map((r) => r.user_id))].join(', ')}`
    );



    /* ---------------------------------------------------------------- */
    section('14. Model-level behaviour');
    /* ---------------------------------------------------------------- */
    const modelById = await warrantyModel.findById(renewed.id);
    check('warrantyModel.findById returns the row', !!modelById && modelById.id === renewed.id);

    const modelByRef = await warrantyModel.findByRef(renewed.warranty_ref);
    check(
        'warrantyModel.findByRef resolves the WAR- reference',
        !!modelByRef && modelByRef.id === renewed.id
    );

    const modelByAsset = await warrantyModel.findByAssetId(asset.id);
    check(
        'warrantyModel.findByAssetId returns the asset coverage',
        Array.isArray(modelByAsset) && modelByAsset.length > 0
    );

    const assetCount = await warrantyModel.countByAssetId(asset.id);
    check(
        'warrantyModel.countByAssetId counts the asset records',
        typeof assetCount === 'number' && assetCount >= 2,
        `count: ${assetCount}`
    );

    const pkByTag = await warrantyModel.resolveAssetPk(asset.asset_tag);
    const pkByCode = await warrantyModel.resolveAssetPk(asset.asset_id);
    const pkById = await warrantyModel.resolveAssetPk(asset.id);
    check(
        'warrantyModel.resolveAssetPk resolves tag, code and id',
        pkByTag === asset.id && pkByCode === asset.id && pkById === asset.id,
        `tag: ${pkByTag}, code: ${pkByCode}, id: ${pkById}`
    );

    const modelExpiring = await warrantyModel.findExpiring(90);
    check(
        'warrantyModel.findExpiring returns only in-window cover',
        Array.isArray(modelExpiring) &&
            modelExpiring.every((row) => isoDay(row.expiry_date) >= today()),
        `rows: ${modelExpiring.length}`
    );

    const modelDerivedExpiring = await warrantyModel.findExpiringOnAssets(90);
    check(
        'warrantyModel.findExpiringOnAssets returns register-derived cover',
        Array.isArray(modelDerivedExpiring) &&
            modelDerivedExpiring.every((row) => row.source === 'asset_register'),
        `rows: ${modelDerivedExpiring.length}`
    );

    const modelActive = await warrantyModel.findActive();
    check(
        'warrantyModel.findActive excludes expired and cancelled cover',
        Array.isArray(modelActive) &&
            modelActive.every(
                (row) => row.status !== 'Cancelled' && isoDay(row.expiry_date) >= today()
            ),
        `rows: ${modelActive.length}`
    );

    const modelExpired = await warrantyModel.findExpired();
    check(
        'warrantyModel.findExpired returns only lapsed cover',
        Array.isArray(modelExpired) && modelExpired.every((row) => isoDay(row.expiry_date) < today()),
        `rows: ${modelExpired.length}`
    );

    const refTaken = await warrantyModel.warrantyRefExists(renewed.warranty_ref);
    const refFree = await warrantyModel.warrantyRefExists('WAR-999999');
    check('warrantyModel.warrantyRefExists confirms a known reference', refTaken === true);
    check('warrantyModel.warrantyRefExists rejects an unused reference', refFree === false);

    const filterList = await warrantyModel.findAll({ status: 'Open', limit: 100, offset: 0 });
    check(
        'warrantyModel.findAll returns rows and a total',
        !!filterList &&
            Array.isArray(filterList.rows) &&
            typeof filterList.total === 'number' &&
            filterList.rows.every((row) => row.status !== 'Cancelled'),
        `total: ${filterList ? filterList.total : 'n/a'}`
    );

    const contractList = await warrantyModel.findAll({
        includeDerived: false,
        warrantyType: 'Maintenance Contract',
        limit: 10
    });
    check(
        'warrantyModel.findAll can filter to contracts only',
        !!contractList &&
            contractList.rows.every((row) => row.warranty_type === 'Maintenance Contract'),
        `rows: ${contractList ? contractList.rows.length : 'n/a'}`
    );



    /* ---------------------------------------------------------------- */
    section('15. Aggregates after the run');
    /* ---------------------------------------------------------------- */
    const finalStats = await request('GET', '/api/warranties/stats', { token: adminToken });
    check('final GET /api/warranties/stats returns 200', finalStats.status === 200, finalStats.raw);
    check(
        'the stats total covers every warranty created',
        !!finalStats.body &&
            !!finalStats.body.data &&
            finalStats.body.data.total >= createdWarrantyIds.length,
        finalStats.raw
    );
    check(
        'the stats report a non-negative total contract value',
        !!finalStats.body &&
            !!finalStats.body.data &&
            typeof finalStats.body.data.totalValue === 'number' &&
            finalStats.body.data.totalValue >= 700,
        finalStats.raw
    );
    check(
        'the stats expose the warranties grouped by provider',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Array.isArray(finalStats.body.data.byProvider),
        finalStats.raw
    );
    check(
        'the stats expose the warranties grouped by type',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Array.isArray(finalStats.body.data.byType) &&
            finalStats.body.data.byType.some((row) => row.warranty_type === 'Maintenance Contract'),
        finalStats.raw
    );
    check(
        'the stats count the cancelled records rather than dropping them',
        !!finalStats.body && !!finalStats.body.data && finalStats.body.data.cancelled >= 2,
        finalStats.raw
    );
    check(
        'the stats report cover whose notice period is running out',
        !!finalStats.body &&
            !!finalStats.body.data &&
            typeof finalStats.body.data.noticeDue === 'number',
        finalStats.raw
    );
}



/* -------------------------------------------------------------------------
 * Bootstrap: start server, run suite, always clean up, exit explicitly.
 * ---------------------------------------------------------------------- */
server = app.listen(PORT, async () => {
    console.log('======================================================');
    console.log('  NBSZ Asset Management - Warranty Test Suite');
    console.log('======================================================');
    console.log(`Target: ${BASE}`);
    console.log(`Time:   ${new Date().toISOString()}`);

    let failure = null;
    try {
        await connectDb();
        // The warranty module owns its own DDL so the suite can run on a
        // database that has not had scripts/initDb.js re-applied.
        await warrantyModel.ensureTable();
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
