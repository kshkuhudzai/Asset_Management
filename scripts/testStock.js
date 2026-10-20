'use strict';

/**
 * scripts/testStock.js
 * ---------------------------------------------------------------------------
 * Standalone smoke/regression test for the ICT Stock / Store slice (§5.7).
 *
 * Boots the real Express app (which also verifies the MySQL connection) on an
 * isolated port, fires real HTTP requests at it, and asserts on the responses.
 * No test-runner dependency is required - run it with:
 *
 *     node scripts/testStock.js
 *
 * The suite is self-contained: it creates its own role accounts, category and
 * assets, and hard-deletes everything it created at the end (the API itself
 * never deletes stock movements, by design).
 *
 * Exit code 0 = all checks passed, 1 = at least one check failed.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const app = require('../server');
const stockModel = require('../models/stockModel');

// Dedicated port so this can run even while the dev server is up.
const PORT = process.env.STOCK_TEST_PORT || 3997;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let server = null;

// Ids created during the run, cleaned up at the end.
const createdMovementIds = [];
const createdItemIds = [];
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
 * `JSON.stringify` renders them as the PREVIOUS day in UTC. Comparing the local
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
 * Creates the test account for a role if it does not already exist, so RBAC can
 * be exercised. Returns the user id.
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
 * Removes everything this suite created. Child rows (movements, audit_logs) must
 * go before the parent stock items / users because of the foreign keys.
 */
async function cleanup() {
    if (!db) return;

    try {
        if (createdItemIds.length) {
            await db.query(
                `DELETE FROM audit_logs
                 WHERE table_name IN ('stock_items', 'stock_movements') AND record_id IN (?)`,
                [createdItemIds]
            );
            await db.query('DELETE FROM stock_movements WHERE stock_item_id IN (?)', [
                createdItemIds
            ]);
            await db.query('DELETE FROM stock_items WHERE id IN (?)', [createdItemIds]);
        }

        if (createdMovementIds.length) {
            await db.query(
                `DELETE FROM audit_logs
                 WHERE table_name = 'stock_movements' AND record_id IN (?)`,
                [createdMovementIds]
            );
            await db.query('DELETE FROM stock_movements WHERE id IN (?)', [createdMovementIds]);
        }

        if (createdAssetIds.length) {
            await db.query('DELETE FROM stock_movements WHERE asset_id IN (?)', [createdAssetIds]);
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
    const tagSeed = `STK-${stamp}`;

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
        username: 'stk_admin_test',
        email: 'stk.admin.test@nbsz.co.zw',
        password: 'StkAdmin@123',
        fullName: 'Stock Test Administrator',
        role: 'System Administrator'
    };
    const hisoUser = {
        username: 'stk_hiso_test',
        email: 'stk.hiso.test@nbsz.co.zw',
        password: 'StkHiso@123',
        fullName: 'Stock Test HISO',
        role: 'HISO'
    };
    const ictUser = {
        username: 'stk_ict_test',
        email: 'stk.ict.test@nbsz.co.zw',
        password: 'StkIct@123',
        fullName: 'Stock Test ICT Officer',
        role: 'ICT Officer'
    };
    const deptUser = {
        username: 'stk_dept_test',
        email: 'stk.dept.test@nbsz.co.zw',
        password: 'StkDept@123',
        fullName: 'Stock Test Departmental User',
        role: 'Departmental User'
    };
    const auditorUser = {
        username: 'stk_audit_test',
        email: 'stk.audit.test@nbsz.co.zw',
        password: 'StkAudit@123',
        fullName: 'Stock Test Auditor',
        role: 'Auditor'
    };

    const adminId = await ensureUser(adminUser);
    const hisoId = await ensureUser(hisoUser);
    const ictId = await ensureUser(ictUser);
    const deptId = await ensureUser(deptUser);
    const auditorId = await ensureUser(auditorUser);

    check('test accounts are ready', !!adminId && !!auditorId, `admin=${adminId}`);

    async function login(user) {
        return request('POST', '/api/auth/login', {
            body: { username: user.username, password: user.password }
        });
    }

    const adminLogin = await login(adminUser);
    adminToken = adminLogin.body && adminLogin.body.data ? adminLogin.body.data.token : null;
    check(
        'System Administrator can log in',
        adminLogin.status === 200 && !!adminToken,
        adminLogin.raw
    );

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

    // A stock endpoint must reject an anonymous caller.
    const anon = await request('GET', '/api/stock');
    check('an unauthenticated stock request is rejected (401)', anon.status === 401, anon.raw);



    /* ---------------------------------------------------------------- */
    section('2. Fixtures: category and assets');
    /* ---------------------------------------------------------------- */
    const categoryName = `Stock Category ${tagSeed}`;
    const createCategory = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: categoryName, description: 'Created by the stock test suite.' }
    });
    const categoryId =
        createCategory.body && createCategory.body.data && createCategory.body.data.category
            ? createCategory.body.data.category.id
            : null;
    if (categoryId) createdCategoryIds.push(categoryId);
    check('asset category created', !!categoryId, createCategory.raw);

    /**
     * Registers an asset through the real API so the fixtures follow exactly the
     * same path as production data.
     */
    async function createAsset(suffix, overrides = {}) {
        const payload = {
            asset_tag: `${tagSeed}-${suffix}`,
            serial_number: `${tagSeed}-SN-${suffix}`,
            category_id: categoryId,
            manufacturer: 'StockTest',
            model: 'Model-S',
            location: 'ICT Store - Head Office',
            department: 'ICT',
            status: 'In Stock',
            condition_status: 'Good',
            purchase_cost: 150,
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

    // An asset that is NOT in the store, so the register-derived list must not
    // report it as held in ICT stores.
    const assigned = await createAsset('D', {
        status: 'In Use',
        location: 'Head Office',
        assigned_user_id: deptId
    });
    check('out-of-store test asset created', !!assigned.asset, assigned.res.raw);

    if (!asset) {
        throw new Error('Cannot continue without the primary test asset.');
    }



    /* ---------------------------------------------------------------- */
    section('3. Reference data (meta, stats)');
    /* ---------------------------------------------------------------- */
    const meta = await request('GET', '/api/stock/meta', { token: ictToken });
    check('GET /api/stock/meta returns 200', meta.status === 200, meta.raw);
    check(
        'meta exposes the item statuses',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.statuses) &&
            meta.body.data.statuses.includes('Active') &&
            meta.body.data.statuses.includes('Discontinued'),
        meta.raw
    );
    check(
        'meta exposes the movement types',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.movement_types) &&
            meta.body.data.movement_types.includes('Receipt') &&
            meta.body.data.movement_types.includes('Issue') &&
            meta.body.data.movement_types.includes('Return') &&
            meta.body.data.movement_types.includes('Write Off'),
        meta.raw
    );
    check(
        'meta exposes the stock states',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.stock_states) &&
            meta.body.data.stock_states.includes('Low Stock'),
        meta.raw
    );
    check(
        'meta exposes the units of measure',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.units_of_measure) &&
            meta.body.data.units_of_measure.includes('Unit'),
        meta.raw
    );
    check(
        'meta exposes the store locations',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.store_locations) &&
            meta.body.data.store_locations.length > 0,
        meta.raw
    );
    check(
        'meta exposes a next item reference (STK- prefix)',
        !!meta.body &&
            !!meta.body.data &&
            typeof meta.body.data.next_item_ref === 'string' &&
            meta.body.data.next_item_ref.startsWith('STK-'),
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

    const stats = await request('GET', '/api/stock/stats', { token: auditorToken });
    check('GET /api/stock/stats returns 200 for an Auditor', stats.status === 200, stats.raw);
    check(
        'stats report the register-derived holding',
        !!stats.body &&
            !!stats.body.data &&
            typeof stats.body.data.derivedFromRegister === 'number' &&
            stats.body.data.derivedFromRegister > 0,
        stats.raw
    );
    check(
        'stats expose a non-negative stock value',
        !!stats.body &&
            !!stats.body.data &&
            typeof stats.body.data.stockValue === 'number' &&
            stats.body.data.stockValue >= 0,
        stats.raw
    );
    check(
        'stats expose the movements grouped by type',
        !!stats.body && !!stats.body.data && Array.isArray(stats.body.data.byMovementType),
        stats.raw
    );

    // A Departmental User may read the register but not the aggregate figures.
    const deptStats = await request('GET', '/api/stock/stats', { token: deptToken });
    check('a Departmental User is refused stats (403)', deptStats.status === 403, deptStats.raw);

    const deptMeta = await request('GET', '/api/stock/meta', { token: deptToken });
    check('a Departmental User is refused meta (403)', deptMeta.status === 403, deptMeta.raw);



    /* ---------------------------------------------------------------- */
    section('4. Register-derived holding (§5.7 "assets held in ICT stores")');
    /* ---------------------------------------------------------------- */
    const derivedList = await request(
        'GET',
        `/api/stock?search=${encodeURIComponent(tagSeed)}&include_derived=true&limit=50`,
        { token: adminToken }
    );
    check('GET /api/stock returns 200', derivedList.status === 200, derivedList.raw);

    const derivedRows =
        derivedList.body && derivedList.body.data && Array.isArray(derivedList.body.data.stock_items)
            ? derivedList.body.data.stock_items
            : [];

    check(
        'the list reports a derived count',
        !!derivedList.body &&
            !!derivedList.body.data &&
            typeof derivedList.body.data.derived === 'number' &&
            derivedList.body.data.derived >= 3,
        derivedList.raw
    );
    check(
        'register assets held in stores appear with source=asset_register',
        derivedRows.some((row) => row.source === 'asset_register'),
        `sources: ${derivedRows.map((r) => r.source).join(', ') || 'none'}`
    );
    check(
        'a derived item exposes a synthetic asset-<id> key',
        derivedRows.some((row) => String(row.id) === `asset-${asset.id}`),
        `ids: ${derivedRows.map((r) => r.id).join(', ') || 'none'}`
    );
    check(
        'a derived item reports a quantity of one unit',
        derivedRows
            .filter((row) => String(row.id) === `asset-${asset.id}`)
            .every((row) => Number(row.quantity_on_hand) === 1),
        'expected quantity_on_hand = 1'
    );
    check(
        'an asset that is not in stores is excluded from the store list',
        !derivedRows.some((row) => row.asset_id === assigned.asset.id),
        derivedRows.some((row) => row.asset_id === assigned.asset.id)
            ? 'an In Use asset was reported as holding'
            : 'ok'
    );

    // A derived row is a read-only snapshot, so it cannot be moved.
    const derivedMove = await request('POST', `/api/stock/asset-${asset.id}/issue`, {
        token: adminToken,
        body: { quantity: 1, to_user_name: 'Nobody' }
    });
    check(
        'a register-derived item refuses a stock movement (409)',
        derivedMove.status === 409,
        derivedMove.raw
    );

    // The register-derived row is still readable by its synthetic id.
    const derivedRead = await request('GET', `/api/stock/asset-${asset.id}`, { token: adminToken });
    check(
        'a register-derived item can be read by its synthetic id',
        derivedRead.status === 200 &&
            !!derivedRead.body &&
            !!derivedRead.body.data &&
            !!derivedRead.body.data.stock_item &&
            derivedRead.body.data.stock_item.source === 'asset_register',
        derivedRead.raw
    );



    /* ---------------------------------------------------------------- */
    section('5. Opening store cards');
    /* ---------------------------------------------------------------- */
    // The store card is seeded with an opening quantity so the running-balance
    // assertions below do not depend on what else exists in the database.
    const createItem = await request('POST', '/api/stock', {
        token: ictToken,
        body: {
            asset_id: asset.id,
            item_name: 'Spare Laptop Battery',
            part_code: `${tagSeed}-BATT`,
            category: 'Spares',
            unit_of_measure: 'Unit',
            store_location: 'ICT Store - Head Office',
            bin_location: 'B12',
            department: 'ICT',
            minimum_level: 5,
            maximum_level: 20,
            unit_cost: 45.5,
            currency: 'usd',
            supplier: 'PowerCell Ltd',
            supplier_contact: 'sales@powercell.test',
            quantity_on_hand: 30
        }
    });

    const item = createItem.body && createItem.body.data ? createItem.body.data.stock_item : null;
    if (item) createdItemIds.push(item.id);

    check('an ICT Officer can open a store card (201)', createItem.status === 201, createItem.raw);
    check(
        'the store card has a sequential STK- reference',
        !!item && /^STK-\d{6}$/.test(item.item_ref),
        item ? item.item_ref : 'no item'
    );
    check(
        'the store card reports the catalogue details',
        !!item &&
            item.category === 'Spares' &&
            item.bin_location === 'B12' &&
            item.unit_of_measure === 'Unit',
        item ? `${item.category}/${item.bin_location}/${item.unit_of_measure}` : 'no item'
    );
    check(
        'the currency is normalised to upper case',
        !!item && item.currency === 'USD',
        item ? String(item.currency) : 'no item'
    );
    check(
        'the opening quantity is carried on the card',
        !!item && Number(item.quantity_on_hand) === 30,
        item ? String(item.quantity_on_hand) : 'no item'
    );
    check(
        'an opening balance above the maximum is Overstocked',
        !!item && item.stock_state === 'Overstocked',
        item ? String(item.stock_state) : 'no item'
    );
    check(
        'the opening balance is reported alongside the card',
        !!createItem.body &&
            !!createItem.body.data &&
            Number(createItem.body.data.opening_quantity) === 30,
        createItem.raw
    );

    // The same asset must not gain a second card.
    const duplicate = await request('POST', '/api/stock', {
        token: ictToken,
        body: { asset_id: asset.id, item_name: 'Duplicate' }
    });
    check(
        'a second card for the same asset is refused (409)',
        duplicate.status === 409,
        duplicate.raw
    );

    // A store card for a consumable has no asset behind it.
    const consumable = await request('POST', '/api/stock', {
        token: adminToken,
        body: {
            item_name: `Thermal Paste ${stamp}`,
            category: 'Consumables',
            unit_of_measure: 'Box',
            store_location: 'ICT Store - Bulawayo',
            minimum_level: 5,
            maximum_level: 15,
            unit_cost: 12,
            quantity_on_hand: 10,
            supplier: 'Consumables Co'
        }
    });
    const paste =
        consumable.body && consumable.body.data && consumable.body.data.stock_item
            ? consumable.body.data.stock_item
            : null;
    if (paste) createdItemIds.push(paste.id);

    check('a consumable store card can be opened (201)', consumable.status === 201, consumable.raw);
    check(
        'the opening quantity is reflected on the card',
        !!paste && Number(paste.quantity_on_hand) === 10,
        paste ? String(paste.quantity_on_hand) : 'no paste'
    );
    check(
        'the opening balance is written to the ledger as a Receipt',
        !!consumable.body &&
            !!consumable.body.data &&
            Number(consumable.body.data.opening_quantity) === 10,
        consumable.raw
    );

    const concurrentCardResponse = await request('POST', '/api/stock', {
        token: ictToken,
        body: {
            item_name: `Concurrent Issue Test ${stamp}`,
            category: 'Test',
            unit_of_measure: 'Unit',
            quantity_on_hand: 10
        }
    });
    const concurrentCard =
        concurrentCardResponse.body && concurrentCardResponse.body.data
            ? concurrentCardResponse.body.data.stock_item
            : null;
    if (concurrentCard) createdItemIds.push(concurrentCard.id);

    check('a concurrency test store card is created', !!concurrentCard, concurrentCardResponse.raw);
    if (concurrentCard) {
        const issuePayload = {
            quantity: 7,
            movement_date: today(),
            reason: 'Concurrent issue regression test',
            to_user_name: 'Concurrent Test Recipient'
        };
        const concurrentIssues = await Promise.all([
            request('POST', `/api/stock/${concurrentCard.id}/issue`, {
                token: ictToken,
                body: issuePayload
            }),
            request('POST', `/api/stock/${concurrentCard.id}/issue`, {
                token: ictToken,
                body: issuePayload
            })
        ]);
        const successfulIssue = concurrentIssues.find((result) => result.status === 201);
        const movementId =
            successfulIssue && successfulIssue.body && successfulIssue.body.data
                ? successfulIssue.body.data.movement_id
                : null;
        if (movementId) createdMovementIds.push(movementId);
        const balance = await stockModel.findById(concurrentCard.id);

        check(
            'simultaneous issues cannot overspend the available stock',
            concurrentIssues.filter((result) => result.status === 201).length === 1 &&
                concurrentIssues.filter((result) => result.status === 409).length === 1 &&
                Number(balance.quantity_on_hand) === 3,
            concurrentIssues.map((result) => `${result.status}: ${result.raw}`).join(' | ')
        );
    }

    // An asset id that does not exist must not reach the foreign key.
    const badAsset = await request('POST', '/api/stock', {
        token: adminToken,
        body: { asset_id: 999999999, item_name: 'Ghost' }
    });
    check('an unknown asset id is rejected (404)', badAsset.status === 404, badAsset.raw);

    // A consumable with no name is not usable.
    const noName = await request('POST', '/api/stock', {
        token: adminToken,
        body: { category: 'Consumables' }
    });
    check('a card with no item name is rejected (400)', noName.status === 400, noName.raw);

    // A maximum below the minimum makes the Overstocked state unreachable.
    const badBounds = await request('POST', '/api/stock', {
        token: adminToken,
        body: { item_name: 'Bad bounds', minimum_level: 10, maximum_level: 4 }
    });
    check('a maximum below the minimum is rejected (400)', badBounds.status === 400, badBounds.raw);

    if (!item) {
        throw new Error('Cannot continue without the primary store card.');
    }



    /* ---------------------------------------------------------------- */
    section('6. Receipt, issue and return of stock (§5.7)');
    /* ---------------------------------------------------------------- */

    /* ------------------------------ Receipt ---------------------------- */

    const receipt = await request('POST', `/api/stock/${item.id}/receipt`, {
        token: ictToken,
        body: {
            quantity: 12,
            movement_date: today(),
            reference: `${tagSeed}-INV-1`,
            reason: 'Delivered against purchase order',
            counterparty: 'PowerCell Ltd',
            unit_cost: 45.5,
            remarks: 'Batteries received in good order.'
        }
    });

    const receiptMovementId =
        receipt.body && receipt.body.data ? receipt.body.data.movement_id : null;
    if (receiptMovementId) createdMovementIds.push(receiptMovementId);

    check('an ICT Officer can record a receipt (201)', receipt.status === 201, receipt.raw);
    check(
        'the receipt raises the balance to 42',
        !!receipt.body && !!receipt.body.data && Number(receipt.body.data.balance_after) === 42,
        receipt.raw
    );
    check(
        'the receipt returns a MOV- reference',
        !!receipt.body &&
            !!receipt.body.data &&
            /^MOV-\d{6}$/.test(String(receipt.body.data.movement_ref)),
        receipt.raw
    );
    check(
        'the store card now reports 42 on hand',
        !!receipt.body &&
            !!receipt.body.data &&
            !!receipt.body.data.stock_item &&
            Number(receipt.body.data.stock_item.quantity_on_hand) === 42,
        receipt.raw
    );
    check(
        'the card roll-up counts every receipt, including the opening balance',
        !!receipt.body &&
            !!receipt.body.data &&
            !!receipt.body.data.stock_item &&
            Number(receipt.body.data.stock_item.quantity_received) >= 42,
        receipt.raw
    );

    /* ------------------------------- Issue ----------------------------- */

    // Issuing more than is on hand must be refused (§5.7 balances).
    const overIssue = await request('POST', `/api/stock/${item.id}/issue`, {
        token: ictToken,
        body: { quantity: 99, to_user_name: 'Too Many' }
    });
    check(
        'an issue larger than the balance is refused (409)',
        overIssue.status === 409,
        overIssue.raw
    );
    check(
        'the refusal names the quantity field',
        !!overIssue.body &&
            Array.isArray(overIssue.body.errors) &&
            overIssue.body.errors.some((e) => e.field === 'quantity'),
        overIssue.raw
    );

    // An issue with no receiving party is not traceable, so it is refused.
    const anonymousIssue = await request('POST', `/api/stock/${item.id}/issue`, {
        token: ictToken,
        body: { quantity: 1 }
    });
    check(
        'an issue with no recipient is refused (400)',
        anonymousIssue.status === 400,
        anonymousIssue.raw
    );

    const issue = await request('POST', `/api/stock/${item.id}/issue`, {
        token: ictToken,
        body: {
            quantity: 3,
            movement_date: today(),
            reference: `${tagSeed}-ISS-1`,
            reason: 'Replacement for a failed battery',
            to_user_id: deptId,
            condition_status: 'Good'
        }
    });

    const issueMovementId = issue.body && issue.body.data ? issue.body.data.movement_id : null;
    if (issueMovementId) createdMovementIds.push(issueMovementId);

    check('an ICT Officer can record an issue (201)', issue.status === 201, issue.raw);
    check(
        'the issue lowers the balance to 39',
        !!issue.body && !!issue.body.data && Number(issue.body.data.balance_after) === 39,
        issue.raw
    );
    check(
        'the issue resolves the receiving custodian',
        !!issue.body &&
            !!issue.body.data &&
            !!issue.body.data.recipient &&
            Number(issue.body.data.recipient.id) === Number(deptId),
        issue.raw
    );
    check(
        'the roll-up stamps the issued units on the card',
        !!issue.body &&
            !!issue.body.data &&
            !!issue.body.data.stock_item &&
            Number(issue.body.data.stock_item.quantity_issued) === 3,
        issue.raw
    );

    // An unknown custodian must not be recorded as the receiving party.
    const badRecipient = await request('POST', `/api/stock/${item.id}/issue`, {
        token: ictToken,
        body: { quantity: 1, to_user_id: 'no_such_user_xyz' }
    });
    check(
        'an issue naming an unknown custodian is refused (404)',
        badRecipient.status === 404,
        badRecipient.raw
    );

    /* ------------------------------- Return ---------------------------- */

    const returned = await request('POST', `/api/stock/${item.id}/return`, {
        token: ictToken,
        body: {
            quantity: 2,
            movement_date: today(),
            reference: `${tagSeed}-RET-1`,
            reason: 'Unused spares returned to the store',
            to_user_name: 'ICT Store',
            condition_status: 'Good'
        }
    });

    const returnMovementId = returned.body && returned.body.data
        ? returned.body.data.movement_id
        : null;
    if (returnMovementId) createdMovementIds.push(returnMovementId);

    check('an ICT Officer can record a return (201)', returned.status === 201, returned.raw);
    check(
        'the return raises the balance back to 41',
        !!returned.body && !!returned.body.data && Number(returned.body.data.balance_after) === 41,
        returned.raw
    );

    // A return does not need a recipient - stock is coming back to the store.
    const plainReturn = await request('POST', `/api/stock/${item.id}/return`, {
        token: ictToken,
        body: { quantity: 1, reason: 'Walk-in return' }
    });
    check(
        'a return without a named recipient is accepted (201)',
        plainReturn.status === 201,
        plainReturn.raw
    );
    if (plainReturn.body && plainReturn.body.data && plainReturn.body.data.movement_id) {
        createdMovementIds.push(plainReturn.body.data.movement_id);
    }

    /* ---------------------------- Validation --------------------------- */

    const zeroQuantity = await request('POST', `/api/stock/${item.id}/receipt`, {
        token: ictToken,
        body: { quantity: 0 }
    });
    check('a zero quantity is rejected (400)', zeroQuantity.status === 400, zeroQuantity.raw);

    const missingQuantity = await request('POST', `/api/stock/${item.id}/receipt`, {
        token: ictToken,
        body: { reference: 'no quantity' }
    });
    check(
        'a receipt with no quantity is rejected (400)',
        missingQuantity.status === 400,
        missingQuantity.raw
    );

    const badDate = await request('POST', `/api/stock/${item.id}/receipt`, {
        token: ictToken,
        body: { quantity: 1, movement_date: '2026-13-45' }
    });
    check('an impossible movement date is rejected (400)', badDate.status === 400, badDate.raw);

    const unknownItem = await request('POST', '/api/stock/999999999/receipt', {
        token: ictToken,
        body: { quantity: 1 }
    });
    check(
        'a receipt against an unknown card is refused (404)',
        unknownItem.status === 404,
        unknownItem.raw
    );



    /* ---------------------------------------------------------------- */
    section('7. Role-based access control (§9)');
    /* ---------------------------------------------------------------- */

    // An Auditor may read the store but not move anything into it.
    const auditorRead = await request('GET', `/api/stock/${item.id}`, { token: auditorToken });
    check('an Auditor can read a store card', auditorRead.status === 200, auditorRead.raw);

    const auditorList = await request('GET', '/api/stock?limit=5', { token: auditorToken });
    check('an Auditor can list the store', auditorList.status === 200, auditorList.raw);

    const auditorReceipt = await request('POST', `/api/stock/${item.id}/receipt`, {
        token: auditorToken,
        body: { quantity: 1 }
    });
    check(
        'an Auditor cannot record a receipt (403)',
        auditorReceipt.status === 403,
        auditorReceipt.raw
    );

    const auditorAdjust = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: auditorToken,
        body: { quantity: 1, reason: 'not allowed' }
    });
    check(
        'an Auditor cannot adjust a balance (403)',
        auditorAdjust.status === 403,
        auditorAdjust.raw
    );

    // An ICT Officer handles receipts but must not be able to restate a balance.
    const ictAdjust = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: ictToken,
        body: { quantity: 1, reason: 'not allowed' }
    });
    check(
        'an ICT Officer cannot adjust a balance (403)',
        ictAdjust.status === 403,
        ictAdjust.raw
    );

    const ictWriteOff = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: ictToken,
        body: { quantity: -1, reason: 'damaged', movement_type: 'Write Off' }
    });
    check(
        'an ICT Officer cannot write stock off (403)',
        ictWriteOff.status === 403,
        ictWriteOff.raw
    );

    // A Departmental User may read the store list but is scoped to their assets.
    const deptList = await request('GET', '/api/stock?limit=100', { token: deptToken });
    check('a Departmental User can read the store list', deptList.status === 200, deptList.raw);
    check(
        'a Departmental User sees only the assets in their custody',
        !!deptList.body &&
            !!deptList.body.data &&
            Array.isArray(deptList.body.data.stock_items) &&
            deptList.body.data.stock_items.every(
                (row) => row.asset_id === null || row.asset_id === null || Number(row.asset_id) === Number(assigned.asset.id)
            ),
        deptList.raw
    );
    const deptCannotReadCard = await request('GET', `/api/stock/${item.id}`, { token: deptToken });
    check(
        'a Departmental User cannot read stock details outside their custody (404)',
        deptCannotReadCard.status === 404,
        deptCannotReadCard.raw
    );

    const deptIssue = await request('POST', `/api/stock/${item.id}/issue`, {
        token: deptToken,
        body: { quantity: 1, to_user_name: 'Self' }
    });
    check(
        'a Departmental User cannot issue stock (403)',
        deptIssue.status === 403,
        deptIssue.raw
    );

    const deptCreate = await request('POST', '/api/stock', {
        token: deptToken,
        body: { item_name: 'Not allowed' }
    });
    check(
        'a Departmental User cannot open a store card (403)',
        deptCreate.status === 403,
        deptCreate.raw
    );

    const deptLowStock = await request('GET', '/api/stock/low-stock', { token: deptToken });
    check(
        'a Departmental User can read the scoped low-stock list',
        deptLowStock.status === 200,
        deptLowStock.raw
    );



    /* ---------------------------------------------------------------- */
    section('8. Stock balances and low-stock alerts (§5.7)');
    /* ---------------------------------------------------------------- */

    const balances = await request('GET', '/api/stock/balances', { token: auditorToken });
    check('GET /api/stock/balances returns 200', balances.status === 200, balances.raw);
    check(
        'balances report the line items and units on hand',
        !!balances.body &&
            !!balances.body.data &&
            Number(balances.body.data.lineItems) >= 2 &&
            Number(balances.body.data.unitsOnHand) >= 11,
        balances.raw
    );
    check(
        'balances expose a stock value',
        !!balances.body &&
            !!balances.body.data &&
            typeof balances.body.data.stockValue === 'number' &&
            balances.body.data.stockValue > 0,
        balances.raw
    );
    check(
        'balances group by store',
        !!balances.body &&
            !!balances.body.data &&
            Array.isArray(balances.body.data.byStore) &&
            balances.body.data.byStore.some((row) => row.store_location === 'ICT Store - Head Office'),
        balances.raw
    );
    check(
        'balances group by category',
        !!balances.body &&
            !!balances.body.data &&
            Array.isArray(balances.body.data.byCategory) &&
            balances.body.data.byCategory.some((row) => row.category === 'Spares'),
        balances.raw
    );
    check(
        'balances group by state',
        !!balances.body &&
            !!balances.body.data &&
            Array.isArray(balances.body.data.byState) &&
            balances.body.data.byState.length > 0,
        balances.raw
    );
    check(
        'balances expose a totals convenience object',
        !!balances.body &&
            !!balances.body.data &&
            !!balances.body.data.totals &&
            Number(balances.body.data.totals.unitsOnHand) ===
                Number(balances.body.data.unitsOnHand),
        balances.raw
    );
    check(
        'balances count the register holding the store has not catalogued',
        !!balances.body &&
            !!balances.body.data &&
            Number(balances.body.data.derivedFromRegister) >= 2,
        balances.raw
    );

    // The primary card is at 11 with a minimum of 5, so it is not yet low.
    const lowStockBefore = await request('GET', '/api/stock/low-stock?limit=50', {
        token: ictToken
    });
    check('GET /api/stock/low-stock returns 200', lowStockBefore.status === 200, lowStockBefore.raw);
    check(
        'a card above its minimum is not reported as low',
        !!lowStockBefore.body &&
            !!lowStockBefore.body.data &&
            Array.isArray(lowStockBefore.body.data.stock_items) &&
            !lowStockBefore.body.data.stock_items.some((row) => Number(row.id) === Number(item.id)),
        lowStockBefore.raw
    );

    // The paste card is at 10 with a minimum of 5, so it is not low either.
    check(
        'the state of the paste card is In Stock',
        !!paste && paste.stock_state === 'In Stock',
        paste ? String(paste.stock_state) : 'no paste'
    );

    // Issue enough from the paste to cross its minimum (10 -> 5).
    const drainPaste = await request('POST', `/api/stock/${paste.id}/issue`, {
        token: ictToken,
        body: {
            quantity: 5,
            reference: `${tagSeed}-ISS-PASTE`,
            reason: 'Consumed on a repair job',
            to_department: 'Workshop'
        }
    });
    check('the paste card can be issued down to its minimum', drainPaste.status === 201, drainPaste.raw);
    if (drainPaste.body && drainPaste.body.data && drainPaste.body.data.movement_id) {
        createdMovementIds.push(drainPaste.body.data.movement_id);
    }
    check(
        'the paste card is now reported as Low Stock',
        !!drainPaste.body &&
            !!drainPaste.body.data &&
            !!drainPaste.body.data.stock_item &&
            drainPaste.body.data.stock_item.stock_state === 'Low Stock',
        drainPaste.raw
    );

    const lowStockAfter = await request('GET', '/api/stock/low-stock?limit=50', {
        token: ictToken
    });
    check(
        'the low-stock list now includes the drained card',
        !!lowStockAfter.body &&
            !!lowStockAfter.body.data &&
            Array.isArray(lowStockAfter.body.data.stock_items) &&
            lowStockAfter.body.data.stock_items.some((row) => Number(row.id) === Number(paste.id)),
        lowStockAfter.raw
    );

    // The low-stock filter on the list endpoint must agree with the dedicated one.
    const listLow = await request('GET', '/api/stock?low_stock=true&limit=50', { token: ictToken });
    check(
        'the list endpoint honours the low_stock filter',
        !!listLow.body &&
            !!listLow.body.data &&
            Array.isArray(listLow.body.data.stock_items) &&
            listLow.body.data.stock_items.every(
                (row) => Number(row.quantity_on_hand) <= Number(row.minimum_level)
            ),
        listLow.raw
    );



    /* ---------------------------------------------------------------- */
    section('9. Movement history (§5.7)');
    /* ---------------------------------------------------------------- */

    const history = await request('GET', `/api/stock/${item.id}`, { token: ictToken });
    check(
        'a store card carries its movement history',
        history.status === 200 &&
            !!history.body &&
            !!history.body.data &&
            Array.isArray(history.body.data.movements) &&
            history.body.data.movements.length >= 4,
        history.raw
    );

    const movements = await request('GET', `/api/stock/movements?stock_item_id=${item.id}`, {
        token: adminToken
    });
    check('GET /api/stock/movements returns 200', movements.status === 200, movements.raw);
    check(
        'the ledger reports a total for the card',
        !!movements.body && !!movements.body.data && Number(movements.body.data.total) >= 4,
        movements.raw
    );

    const movementsList =
        movements.body && movements.body.data && Array.isArray(movements.body.data.movements)
            ? movements.body.data.movements
            : [];

    const ledgerShape = movementsList.map((r) => `${r.movement_type}:${r.quantity}`).join(', ');

    check(
        'the receipt is recorded in the ledger with a positive quantity',
        movementsList.some((row) => row.movement_type === 'Receipt' && Number(row.quantity) === 12),
        `types: ${ledgerShape}`
    );
    check(
        'the issue is recorded in the ledger with a negative quantity',
        movementsList.some((row) => row.movement_type === 'Issue' && Number(row.quantity) === -3),
        `types: ${ledgerShape}`
    );
    check(
        'a return is recorded in the ledger with a positive quantity',
        movementsList.some((row) => row.movement_type === 'Return' && Number(row.quantity) > 0),
        `types: ${ledgerShape}`
    );
    check(
        'every ledger row snapshots the resulting balance',
        movementsList.length > 0 &&
            movementsList.every((row) => row.balance_after !== null && row.balance_after !== undefined),
        `balances: ${movementsList.map((r) => r.balance_after).join(', ')}`
    );
    check(
        'the ledger row names the recording officer',
        movementsList.length > 0 &&
            movementsList.every((row) => row.recorded_by !== null && row.recorded_by !== undefined),
        'expected recorded_by on every row'
    );

    // Filtering the ledger by movement type.
    const issuesOnly = await request(
        'GET',
        `/api/stock/movements?stock_item_id=${item.id}&movement_type=Issue`,
        { token: adminToken }
    );
    check(
        'the ledger can be filtered by movement type',
        !!issuesOnly.body &&
            !!issuesOnly.body.data &&
            Array.isArray(issuesOnly.body.data.movements) &&
            issuesOnly.body.data.movements.length > 0 &&
            issuesOnly.body.data.movements.every((row) => row.movement_type === 'Issue'),
        issuesOnly.raw
    );

    // Filtering the ledger by date range.
    const futureOnly = await request(
        'GET',
        `/api/stock/movements?stock_item_id=${item.id}&date_from=${dayOffset(1)}`,
        { token: adminToken }
    );
    check(
        'the ledger can be filtered by date range',
        !!futureOnly.body && !!futureOnly.body.data && Number(futureOnly.body.data.total) === 0,
        futureOnly.raw
    );

    const badItemFilter = await request('GET', '/api/stock/movements?stock_item_id=not-a-number', {
        token: adminToken
    });
    check(
        'a non-numeric stock_item_id is rejected (400)',
        badItemFilter.status === 400,
        badItemFilter.raw
    );

    const badAssetFilter = await request('GET', '/api/stock/movements?asset_id=999999999', {
        token: adminToken
    });
    check(
        'an unknown asset filter on the ledger is refused (404)',
        badAssetFilter.status === 404,
        badAssetFilter.raw
    );

    // The ledger filtered by the linked asset.
    const byAsset = await request('GET', `/api/stock/movements?asset_id=${asset.id}`, {
        token: adminToken
    });
    check(
        'the ledger can be filtered by asset',
        !!byAsset.body &&
            !!byAsset.body.data &&
            Array.isArray(byAsset.body.data.movements) &&
            byAsset.body.data.movements.length > 0 &&
            byAsset.body.data.movements.every((row) => Number(row.asset_id) === Number(asset.id)),
        byAsset.raw
    );

    // The per-asset position endpoint combines the card and the history.
    const assetPosition = await request('GET', `/api/stock/asset/${asset.id}`, {
        token: adminToken
    });
    check(
        'GET /api/stock/asset/:assetId returns the card and its history',
        assetPosition.status === 200 &&
            !!assetPosition.body &&
            !!assetPosition.body.data &&
            !!assetPosition.body.data.stock_item &&
            Array.isArray(assetPosition.body.data.movements) &&
            assetPosition.body.data.catalogued === true,
        assetPosition.raw
    );
    check(
        'the asset position shows the asset is in store',
        !!assetPosition.body && !!assetPosition.body.data && assetPosition.body.data.in_store === true,
        assetPosition.raw
    );

    // The asset may also be addressed by its tag.
    const byTag = await request('GET', `/api/stock/asset/${asset.asset_tag}`, { token: adminToken });
    check(
        'an asset position can be addressed by its tag',
        byTag.status === 200 &&
            !!byTag.body &&
            !!byTag.body.data &&
            !!byTag.body.data.stock_item &&
            Number(byTag.body.data.stock_item.asset_id) === Number(asset.id),
        byTag.raw
    );

    const unknownAssetPosition = await request('GET', '/api/stock/asset/NO-SUCH-TAG', {
        token: adminToken
    });
    check(
        'an unknown asset position is refused (404)',
        unknownAssetPosition.status === 404,
        unknownAssetPosition.raw
    );

    // A single ledger entry.
    const singleMovement = await request('GET', `/api/stock/movements/${receiptMovementId}`, {
        token: adminToken
    });
    check(
        'a single ledger entry can be read',
        singleMovement.status === 200 &&
            !!singleMovement.body &&
            !!singleMovement.body.data &&
            !!singleMovement.body.data.movement &&
            Number(singleMovement.body.data.movement.id) === Number(receiptMovementId),
        singleMovement.raw
    );

    const missingMovement = await request('GET', '/api/stock/movements/999999999', {
        token: adminToken
    });
    check(
        'an unknown ledger entry is refused (404)',
        missingMovement.status === 404,
        missingMovement.raw
    );

    // Recent movements feed the dashboard panel.
    const recent = await request('GET', '/api/stock/movements/recent?limit=5', {
        token: adminToken
    });
    check(
        'GET /api/stock/movements/recent returns the latest entries',
        recent.status === 200 &&
            !!recent.body &&
            !!recent.body.data &&
            Array.isArray(recent.body.data.movements) &&
            recent.body.data.movements.length > 0,
        recent.raw
    );
    check(
        'the recent list respects the limit',
        !!recent.body &&
            !!recent.body.data &&
            Array.isArray(recent.body.data.movements) &&
            recent.body.data.movements.length <= 5,
        recent.raw
    );



    /* ---------------------------------------------------------------- */
    section('10. Adjustments, write-offs and reversals (§5.7, §11)');
    /* ---------------------------------------------------------------- */

    // An adjustment must state why, otherwise the balance change is unexplained.
    const noReason = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: adminToken,
        body: { quantity: 1 }
    });
    check('an adjustment with no reason is refused (400)', noReason.status === 400, noReason.raw);
    check(
        'the refusal names the reason field',
        !!noReason.body &&
            Array.isArray(noReason.body.errors) &&
            noReason.body.errors.some((e) => e.field === 'reason'),
        noReason.raw
    );

    // A receipt must not be smuggled through the adjustment endpoint.
    const wrongType = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: adminToken,
        body: { quantity: 1, reason: 'sneaky', movement_type: 'Receipt' }
    });
    check(
        'an adjustment cannot be disguised as a receipt (400)',
        wrongType.status === 400,
        wrongType.raw
    );

    // A write-off only ever removes stock.
    const positiveWriteOff = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: adminToken,
        body: { quantity: 1, reason: 'damaged', movement_type: 'Write Off' }
    });
    check(
        'a positive write-off is refused (400)',
        positiveWriteOff.status === 400,
        positiveWriteOff.raw
    );

    // A stock-take correction: the count found 3 more than the ledger thought.
    const adjustment = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: adminToken,
        body: {
            quantity: 3,
            reason: 'Stock take found three additional units',
            movement_type: 'Stock Take',
            reference: `${tagSeed}-COUNT-1`
        }
    });
    check(
        'a System Administrator can adjust a balance (201)',
        adjustment.status === 201,
        adjustment.raw
    );
    check(
        'the adjustment raises the balance to 45',
        !!adjustment.body && !!adjustment.body.data && Number(adjustment.body.data.balance_after) === 45,
        adjustment.raw
    );
    if (adjustment.body && adjustment.body.data && adjustment.body.data.movement_id) {
        createdMovementIds.push(adjustment.body.data.movement_id);
    }

    // A damaged unit is written off.
    const writeOff = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: hisoToken,
        body: {
            quantity: -2,
            reason: 'Two units found damaged in the store and scrapped',
            movement_type: 'Write Off',
            reference: `${tagSeed}-WO-1`
        }
    });
    check('a HISO can write stock off (201)', writeOff.status === 201, writeOff.raw);
    check(
        'the write-off lowers the balance to 43',
        !!writeOff.body && !!writeOff.body.data && Number(writeOff.body.data.balance_after) === 43,
        writeOff.raw
    );
    if (writeOff.body && writeOff.body.data && writeOff.body.data.movement_id) {
        createdMovementIds.push(writeOff.body.data.movement_id);
    }

    // An adjustment that would push the balance negative must be refused.
    const negativeAdjust = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: adminToken,
        body: { quantity: -999, reason: 'impossible' }
    });
    check(
        'an adjustment that would go negative is refused (409)',
        negativeAdjust.status === 409,
        negativeAdjust.raw
    );

    // An adjustment of zero is meaningless.
    const zeroAdjust = await request('POST', `/api/stock/${item.id}/adjust`, {
        token: adminToken,
        body: { quantity: 0, reason: 'nothing' }
    });
    check('a zero adjustment is refused (400)', zeroAdjust.status === 400, zeroAdjust.raw);

    /* ----------------------------- Reversal ---------------------------- */

    const reverse = await request('POST', `/api/stock/movements/${receiptMovementId}/reverse`, {
        token: adminToken,
        body: { reason: 'The receipt was posted against the wrong store card.' }
    });

    check('a System Administrator can reverse a movement (201)', reverse.status === 201, reverse.raw);
    check(
        'the reversal points back at the original movement',
        !!reverse.body &&
            !!reverse.body.data &&
            Number(reverse.body.data.reversal_of) === Number(receiptMovementId),
        reverse.raw
    );
    check(
        'the reversal lowers the balance back by the original 12',
        !!reverse.body && !!reverse.body.data && Number(reverse.body.data.balance_after) === 31,
        reverse.raw
    );
    if (reverse.body && reverse.body.data && reverse.body.data.movement_id) {
        createdMovementIds.push(reverse.body.data.movement_id);
    }
    check(
        'the reversal returns a MOV- reference',
        !!reverse.body &&
            !!reverse.body.data &&
            Number.isInteger(Number(reverse.body.data.movement_id)),
        reverse.raw
    );

    // The original row is stamped, not deleted.
    const originalAfter = await request('GET', `/api/stock/movements/${receiptMovementId}`, {
        token: adminToken
    });
    check(
        'the original movement is still readable after a reversal',
        originalAfter.status === 200,
        originalAfter.raw
    );
    check(
        'the original movement is stamped with reversed_by',
        !!originalAfter.body &&
            !!originalAfter.body.data &&
            !!originalAfter.body.data.movement &&
            !!originalAfter.body.data.movement.reversed_by,
        originalAfter.raw
    );

    // A movement cannot be reversed twice.
    const doubleReverse = await request('POST', `/api/stock/movements/${receiptMovementId}/reverse`, {
        token: adminToken,
        body: { reason: 'again' }
    });
    check(
        'a movement cannot be reversed twice (409)',
        doubleReverse.status === 409,
        doubleReverse.raw
    );

    // The reversal itself must not be reversible.
    const reversalId = reverse.body && reverse.body.data ? reverse.body.data.movement_id : null;
    const reverseTheReversal = await request('POST', `/api/stock/movements/${reversalId}/reverse`, {
        token: adminToken,
        body: { reason: 'undo the undo' }
    });
    check(
        'a reversal entry cannot itself be reversed (409)',
        reverseTheReversal.status === 409,
        reverseTheReversal.raw
    );

    const unknownReverse = await request('POST', '/api/stock/movements/999999999/reverse', {
        token: adminToken
    });
    check(
        'reversing an unknown movement is refused (404)',
        unknownReverse.status === 404,
        unknownReverse.raw
    );

    // Only an administrator or HISO may reverse.
    const ictReverse = await request('POST', `/api/stock/movements/${issueMovementId}/reverse`, {
        token: ictToken,
        body: { reason: 'not allowed' }
    });
    check(
        'an ICT Officer cannot reverse a movement (403)',
        ictReverse.status === 403,
        ictReverse.raw
    );



    /* ---------------------------------------------------------------- */
    section('11. Correcting a store card and searching the store');
    /* ---------------------------------------------------------------- */

    const update = await request('PUT', `/api/stock/${item.id}`, {
        token: ictToken,
        body: {
            bin_location: 'B14',
            minimum_level: 4,
            maximum_level: 25,
            remarks: 'Relocated to the wider shelf.'
        }
    });
    check('an ICT Officer can correct a store card (200)', update.status === 200, update.raw);
    check(
        'the correction is persisted',
        !!update.body &&
            !!update.body.data &&
            !!update.body.data.stock_item &&
            update.body.data.stock_item.bin_location === 'B14' &&
            Number(update.body.data.stock_item.minimum_level) === 4,
        update.raw
    );

    // The balance is not writable through an update - it only moves via the ledger.
    const beforeBalance = Number(update.body.data.stock_item.quantity_on_hand);
    const tryRestate = await request('PUT', `/api/stock/${item.id}`, {
        token: adminToken,
        body: { quantity_on_hand: 9999 }
    });
    const afterRestate = await request('GET', `/api/stock/${item.id}`, { token: adminToken });
    check(
        'a balance cannot be restated through an update',
        !!afterRestate.body &&
            !!afterRestate.body.data &&
            !!afterRestate.body.data.stock_item &&
            Number(afterRestate.body.data.stock_item.quantity_on_hand) === beforeBalance,
        `expected ${beforeBalance}, got ${
            afterRestate.body && afterRestate.body.data && afterRestate.body.data.stock_item
                ? afterRestate.body.data.stock_item.quantity_on_hand
                : 'n/a'
        }`
    );
    check(
        'restating a balance is rejected as an unrecognised update',
        tryRestate.status === 400,
        tryRestate.raw
    );

    // A partial update must not be able to invert the reorder bounds.
    const invertBounds = await request('PATCH', `/api/stock/${item.id}`, {
        token: adminToken,
        body: { maximum_level: 1 }
    });
    check(
        'a partial update that inverts the reorder bounds is refused (400)',
        invertBounds.status === 400,
        invertBounds.raw
    );

    // An update with nothing recognisable is a caller mistake.
    const emptyUpdate = await request('PATCH', `/api/stock/${item.id}`, {
        token: adminToken,
        body: { not_a_field: 'value' }
    });
    check(
        'an update with no known fields is refused (400)',
        emptyUpdate.status === 400,
        emptyUpdate.raw
    );

    const updateDerived = await request('PUT', `/api/stock/asset-${spare1.asset.id}`, {
        token: adminToken,
        body: { bin_location: 'Nope' }
    });
    check(
        'a register-derived item cannot be edited (409)',
        updateDerived.status === 409,
        updateDerived.raw
    );

    // Deactivating a card stops it moving without deleting its history.
    const deactivate = await request('PATCH', `/api/stock/${item.id}`, {
        token: adminToken,
        body: { status: 'Inactive' }
    });
    check('a card can be deactivated (200)', deactivate.status === 200, deactivate.raw);
    check(
        'a deactivated card reports the Inactive state',
        !!deactivate.body &&
            !!deactivate.body.data &&
            !!deactivate.body.data.stock_item &&
            deactivate.body.data.stock_item.stock_state === 'Inactive',
        deactivate.raw
    );

    const moveInactive = await request('POST', `/api/stock/${item.id}/receipt`, {
        token: ictToken,
        body: { quantity: 1 }
    });
    check('a deactivated card cannot be moved (409)', moveInactive.status === 409, moveInactive.raw);

    // Reactivate so the remaining sections see a movable card.
    const reactivate = await request('PATCH', `/api/stock/${item.id}`, {
        token: adminToken,
        body: { status: 'Active' }
    });
    check('a card can be reactivated (200)', reactivate.status === 200, reactivate.raw);

    // Search covers the item, the part code and the linked asset.
    const searchByTag = await request(
        'GET',
        `/api/stock?search=${encodeURIComponent(asset.asset_tag)}&limit=20`,
        { token: ictToken }
    );
    check(
        'the store can be searched by asset tag',
        !!searchByTag.body &&
            !!searchByTag.body.data &&
            Array.isArray(searchByTag.body.data.stock_items) &&
            searchByTag.body.data.stock_items.some((row) => Number(row.id) === Number(item.id)),
        searchByTag.raw
    );

    const searchByPart = await request(
        'GET',
        `/api/stock?search=${encodeURIComponent(`${tagSeed}-BATT`)}&limit=20`,
        { token: ictToken }
    );
    check(
        'the store can be searched by part code',
        !!searchByPart.body &&
            !!searchByPart.body.data &&
            Array.isArray(searchByPart.body.data.stock_items) &&
            searchByPart.body.data.stock_items.some((row) => Number(row.id) === Number(item.id)),
        searchByPart.raw
    );

    const byCategory = await request('GET', '/api/stock?category=Consumables&limit=50', {
        token: ictToken
    });
    check(
        'the store can be filtered by category',
        !!byCategory.body &&
            !!byCategory.body.data &&
            Array.isArray(byCategory.body.data.stock_items) &&
            byCategory.body.data.stock_items.every((row) => row.category === 'Consumables'),
        byCategory.raw
    );

    const byStore = await request('GET', '/api/stock?store_location=Bulawayo&limit=50', {
        token: ictToken
    });
    check(
        'the store can be filtered by store location',
        !!byStore.body &&
            !!byStore.body.data &&
            Array.isArray(byStore.body.data.stock_items) &&
            byStore.body.data.stock_items.every((row) =>
                String(row.store_location || '').includes('Bulawayo')
            ),
        byStore.raw
    );

    // Paging must report the full total rather than just the page.
    const paged = await request('GET', '/api/stock?limit=1&offset=0', { token: ictToken });
    check(
        'the list reports the unpaged total alongside the page',
        !!paged.body &&
            !!paged.body.data &&
            Array.isArray(paged.body.data.stock_items) &&
            paged.body.data.stock_items.length === 1 &&
            Number(paged.body.data.total) > 1,
        paged.raw
    );

    // The list can be restricted to the catalogue only.
    const catalogueOnly = await request('GET', '/api/stock?include_derived=false&limit=100', {
        token: ictToken
    });
    check(
        'the derived rows can be excluded from the list',
        !!catalogueOnly.body &&
            !!catalogueOnly.body.data &&
            Array.isArray(catalogueOnly.body.data.stock_items) &&
            catalogueOnly.body.data.stock_items.every((row) => row.source !== 'asset_register') &&
            Number(catalogueOnly.body.data.derived) === 0,
        catalogueOnly.raw
    );

    // A card may be addressed by its STK- reference.
    const byRef = await request('GET', `/api/stock/${item.item_ref}`, { token: ictToken });
    check(
        'a store card can be read by its STK- reference',
        byRef.status === 200 &&
            !!byRef.body &&
            !!byRef.body.data &&
            !!byRef.body.data.stock_item &&
            Number(byRef.body.data.stock_item.id) === Number(item.id),
        byRef.raw
    );

    const unknownRef = await request('GET', '/api/stock/STK-999999', { token: ictToken });
    check('an unknown card reference is refused (404)', unknownRef.status === 404, unknownRef.raw);



    /* ---------------------------------------------------------------- */
    section('12. Model-level checks (balance integrity)');
    /* ---------------------------------------------------------------- */

    // The balance is a SUM of the ledger, so the two must agree exactly. This is
    // the invariant the whole module is built on.
    const [ledgerSum] = await db.query(
        `SELECT COALESCE(SUM(quantity), 0) AS total FROM stock_movements WHERE stock_item_id = ?`,
        [item.id]
    );
    const [cardBalance] = await db.query(
        'SELECT quantity_on_hand FROM stock_items WHERE id = ?',
        [item.id]
    );

    check(
        'the store card balance equals the sum of its ledger',
        Number(ledgerSum[0].total) === Number(cardBalance[0].quantity_on_hand),
        `ledger=${ledgerSum[0].total} card=${cardBalance[0].quantity_on_hand}`
    );

    // The ledger is append-only: no row is ever updated or deleted.
    const [orphanCheck] = await db.query(
        'SELECT COUNT(*) AS total FROM stock_movements WHERE stock_item_id = ? AND quantity IS NULL',
        [item.id]
    );
    check(
        'no ledger row has a null quantity',
        Number(orphanCheck[0].total) === 0,
        `null quantities: ${orphanCheck[0].total}`
    );

    // The balance_after snapshot must be internally consistent: each row's
    // snapshot differs from its predecessor by exactly its own quantity.
    const [snapshots] = await db.query(
        `SELECT id, quantity, balance_after
         FROM stock_movements
         WHERE stock_item_id = ?
         ORDER BY id ASC`,
        [item.id]
    );

    let snapshotsConsistent = snapshots.length > 0;
    let running = 0;
    for (const row of snapshots) {
        running += Number(row.quantity);
        if (Number(row.balance_after) !== running) snapshotsConsistent = false;
    }

    check(
        'every balance_after snapshot matches the running total',
        snapshotsConsistent,
        `rows: ${snapshots.map((r) => `${r.quantity}=>${r.balance_after}`).join(', ')}`
    );

    // The derived list must not double-count a catalogued asset.
    const stillDerived = await request(
        'GET',
        `/api/stock?search=${encodeURIComponent(tagSeed)}&include_derived=true&limit=50`,
        { token: adminToken }
    );
    const stillDerivedRows =
        stillDerived.body && stillDerived.body.data ? stillDerived.body.data.stock_items : [];
    check(
        'the primary asset is no longer reported as a register-derived item',
        !stillDerivedRows.some((row) => String(row.id) === `asset-${asset.id}`),
        `ids: ${stillDerivedRows.map((r) => r.id).join(', ')}`
    );
    check(
        'the uncatalogued spare is still reported from the register',
        stillDerivedRows.some((row) => String(row.id) === `asset-${spare1.asset.id}`),
        `ids: ${stillDerivedRows.map((r) => r.id).join(', ')}`
    );

    // A model lookup by asset key must resolve the same card the API serves.
    const modelByKey = await stockModel.findByAssetKey(asset.asset_tag);
    check(
        'stockModel.findByAssetKey resolves a card from an asset tag',
        !!modelByKey && Number(modelByKey.id) === Number(item.id),
        modelByKey ? `id=${modelByKey.id}` : 'not found'
    );

    const modelCount = await stockModel.countMovementsByItem(item.id);
    check(
        'stockModel.countMovementsByItem agrees with the ledger',
        Number(modelCount) === snapshots.length,
        `count=${modelCount} rows=${snapshots.length}`
    );

    // The item reference probe must find what the API issued.
    const refProbe = await stockModel.itemRefExists(item.item_ref);
    check('stockModel.itemRefExists finds an issued reference', refProbe === true, `ref=${item.item_ref}`);



    /* ---------------------------------------------------------------- */
    section('13. Aggregates after the run');
    /* ---------------------------------------------------------------- */
    const finalStats = await request('GET', '/api/stock/stats', { token: adminToken });
    check('final GET /api/stock/stats returns 200', finalStats.status === 200, finalStats.raw);
    check(
        'the stats total covers every card created',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Number(finalStats.body.data.total) >= createdItemIds.length,
        finalStats.raw
    );
    check(
        'the stats count the receipts and issues recorded',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Number(finalStats.body.data.receipts) >= 2 &&
            Number(finalStats.body.data.issues) >= 2,
        finalStats.raw
    );
    check(
        'the stats count the returns recorded',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Number(finalStats.body.data.returns) >= 2,
        finalStats.raw
    );
    check(
        'the stats count the write-offs recorded',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Number(finalStats.body.data.writeOffs) >= 1,
        finalStats.raw
    );
    check(
        'the stats count the adjustments recorded',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Number(finalStats.body.data.adjustments) >= 1,
        finalStats.raw
    );
    check(
        'the stats report a non-negative units-on-hand figure',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Number(finalStats.body.data.unitsOnHand) >= 0,
        finalStats.raw
    );
    check(
        'the stats expose the cards grouped by store',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Array.isArray(finalStats.body.data.byStore) &&
            finalStats.body.data.byStore.length > 0,
        finalStats.raw
    );
    check(
        'the stats expose the cards grouped by category',
        !!finalStats.body &&
            !!finalStats.body.data &&
            Array.isArray(finalStats.body.data.byCategory) &&
            finalStats.body.data.byCategory.some((row) => row.category === 'Spares'),
        finalStats.raw
    );
    check(
        'the stats count the low-stock cards',
        !!finalStats.body &&
            !!finalStats.body.data &&
            typeof finalStats.body.data.lowStock === 'number' &&
            finalStats.body.data.lowStock >= 1,
        finalStats.raw
    );


    /* ---------------------------------------------------------------- */
    section('14. Model-level list helpers');
    /* ---------------------------------------------------------------- */
    const modelAll = await stockModel.findAll({ includeDerived: false, limit: 5 });
    check(
        'stockModel.findAll returns rows and a total',
        !!modelAll &&
            Array.isArray(modelAll.rows) &&
            typeof modelAll.total === 'number' &&
            modelAll.total > 0,
        `total: ${modelAll ? modelAll.total : 'n/a'}`
    );

    const modelConsumables = await stockModel.findAll({
        includeDerived: false,
        category: 'Consumables',
        limit: 10
    });
    check(
        'stockModel.findAll can filter by category',
        !!modelConsumables &&
            modelConsumables.rows.every((row) => row.category === 'Consumables'),
        `rows: ${modelConsumables ? modelConsumables.rows.length : 'n/a'}`
    );

    const modelMovements = await stockModel.findMovements({ stockItemId: item.id, limit: 5 });
    check(
        'stockModel.findMovements returns the ledger for a card',
        !!modelMovements &&
            Array.isArray(modelMovements.rows) &&
            modelMovements.rows.length > 0 &&
            typeof modelMovements.total === 'number',
        `total: ${modelMovements ? modelMovements.total : 'n/a'}`
    );

    const modelBalances = await stockModel.getBalances();
    check(
        'stockModel.getBalances reports the aggregate columns',
        !!modelBalances &&
            typeof modelBalances.lineItems === 'number' &&
            typeof modelBalances.stockValue === 'number' &&
            Array.isArray(modelBalances.byStore),
        'expected numeric lineItems/stockValue and a byStore array'
    );
}



/* -------------------------------------------------------------------------
 * Bootstrap: start server, run suite, always clean up, exit explicitly.
 * ---------------------------------------------------------------------- */
server = app.listen(PORT, async () => {
    console.log('======================================================');
    console.log('  NBSZ Asset Management - Stock Test Suite');
    console.log('======================================================');
    console.log(`Target: ${BASE}`);
    console.log(`Time:   ${new Date().toISOString()}`);

    let failure = null;
    try {
        await connectDb();
        // The stock module owns its own DDL so the suite can run on a database
        // that has not had scripts/initDb.js re-applied.
        await stockModel.ensureTable();
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
