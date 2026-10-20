'use strict';

/**
 * scripts/testAssets.js
 * ---------------------------------------------------------------------------
 * Standalone smoke/regression test for the Asset Register slice.
 *
 * Boots the real Express app (which also verifies the MySQL connection) on an
 * isolated port, fires real HTTP requests at it, and asserts on the responses.
 * No test-runner dependency is required - run it with:
 *
 *     node scripts/testAssets.js
 *
 * The suite is self-cleaning: assets and categories it creates are removed
 * again at the end (a hard DELETE, because the API only soft-deletes).
 *
 * Exit code 0 = all checks passed, 1 = at least one check failed.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const app = require('../server');

// Dedicated port so this can run even while the dev server is up.
const PORT = process.env.ASSET_TEST_PORT || 3998;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let server = null;

// Ids created during the run, cleaned up at the end.
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
 * Removes everything this suite created. Child rows (audit_logs) must go
 * before the parent users/assets because of the foreign keys.
 */
async function cleanup() {
    if (!db) return;

    try {
        if (createdAssetIds.length) {
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
    const tagSeed = `TEST-${stamp}`;

    let adminToken = null;
    let ictToken = null;
    let deptToken = null;
    let auditorToken = null;

    /* ---------------------------------------------------------------- */
    section('1. Infrastructure');
    /* ---------------------------------------------------------------- */
    const health = await request('GET', '/api/health');
    check('GET /api/health returns 200', health.status === 200, `got ${health.status}`);

    const unauth = await request('GET', '/api/assets');
    check(
        'GET /api/assets without a token returns 401',
        unauth.status === 401,
        `${unauth.status} ${unauth.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('2. Test accounts and authentication');
    /* ---------------------------------------------------------------- */
    const adminUser = {
        username: 'asset_admin_test',
        email: 'asset.admin.test@nbsz.co.zw',
        password: 'AssetAdmin@123',
        fullName: 'Asset Test Administrator',
        role: 'System Administrator'
    };
    const ictUser = {
        username: 'asset_ict_test',
        email: 'asset.ict.test@nbsz.co.zw',
        password: 'AssetIct@123',
        fullName: 'Asset Test ICT Officer',
        role: 'ICT Officer'
    };
    const deptUser = {
        username: 'asset_dept_test',
        email: 'asset.dept.test@nbsz.co.zw',
        password: 'AssetDept@123',
        fullName: 'Asset Test Departmental User',
        role: 'Departmental User'
    };
    const auditorUser = {
        username: 'asset_auditor_test',
        email: 'asset.auditor.test@nbsz.co.zw',
        password: 'AssetAudit@123',
        fullName: 'Asset Test Auditor',
        role: 'Auditor'
    };

    const ids = [];
    for (const user of [adminUser, ictUser, deptUser, auditorUser]) {
        ids.push(await ensureUser(user));
    }
    const [adminId, ictId, deptId, auditorId] = ids;
    check('four role test accounts are available', ids.every(Boolean), `ids: ${ids.join(', ')}`);

    const login = (user) =>
        request('POST', '/api/auth/login', {
            body: { username: user.username, password: user.password }
        });

    const adminLogin = await login(adminUser);
    adminToken = adminLogin.body && adminLogin.body.data ? adminLogin.body.data.token : null;
    check('administrator can log in', adminLogin.status === 200 && !!adminToken, adminLogin.raw);

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


    /* ---------------------------------------------------------------- */
    section('3. Asset categories');
    /* ---------------------------------------------------------------- */
    const categoryName = `Test Category ${tagSeed}`;

    const createCategory = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: categoryName, description: 'Created by the asset test suite.' }
    });
    check(
        'POST /api/assets/categories creates a category (201)',
        createCategory.status === 201,
        `${createCategory.status} ${createCategory.raw}`
    );

    const categoryId =
        createCategory.body && createCategory.body.data && createCategory.body.data.category
            ? createCategory.body.data.category.id
            : null;
    if (categoryId) createdCategoryIds.push(categoryId);
    check('created category returns its id', !!categoryId, createCategory.raw);

    const dupCategory = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: categoryName }
    });
    check(
        'duplicate category name is rejected with 409',
        dupCategory.status === 409,
        `${dupCategory.status} ${dupCategory.raw}`
    );

    const invalidCategory = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: '' }
    });
    check(
        'category without a name returns 400 with field errors',
        invalidCategory.status === 400 &&
            Array.isArray(invalidCategory.body && invalidCategory.body.errors),
        `${invalidCategory.status} ${invalidCategory.raw}`
    );

    const listCategories = await request('GET', '/api/assets/categories', { token: ictToken });
    check(
        'GET /api/assets/categories returns 200 for an ICT Officer',
        listCategories.status === 200,
        `${listCategories.status} ${listCategories.raw}`
    );
    check(
        'category list includes the new category with an asset_count',
        !!(
            listCategories.body &&
            listCategories.body.data &&
            listCategories.body.data.categories.some(
                (c) => Number(c.id) === Number(categoryId) && c.asset_count !== undefined
            )
        ),
        listCategories.raw
    );

    const getCategory = await request('GET', `/api/assets/categories/${categoryId}`, {
        token: deptToken
    });
    check(
        'GET /api/assets/categories/:id returns 200 for a Departmental User',
        getCategory.status === 200,
        `${getCategory.status} ${getCategory.raw}`
    );

    const missingCategory = await request('GET', '/api/assets/categories/99999999', {
        token: adminToken
    });
    check(
        'unknown category id returns 404',
        missingCategory.status === 404,
        `${missingCategory.status} ${missingCategory.raw}`
    );

    const categoryAsIct = await request('POST', '/api/assets/categories', {
        token: ictToken,
        body: { name: `Should Not Exist ${tagSeed}` }
    });
    check(
        'ICT Officer cannot create a category (403)',
        categoryAsIct.status === 403,
        `${categoryAsIct.status} ${categoryAsIct.raw}`
    );

    const categoryAsAnon = await request('POST', '/api/assets/categories', {
        body: { name: `Anon ${tagSeed}` }
    });
    check(
        'anonymous category creation returns 401',
        categoryAsAnon.status === 401,
        `${categoryAsAnon.status} ${categoryAsAnon.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('4. Registering assets');
    /* ---------------------------------------------------------------- */
    const createAsset = await request('POST', '/api/assets', {
        token: ictToken,
        body: {
            asset_tag: `${tagSeed}-LAP-001`,
            serial_number: `SN-${tagSeed}-001`,
            category_id: categoryId,
            manufacturer: 'Dell',
            model: 'Latitude 5540',
            purchase_date: '2024-03-15',
            purchase_cost: 1250.5,
            supplier: 'Test Supplier (Pvt) Ltd',
            po_invoice_ref: `PO-${tagSeed}`,
            warranty_provider: 'Dell Zimbabwe',
            warranty_start: '2024-03-15',
            warranty_end: '2027-03-14',
            warranty_ref: `WAR-${tagSeed}`,
            location: 'Head Office',
            department: 'ICT',
            assigned_user_id: deptId,
            responsible_officer: 'Test Custodian',
            status: 'In Use',
            condition_status: 'Good'
        }
    });
    check(
        'POST /api/assets registers an asset (201)',
        createAsset.status === 201,
        `${createAsset.status} ${createAsset.raw}`
    );

    const asset = createAsset.body && createAsset.body.data ? createAsset.body.data.asset : null;
    if (asset) createdAssetIds.push(asset.id);

    check('created asset has a database id', !!(asset && asset.id), createAsset.raw);
    check(
        'asset_id is auto-generated with the category prefix',
        !!(asset && /^NBSZ-DKT-|^NBSZ-AST-/.test(asset.asset_id)),
        asset ? asset.asset_id : 'no asset'
    );
    check(
        'qr_code_value is generated automatically',
        !!(asset && asset.qr_code_value && asset.qr_code_value.startsWith('NBSZ|ASSET|')),
        asset ? asset.qr_code_value : 'no asset'
    );
    check(
        'QR value encodes only the public identifiers',
        !!(asset && asset.qr_code_value === `NBSZ|ASSET|${asset.asset_id}|${asset.asset_tag}`),
        asset ? asset.qr_code_value : 'no asset'
    );
    check(
        'joined category name is returned with the asset',
        !!(asset && asset.category_name === categoryName),
        asset ? String(asset.category_name) : 'no asset'
    );
    check(
        'joined custodian name is returned with the asset',
        !!(asset && asset.assigned_user_id === deptId && asset.assigned_full_name),
        asset ? String(asset.assigned_full_name) : 'no asset'
    );
    check(
        'purchase_cost is preserved as a decimal',
        !!(asset && Number(asset.purchase_cost) === 1250.5),
        asset ? String(asset.purchase_cost) : 'no asset'
    );

    // Asset id sequence increments per prefix.
    const createAsset2 = await request('POST', '/api/assets', {
        token: adminToken,
        body: {
            asset_tag: `${tagSeed}-LAP-002`,
            category_id: categoryId,
            manufacturer: 'HP',
            model: 'EliteBook 840',
            location: 'Bulawayo Branch'
        }
    });
    const asset2 = createAsset2.body && createAsset2.body.data ? createAsset2.body.data.asset : null;
    if (asset2) createdAssetIds.push(asset2.id);
    check(
        'second asset gets a different sequential asset_id',
        !!(asset && asset2 && asset.asset_id !== asset2.asset_id),
        `${asset ? asset.asset_id : '?'} vs ${asset2 ? asset2.asset_id : '?'}`
    );
    check(
        'status defaults to "In Stock" and condition to "Good"',
        !!(asset2 && asset2.status === 'In Stock' && asset2.condition_status === 'Good'),
        asset2 ? `${asset2.status} / ${asset2.condition_status}` : 'no asset'
    );



    /* ------------------------- Validation & conflicts ---------------------- */

    const noTag = await request('POST', '/api/assets', {
        token: adminToken,
        body: { manufacturer: 'No Tag Ltd' }
    });
    check(
        'asset without an asset_tag returns 400 with field errors',
        noTag.status === 400 && Array.isArray(noTag.body && noTag.body.errors),
        `${noTag.status} ${noTag.raw}`
    );

    const dupTag = await request('POST', '/api/assets', {
        token: adminToken,
        body: { asset_tag: `${tagSeed}-LAP-001` }
    });
    check(
        'duplicate asset_tag is rejected with 409',
        dupTag.status === 409,
        `${dupTag.status} ${dupTag.raw}`
    );

    const dupSerial = await request('POST', '/api/assets', {
        token: adminToken,
        body: { asset_tag: `${tagSeed}-LAP-003`, serial_number: `SN-${tagSeed}-001` }
    });
    check(
        'duplicate serial_number is rejected with 409',
        dupSerial.status === 409,
        `${dupSerial.status} ${dupSerial.raw}`
    );

    const badStatus = await request('POST', '/api/assets', {
        token: adminToken,
        body: { asset_tag: `${tagSeed}-BAD-001`, status: 'Exploded' }
    });
    check(
        'invalid status value returns 400',
        badStatus.status === 400,
        `${badStatus.status} ${badStatus.raw}`
    );

    const badDate = await request('POST', '/api/assets', {
        token: adminToken,
        body: { asset_tag: `${tagSeed}-BAD-002`, purchase_date: '15/03/2024' }
    });
    check(
        'invalid date format returns 400',
        badDate.status === 400,
        `${badDate.status} ${badDate.raw}`
    );

    const badWarranty = await request('POST', '/api/assets', {
        token: adminToken,
        body: {
            asset_tag: `${tagSeed}-BAD-003`,
            warranty_start: '2025-01-01',
            warranty_end: '2024-01-01'
        }
    });
    check(
        'warranty_end before warranty_start returns 400',
        badWarranty.status === 400,
        `${badWarranty.status} ${badWarranty.raw}`
    );

    const badCategory = await request('POST', '/api/assets', {
        token: adminToken,
        body: { asset_tag: `${tagSeed}-BAD-004`, category_id: 99999999 }
    });
    check(
        'unknown category_id returns 400',
        badCategory.status === 400,
        `${badCategory.status} ${badCategory.raw}`
    );

    const deptCreate = await request('POST', '/api/assets', {
        token: deptToken,
        body: { asset_tag: `${tagSeed}-NOPE-001` }
    });
    check(
        'Departmental User cannot register an asset (403)',
        deptCreate.status === 403,
        `${deptCreate.status} ${deptCreate.raw}`
    );

    const auditorCreate = await request('POST', '/api/assets', {
        token: auditorToken,
        body: { asset_tag: `${tagSeed}-NOPE-002` }
    });
    check(
        'Auditor cannot register an asset (403)',
        auditorCreate.status === 403,
        `${auditorCreate.status} ${auditorCreate.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('5. Reading the register');
    /* ---------------------------------------------------------------- */
    const listAll = await request('GET', '/api/assets?limit=100', { token: deptToken });
    check(
        'GET /api/assets returns 200 for a Departmental User',
        listAll.status === 200,
        `${listAll.status} ${listAll.raw}`
    );
    check(
        'list response carries assets + pagination envelope',
        !!(
            listAll.body &&
            listAll.body.data &&
            Array.isArray(listAll.body.data.assets) &&
            listAll.body.data.pagination &&
            typeof listAll.body.data.pagination.total === 'number'
        ),
        listAll.raw
    );
    check(
        'register list contains the asset just created',
        !!(
            listAll.body &&
            listAll.body.data &&
            listAll.body.data.assets.some((a) => Number(a.id) === Number(asset.id))
        ),
        'created asset not present in the list'
    );

    const searchByTag = await request(
        'GET',
        `/api/assets?search=${encodeURIComponent(`${tagSeed}-LAP-001`)}`,
        { token: adminToken }
    );
    check(
        'search by asset_tag narrows the result set',
        !!(
            searchByTag.body &&
            searchByTag.body.data &&
            searchByTag.body.data.assets.length === 1 &&
            searchByTag.body.data.assets[0].asset_tag === `${tagSeed}-LAP-001`
        ),
        searchByTag.raw
    );

    const filterByStatus = await request(
        'GET',
        `/api/assets?status=${encodeURIComponent('In Stock')}&limit=100`,
        { token: adminToken }
    );
    check(
        'filter by status returns only matching assets',
        !!(
            filterByStatus.body &&
            filterByStatus.body.data &&
            filterByStatus.body.data.assets.every((a) => a.status === 'In Stock')
        ),
        filterByStatus.raw
    );

    const filterByCategory = await request(
        'GET',
        `/api/assets?category_id=${categoryId}&limit=100`,
        { token: adminToken }
    );
    check(
        'filter by category_id returns only that category',
        !!(
            filterByCategory.body &&
            filterByCategory.body.data &&
            filterByCategory.body.data.assets.length >= 2 &&
            filterByCategory.body.data.assets.every(
                (a) => Number(a.category_id) === Number(categoryId)
            )
        ),
        filterByCategory.raw
    );

    const filterByLocation = await request(
        'GET',
        '/api/assets?location=Bulawayo&limit=100',
        { token: adminToken }
    );
    check(
        'location filter is applied',
        !!(
            filterByLocation.body &&
            filterByLocation.body.data &&
            filterByLocation.body.data.assets.every((a) => /Bulawayo/i.test(a.location || ''))
        ),
        filterByLocation.raw
    );

    const badFilter = await request('GET', '/api/assets?status=Nonsense', { token: adminToken });
    check(
        'invalid status filter returns 400',
        badFilter.status === 400,
        `${badFilter.status} ${badFilter.raw}`
    );

    const getById = await request('GET', `/api/assets/${asset.id}`, { token: deptToken });
    check(
        'GET /api/assets/:id returns the asset',
        getById.status === 200 &&
            !!(getById.body && getById.body.data && getById.body.data.asset.id === asset.id),
        `${getById.status} ${getById.raw}`
    );

    const getByCode = await request('GET', `/api/assets/${asset.asset_id}`, { token: adminToken });
    check(
        'GET /api/assets/:id also resolves a generated asset_id',
        getByCode.status === 200 &&
            !!(getByCode.body && getByCode.body.data && getByCode.body.data.asset.id === asset.id),
        `${getByCode.status} ${getByCode.raw}`
    );

    const getByTag = await request('GET', `/api/assets/${asset.asset_tag}`, {
        token: auditorToken
    });
    check(
        'GET /api/assets/:id also resolves a physical asset_tag',
        getByTag.status === 200 &&
            !!(getByTag.body && getByTag.body.data && getByTag.body.data.asset.id === asset.id),
        `${getByTag.status} ${getByTag.raw}`
    );

    const missingAsset = await request('GET', '/api/assets/99999999', { token: adminToken });
    check(
        'unknown asset id returns 404',
        missingAsset.status === 404,
        `${missingAsset.status} ${missingAsset.raw}`
    );

    const scan = await request('GET', `/api/assets/scan/${encodeURIComponent(asset.qr_code_value)}`, {
        token: deptToken
    });
    check(
        'scanned QR value resolves to the correct asset',
        scan.status === 200 && !!(scan.body && scan.body.data && scan.body.data.asset.id === asset.id),
        `${scan.status} ${scan.raw}`
    );

    const scanUnknown = await request(
        'GET',
        `/api/assets/scan/${encodeURIComponent('NBSZ|ASSET|NOPE|NOPE')}`,
        { token: deptToken }
    );
    check(
        'unknown QR value returns 404',
        scanUnknown.status === 404,
        `${scanUnknown.status} ${scanUnknown.raw}`
    );

    const stats = await request('GET', '/api/assets/stats', { token: auditorToken });
    check(
        'GET /api/assets/stats returns aggregate counts',
        !!(
            stats.status === 200 &&
            stats.body &&
            stats.body.data &&
            typeof stats.body.data.total === 'number' &&
            typeof stats.body.data.inUse === 'number' &&
            typeof stats.body.data.inStock === 'number' &&
            typeof stats.body.data.underRepair === 'number' &&
            typeof stats.body.data.missing === 'number' &&
            typeof stats.body.data.retired === 'number' &&
            typeof stats.body.data.disposed === 'number' &&
            Array.isArray(stats.body.data.byStatus) &&
            Array.isArray(stats.body.data.byCategory)
        ),
        `${stats.status} ${stats.raw}`
    );
    const statusCount = (status) => {
        const row = stats.body.data.byStatus.find((entry) => entry.status === status);
        return row ? Number(row.total) : 0;
    };
    check(
        'dashboard status totals match the asset register status breakdown',
        stats.body.data.total === stats.body.data.byStatus.reduce(
            (total, row) => total + Number(row.total),
            0
        ) &&
            stats.body.data.inUse === statusCount('In Use') &&
            stats.body.data.inStock === statusCount('In Stock') &&
            stats.body.data.underRepair === statusCount('Under Repair') &&
            stats.body.data.missing === statusCount('Missing') &&
            stats.body.data.retired === statusCount('Retired') &&
            stats.body.data.disposed === statusCount('Disposed'),
        JSON.stringify(stats.body.data)
    );

    const meta = await request('GET', '/api/assets/meta', { token: ictToken });
    check(
        'GET /api/assets/meta exposes statuses, conditions and categories',
        !!(
            meta.status === 200 &&
            meta.body &&
            meta.body.data &&
            Array.isArray(meta.body.data.statuses) &&
            meta.body.data.statuses.includes('In Stock') &&
            Array.isArray(meta.body.data.conditions) &&
            Array.isArray(meta.body.data.categories)
        ),
        `${meta.status} ${meta.raw}`
    );

    const metaAsDept = await request('GET', '/api/assets/meta', { token: deptToken });

    /* ---------------------------------------------------------------- */
    section('6. Updating assets');
    /* ---------------------------------------------------------------- */
    const patchAsset = await request('PATCH', `/api/assets/${asset.id}`, {
        token: ictToken,
        body: {
            status: 'Under Repair',
            condition_status: 'Fair',
            location: 'Harare Workshop',
            assigned_user_id: null
        }
    });
    check(
        'PATCH /api/assets/:id returns 200',
        patchAsset.status === 200,
        `${patchAsset.status} ${patchAsset.raw}`
    );

    const patched = patchAsset.body && patchAsset.body.data ? patchAsset.body.data.asset : null;
    check(
        'patched fields persist',
        !!(patched && patched.status === 'Under Repair' && patched.location === 'Harare Workshop'),
        patchAsset.raw
    );
    check(
        'partial update reports the changed fields',
        !!(
            patchAsset.body &&
            patchAsset.body.data &&
            Array.isArray(patchAsset.body.data.changed_fields) &&
            patchAsset.body.data.changed_fields.includes('status')
        ),
        patchAsset.raw
    );
    check(
        'clearing assigned_user_id nulls the custodian',
        !!(patched && patched.assigned_user_id === null),
        patched ? String(patched.assigned_user_id) : 'no asset'
    );
    check(
        'asset_id is unchanged by the update',
        !!(patched && patched.asset_id === asset.asset_id),
        patched ? patched.asset_id : 'no asset'
    );

    const putAsset = await request('PUT', `/api/assets/${asset.id}`, {
        token: adminToken,
        body: {
            asset_tag: asset.asset_tag,
            manufacturer: 'Dell',
            model: 'Latitude 5540 (Updated)',
            department: 'Information Technology'
        }
    });
    const putResult = putAsset.body && putAsset.body.data ? putAsset.body.data.asset : null;
    check(
        'PUT /api/assets/:id applies a full update',
        putAsset.status === 200 &&
            !!(putResult && putResult.model === 'Latitude 5540 (Updated)'),
        `${putAsset.status} ${putAsset.raw}`
    );

    const patchNoFields = await request('PATCH', `/api/assets/${asset.id}`, {
        token: adminToken,
        body: {}
    });
    check(
        'PATCH with no updatable fields returns 400',
        patchNoFields.status === 400,
        `${patchNoFields.status} ${patchNoFields.raw}`
    );

    const patchImmutableId = await request('PATCH', `/api/assets/${asset.id}`, {
        token: adminToken,
        body: { asset_id: 'NBSZ-HACK-000001' }
    });
    check(
        'attempting to change asset_id returns 400',
        patchImmutableId.status === 400,
        `${patchImmutableId.status} ${patchImmutableId.raw}`
    );

    const patchConflict = await request('PATCH', `/api/assets/${asset.id}`, {
        token: adminToken,
        body: { asset_tag: `${tagSeed}-LAP-002` }
    });
    check(
        'patching to an existing asset_tag returns 409',
        patchConflict.status === 409,
        `${patchConflict.status} ${patchConflict.raw}`
    );

    const patchMissing = await request('PATCH', '/api/assets/99999999', {
        token: adminToken,
        body: { status: 'In Use' }
    });
    check(
        'patching an unknown asset returns 404',
        patchMissing.status === 404,
        `${patchMissing.status} ${patchMissing.raw}`
    );

    const patchAsDept = await request('PATCH', `/api/assets/${asset.id}`, {
        token: deptToken,
        body: { status: 'In Use' }
    });
    check(
        'Departmental User cannot update an asset (403)',
        patchAsDept.status === 403,
        `${patchAsDept.status} ${patchAsDept.raw}`
    );

    const directDispose = await request('PATCH', `/api/assets/${asset.id}`, {
        token: adminToken,
        body: { status: 'Disposed' }
    });
    check(
        'generic asset update cannot bypass disposal approval (409)',
        directDispose.status === 409,
        `${directDispose.status} ${directDispose.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('7. QR code generation');
    /* ---------------------------------------------------------------- */
    const qrRegen = await request('POST', `/api/assets/${asset.id}/qr`, { token: ictToken });
    const qrResult = qrRegen.body && qrRegen.body.data ? qrRegen.body.data : null;
    check(
        'POST /api/assets/:id/qr regenerates a QR value',
        qrRegen.status === 200 &&
            !!(qrResult && qrResult.qr_code_value && qrResult.qr_code_value.startsWith('NBSZ|ASSET|')),
        `${qrRegen.status} ${qrRegen.raw}`
    );
    check(
        'regenerated QR value still encodes the same asset',
        !!(qrResult && qrResult.qr_code_value.includes(asset.asset_id)),
        qrResult ? qrResult.qr_code_value : 'no value'
    );

    const qrCustom = await request('POST', `/api/assets/${asset.id}/qr`, {
        token: adminToken,
        body: { qr_code_value: `CUSTOM-QR-${tagSeed}` }
    });
    check(
        'a specific QR value can be supplied',
        qrCustom.status === 200 &&
            !!(
                qrCustom.body &&
                qrCustom.body.data &&
                qrCustom.body.data.qr_code_value === `CUSTOM-QR-${tagSeed}`
            ),
        `${qrCustom.status} ${qrCustom.raw}`
    );

    // A value already owned by a *different* asset must be rejected. `asset2`
    // still holds the QR value it was created with.
    const qrConflict = await request('POST', `/api/assets/${asset.id}/qr`, {
        token: adminToken,
        body: { qr_code_value: asset2.qr_code_value }
    });
    check(
        'QR value already used by another asset is rejected',
        qrConflict.status === 409,
        `${qrConflict.status} ${qrConflict.raw}`
    );

    const qrAsDept = await request('POST', `/api/assets/${asset.id}/qr`, { token: deptToken });
    check(
        'Departmental User cannot regenerate a QR value (403)',
        qrAsDept.status === 403,
        `${qrAsDept.status} ${qrAsDept.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('8. History and audit trail');
    /* ---------------------------------------------------------------- */
    const history = await request('GET', `/api/assets/${asset.id}/history`, { token: auditorToken });
    check(
        'GET /api/assets/:id/history returns the audit timeline',
        !!(
            history.status === 200 &&
            history.body &&
            history.body.data &&
            Array.isArray(history.body.data.history)
        ),
        `${history.status} ${history.raw}`
    );
    check(
        'history records the CREATE and UPDATE entries',
        !!(
            history.body &&
            history.body.data &&
            history.body.data.history.some((h) => h.action === 'CREATE') &&
            history.body.data.history.some((h) => h.action === 'UPDATE')
        ),
        history.raw
    );
    check(
        'history entries carry old/new JSON snapshots',
        !!(
            history.body &&
            history.body.data &&
            history.body.data.history.some((h) => h.new_values && h.new_values.asset_tag)
        ),
        history.raw
    );

    const historyByDept = await request('GET', `/api/assets/${asset.id}/history`, {
        token: deptToken
    });
    check(
        'Departmental User cannot read the audit history (403)',
        historyByDept.status === 403,
        `${historyByDept.status} ${historyByDept.raw}`
    );

    const auditLogs = await request('GET', '/api/auth/audit-logs?table_name=assets&limit=100', {
        token: adminToken
    });
    check(
        'asset changes appear in the global audit trail',
        !!(
            auditLogs.status === 200 &&
            auditLogs.body &&
            auditLogs.body.data &&
            auditLogs.body.data.logs.some((l) => Number(l.record_id) === Number(asset.id))
        ),
        `${auditLogs.status} ${auditLogs.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('9. Disposal (soft delete)');
    /* ---------------------------------------------------------------- */
    const disposeAsIct = await request('DELETE', `/api/assets/${asset2.id}`, { token: ictToken });
    check(
        'ICT Officer cannot dispose an asset (403)',
        disposeAsIct.status === 403,
        `${disposeAsIct.status} ${disposeAsIct.raw}`
    );

    const dispose = await request('DELETE', `/api/assets/${asset2.id}`, {
        token: adminToken,
        body: { condition_status: 'Obsolete' }
    });
    check(
        'direct asset deletion cannot bypass disposal approval (409)',
        dispose.status === 409,
        `${dispose.status} ${dispose.raw}`
    );

    const stillThere = await request('GET', `/api/assets/${asset2.id}`, { token: adminToken });
    check(
        'asset remains unchanged after a blocked direct deletion',
        stillThere.status === 200 &&
            stillThere.body &&
            stillThere.body.data &&
            stillThere.body.data.asset.status !== 'Disposed',
        `${stillThere.status} ${stillThere.raw}`
    );

    const defaultList = await request('GET', '/api/assets?limit=100', { token: adminToken });
    check(
        'asset remains in the default register until approved disposal completes',
        !!(
            defaultList.body &&
            defaultList.body.data &&
            defaultList.body.data.assets.some((a) => Number(a.id) === Number(asset2.id))
        ),
        defaultList.raw
    );

    const includeDisposed = await request('GET', '/api/assets?limit=100&include_disposed=true', {
        token: adminToken
    });
    check(
        'include_disposed=true continues to include the active asset',
        !!(
            includeDisposed.body &&
            includeDisposed.body.data &&
            includeDisposed.body.data.assets.some((a) => Number(a.id) === Number(asset2.id))
        ),
        includeDisposed.raw
    );

    const doubleDispose = await request('DELETE', `/api/assets/${asset2.id}`, { token: adminToken });
    check(
        'disposing an already-disposed asset returns 409',
        doubleDispose.status === 409,
        `${doubleDispose.status} ${doubleDispose.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('10. Category protection and maintenance');
    /* ---------------------------------------------------------------- */
    const deleteUsedCategory = await request('DELETE', `/api/assets/categories/${categoryId}`, {
        token: adminToken
    });
    check(
        'a category in use cannot be deleted (409)',
        deleteUsedCategory.status === 409,
        `${deleteUsedCategory.status} ${deleteUsedCategory.raw}`
    );

    const renameCategory = await request('PUT', `/api/assets/categories/${categoryId}`, {
        token: adminToken,
        body: { description: 'Renamed by the asset test suite.' }
    });
    check(
        'PUT /api/assets/categories/:id updates a category',
        renameCategory.status === 200,
        `${renameCategory.status} ${renameCategory.raw}`
    );

    const renameAsIct = await request('PUT', `/api/assets/categories/${categoryId}`, {
        token: ictToken,
        body: { name: 'Hacked Name' }
    });
    check(
        'ICT Officer cannot rename a category (403)',
        renameAsIct.status === 403,
        `${renameAsIct.status} ${renameAsIct.raw}`
    );

    const createThrowaway = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: `Throwaway ${tagSeed}` }
    });
    const throwawayId =
        createThrowaway.body && createThrowaway.body.data && createThrowaway.body.data.category
            ? createThrowaway.body.data.category.id
            : null;

    const deleteThrowaway = await request('DELETE', `/api/assets/categories/${throwawayId}`, {
        token: adminToken
    });
    check(
        'an unused category can be deleted',
        deleteThrowaway.status === 200,
        `${deleteThrowaway.status} ${deleteThrowaway.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('11. Malformed input handling');
    /* ---------------------------------------------------------------- */
    const badJson = await new Promise((resolve, reject) => {
        const payload = '{"asset_tag": "broken", ';
        const req = http.request(
            `${BASE}/api/assets`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                    Authorization: `Bearer ${adminToken}`
                }
            },
            (res) => {
                let raw = '';
                res.on('data', (c) => (raw += c));
                res.on('end', () => resolve({ status: res.statusCode, raw }));
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
    check(
        'malformed JSON returns 400 (no 500 crash)',
        badJson.status === 400,
        `${badJson.status} ${badJson.raw}`
    );

    const badId = await request('GET', '/api/assets/not-a-number', { token: adminToken });
    check(
        'an unknown asset code returns 404',
        badId.status === 404,
        `${badId.status} ${badId.raw}`
    );
}

/* -------------------------------------------------------------------------
 * Bootstrap: start server, run suite, always clean up, exit explicitly.
 * ---------------------------------------------------------------------- */
server = app.listen(PORT, async () => {
    console.log('======================================================');
    console.log('  NBSZ Asset Management - Asset Register Test Suite');
    console.log('======================================================');
    console.log(`Target: ${BASE}`);
    console.log(`Time:   ${new Date().toISOString()}`);

    let failure = null;
    try {
        await connectDb();
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
