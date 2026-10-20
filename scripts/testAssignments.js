'use strict';

/**
 * scripts/testAssignments.js
 * ---------------------------------------------------------------------------
 * Standalone smoke/regression test for the Asset Assignment & Custody slice.
 *
 * Boots the real Express app (which also verifies the MySQL connection) on an
 * isolated port, fires real HTTP requests at it, and asserts on the responses.
 * No test-runner dependency is required - run it with:
 *
 *     node scripts/testAssignments.js
 *
 * The suite is self-contained: it creates its own role accounts, category,
 * assets and assignment rows, and hard-deletes everything it created at the end
 * (the API itself never deletes custody rows, by design).
 *
 * Exit code 0 = all checks passed, 1 = at least one check failed.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const app = require('../server');
const assignmentModel = require('../models/assetAssignmentModel');

// Dedicated port so this can run even while the dev server is up.
const PORT = process.env.ASSIGNMENT_TEST_PORT || 3997;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let server = null;

// Ids created during the run, cleaned up at the end.
const createdAssignmentIds = [];
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
 * Removes everything this suite created. Child rows (assignments, audit_logs)
 * must go before the parent users/assets because of the foreign keys.
 */
async function cleanup() {
    if (!db) return;

    try {
        if (createdAssignmentIds.length) {
            await db.query(
                `DELETE FROM audit_logs
                 WHERE table_name = 'asset_assignments' AND record_id IN (?)`,
                [createdAssignmentIds]
            );
            await db.query('DELETE FROM asset_assignments WHERE id IN (?)', [createdAssignmentIds]);
        }

        if (createdAssetIds.length) {
            await db.query('DELETE FROM asset_assignments WHERE asset_id IN (?)', [createdAssetIds]);
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
    const tagSeed = `ASG-${stamp}`;

    let adminToken = null;
    let hisoToken = null;
    let ictToken = null;
    let deptToken = null;
    let auditorToken = null;
    let otherDeptToken = null;

    /* ---------------------------------------------------------------- */
    section('1. Infrastructure');
    /* ---------------------------------------------------------------- */
    const health = await request('GET', '/api/health');
    check('GET /api/health returns 200', health.status === 200, `got ${health.status}`);

    const unauth = await request('GET', '/api/assignments');
    check(
        'GET /api/assignments without a token returns 401',
        unauth.status === 401,
        `${unauth.status} ${unauth.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('2. Test accounts and authentication');
    /* ---------------------------------------------------------------- */
    const adminUser = {
        username: 'asg_admin_test',
        email: 'asg.admin.test@nbsz.co.zw',
        password: 'AsgAdmin@123',
        fullName: 'Assignment Test Administrator',
        role: 'System Administrator'
    };
    const hisoUser = {
        username: 'asg_hiso_test',
        email: 'asg.hiso.test@nbsz.co.zw',
        password: 'AsgHiso@123',
        fullName: 'Assignment Test HISO',
        role: 'HISO'
    };
    const ictUser = {
        username: 'asg_ict_test',
        email: 'asg.ict.test@nbsz.co.zw',
        password: 'AsgIct@123',
        fullName: 'Assignment Test ICT Officer',
        role: 'ICT Officer'
    };
    const deptUser = {
        username: 'asg_dept_test',
        email: 'asg.dept.test@nbsz.co.zw',
        password: 'AsgDept@123',
        fullName: 'Assignment Test Custodian',
        role: 'Departmental User'
    };
    const auditorUser = {
        username: 'asg_auditor_test',
        email: 'asg.auditor.test@nbsz.co.zw',
        password: 'AsgAudit@123',
        fullName: 'Assignment Test Auditor',
        role: 'Auditor'
    };
    const otherDeptUser = {
        username: 'asg_dept2_test',
        email: 'asg.dept2.test@nbsz.co.zw',
        password: 'AsgDept2@123',
        fullName: 'Assignment Test Second Custodian',
        role: 'Departmental User'
    };

    const ids = [];
    for (const user of [adminUser, hisoUser, ictUser, deptUser, auditorUser, otherDeptUser]) {
        ids.push(await ensureUser(user));
    }
    const [adminId, hisoId, ictId, deptId, auditorId, otherDeptId] = ids;
    check('six role test accounts are available', ids.every(Boolean), `ids: ${ids.join(', ')}`);

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
    check('custodian can log in', deptLogin.status === 200 && !!deptToken, deptLogin.raw);

    const auditorLogin = await login(auditorUser);
    auditorToken = auditorLogin.body && auditorLogin.body.data ? auditorLogin.body.data.token : null;
    check('Auditor can log in', auditorLogin.status === 200 && !!auditorToken, auditorLogin.raw);

    const otherLogin = await login(otherDeptUser);
    otherDeptToken = otherLogin.body && otherLogin.body.data ? otherLogin.body.data.token : null;
    check(
        'second custodian can log in',
        otherLogin.status === 200 && !!otherDeptToken,
        otherLogin.raw
    );

    if (!adminToken) {
        throw new Error('Cannot continue without an administrator token.');
    }

    // Expose the ids the later sections need.
    const ctx = { adminId, hisoId, ictId, deptId, auditorId, otherDeptId };

    /* ---------------------------------------------------------------- */
    section('3. Fixtures: category and assets');
    /* ---------------------------------------------------------------- */
    const categoryName = `Assignment Category ${tagSeed}`;
    const createCategory = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: categoryName, description: 'Created by the assignment test suite.' }
    });
    const categoryId =
        createCategory.body && createCategory.body.data && createCategory.body.data.category
            ? createCategory.body.data.category.id
            : null;
    if (categoryId) createdCategoryIds.push(categoryId);
    check('a test asset category was created', !!categoryId, createCategory.raw);

    const createAsset = async (suffix, extra = {}) => {
        const res = await request('POST', '/api/assets', {
            token: ictToken,
            body: {
                asset_tag: `${tagSeed}-${suffix}`,
                serial_number: `SN-${tagSeed}-${suffix}`,
                category_id: categoryId,
                manufacturer: 'Test Manufacturer',
                model: 'Test Model',
                location: 'Head Office',
                department: 'ICT',
                ...extra
            }
        });
        const asset = res.body && res.body.data ? res.body.data.asset : null;
        if (asset) createdAssetIds.push(asset.id);
        return { res, asset };
    };

    const assetA = await createAsset('A-001');
    const assetB = await createAsset('B-002');
    const assetC = await createAsset('C-003');
    check(
        'three test assets were registered',
        !!(assetA.asset && assetB.asset && assetC.asset),
        assetA.res.raw
    );
    check(
        'a fresh asset starts out "In Stock" and unassigned',
        !!(assetA.asset && assetA.asset.status === 'In Stock' && !assetA.asset.assigned_user_id),
        assetA.asset ? `${assetA.asset.status} / ${assetA.asset.assigned_user_id}` : 'no asset'
    );

    if (!assetA.asset || !assetB.asset) {
        throw new Error('Cannot continue without test assets.');
    }

    /* ---------------------------------------------------------------- */
    section('4. Creating an assignment');
    /* ---------------------------------------------------------------- */
    const assignA = await request('POST', '/api/assignments', {
        token: ictToken,
        body: {
            asset_id: assetA.asset.id,
            assigned_user_id: ctx.deptId,
            department: 'ICT',
            location: 'Head Office - 2nd Floor',
            responsible_officer: 'Assignment Test Officer',
            purpose: 'Field work laptop',
            remarks: 'Handed over in person.',
            assignment_date: '2026-01-15',
            expected_return_date: '2026-12-31'
        }
    });
    check(
        'POST /api/assignments assigns an asset (201)',
        assignA.status === 201,
        `${assignA.status} ${assignA.raw}`
    );

    const assignment = assignA.body && assignA.body.data ? assignA.body.data.assignment : null;
    if (assignment) createdAssignmentIds.push(assignment.id);

    check('the new assignment has a database id', !!(assignment && assignment.id), assignA.raw);
    check(
        'the assignment links back to the asset',
        !!(assignment && Number(assignment.asset_id) === Number(assetA.asset.id)),
        assignment ? String(assignment.asset_id) : 'none'
    );
    check(
        'the assignment records the custodian',
        !!(assignment && Number(assignment.assigned_user_id) === ctx.deptId),
        assignment ? String(assignment.assigned_user_id) : 'none'
    );
    check(
        'assigned_to_name defaults to the custodian full name',
        !!(assignment && assignment.assigned_to_name === deptUser.fullName),
        assignment ? String(assignment.assigned_to_name) : 'none'
    );
    check(
        'the assignment starts as Active and unacknowledged',
        !!(assignment && assignment.status === 'Active' && !assignment.acknowledged_at),
        assignment ? `${assignment.status} / ${assignment.acknowledged_at}` : 'none'
    );
    check(
        'joined asset code, tag and category come back with the assignment',
        !!(
            assignment &&
            assignment.asset_code === assetA.asset.asset_id &&
            assignment.asset_tag === assetA.asset.asset_tag &&
            assignment.category_name === categoryName
        ),
        assignment ? `${assignment.asset_code} / ${assignment.category_name}` : 'none'
    );
    check(
        'the acting officer is recorded as assigned_by',
        !!(assignment && Number(assignment.assigned_by) === ctx.ictId),
        assignment ? String(assignment.assigned_by) : 'none'
    );
    check(
        'dates are preserved as supplied',
        !!(
            assignment &&
            isoDay(assignment.assignment_date) === '2026-01-15' &&
            isoDay(assignment.expected_return_date) === '2026-12-31'
        ),
        assignment
            ? `${isoDay(assignment.assignment_date)} -> ${isoDay(assignment.expected_return_date)}`
            : 'none'
    );

    // The register should now reflect the custody.
    const assetAfterAssign = assignA.body && assignA.body.data ? assignA.body.data.asset : null;
    check(
        'assigning flips the asset to "In Use"',
        !!(assetAfterAssign && assetAfterAssign.status === 'In Use'),
        assetAfterAssign ? String(assetAfterAssign.status) : 'none'
    );
    check(
        'assigning mirrors the custodian onto the asset row',
        !!(assetAfterAssign && Number(assetAfterAssign.assigned_user_id) === ctx.deptId),
        assetAfterAssign ? String(assetAfterAssign.assigned_user_id) : 'none'
    );
    check(
        'assigning mirrors the custodian name onto the asset row',
        !!(assetAfterAssign && assetAfterAssign.assigned_full_name === deptUser.fullName),
        assetAfterAssign ? String(assetAfterAssign.assigned_full_name) : 'none'
    );

    /* ------------------------- Validation and conflicts -------------------- */

    const noCustodian = await request('POST', '/api/assignments', {
        token: adminToken,
        body: { asset_id: assetB.asset.id }
    });
    check(
        'assigning without a custodian returns 400 with field errors',
        noCustodian.status === 400 &&
            Array.isArray(noCustodian.body && noCustodian.body.errors),
        `${noCustodian.status} ${noCustodian.raw}`
    );

    const unknownAsset = await request('POST', '/api/assignments', {
        token: adminToken,
        body: { asset_id: 'NBSZ-DOES-NOT-EXIST', assigned_user_id: ctx.deptId }
    });
    check(
        'assigning an unknown asset returns 404',
        unknownAsset.status === 404,
        `${unknownAsset.status} ${unknownAsset.raw}`
    );

    const unknownUser = await request('POST', '/api/assignments', {
        token: adminToken,
        body: { asset_id: assetB.asset.id, assigned_user_id: 99999999 }
    });
    check(
        'assigning to a non-existent custodian returns 400',
        unknownUser.status === 400,
        `${unknownUser.status} ${unknownUser.raw}`
    );

    const doubleAssign = await request('POST', '/api/assignments', {
        token: adminToken,
        body: { asset_id: assetA.asset.id, assigned_user_id: ctx.adminId }
    });
    check(
        'assigning an already-assigned asset returns 409',
        doubleAssign.status === 409,
        `${doubleAssign.status} ${doubleAssign.raw}`
    );

    const badDates = await request('POST', '/api/assignments', {
        token: adminToken,
        body: {
            asset_id: assetB.asset.id,
            assigned_user_id: ctx.deptId,
            assignment_date: '2026-06-01',
            expected_return_date: '2026-01-01'
        }
    });
    check(
        'an expected return date before the assignment date returns 400',
        badDates.status === 400,
        `${badDates.status} ${badDates.raw}`
    );

    const assignAsDept = await request('POST', '/api/assignments', {
        token: deptToken,
        body: { asset_id: assetB.asset.id, assigned_user_id: ctx.deptId }
    });
    check(
        'a Departmental User cannot create an assignment (403)',
        assignAsDept.status === 403,
        `${assignAsDept.status} ${assignAsDept.raw}`
    );

    const assignAsAuditor = await request('POST', '/api/assignments', {
        token: auditorToken,
        body: { asset_id: assetB.asset.id, assigned_user_id: ctx.deptId }
    });
    check(
        'an Auditor cannot create an assignment (403)',
        assignAsAuditor.status === 403,
        `${assignAsAuditor.status} ${assignAsAuditor.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('5. Reading assignments');
    /* ---------------------------------------------------------------- */
    const getOne = await request('GET', `/api/assignments/${assignment.id}`, {
        token: auditorToken
    });
    check(
        'GET /api/assignments/:id returns 200 for an Auditor',
        getOne.status === 200,
        `${getOne.status} ${getOne.raw}`
    );

    const missingOne = await request('GET', '/api/assignments/99999999', { token: adminToken });
    check(
        'an unknown assignment id returns 404',
        missingOne.status === 404,
        `${missingOne.status} ${missingOne.raw}`
    );

    const badId = await request('GET', '/api/assignments/not-a-number', { token: adminToken });
    check(
        'a non-numeric assignment id returns 400',
        badId.status === 400,
        `${badId.status} ${badId.raw}`
    );

    const listAll = await request('GET', '/api/assignments?limit=100', { token: adminToken });
    check(
        'GET /api/assignments returns 200 with pagination',
        listAll.status === 200 &&
            !!(listAll.body && listAll.body.data && listAll.body.data.pagination),
        `${listAll.status} ${listAll.raw}`
    );

    const listAsIct = await request('GET', '/api/assignments?limit=10', { token: ictToken });
    check(
        'an ICT Officer can list assignments',
        listAsIct.status === 200,
        `${listAsIct.status} ${listAsIct.raw}`
    );

    const activeList = await request('GET', '/api/assignments/active', { token: adminToken });
    check(
        'GET /api/assignments/active lists the open custody',
        activeList.status === 200 &&
            !!(activeList.body && activeList.body.data) &&
            activeList.body.data.assignments.some((row) => Number(row.id) === Number(assignment.id)),
        `${activeList.status} ${activeList.raw}`
    );
    check(
        'every row in the active list is still open',
        !!(activeList.body && activeList.body.data) &&
            activeList.body.data.assignments.every((row) => !row.released_at),
        activeList.raw
    );

    const pendingList = await request('GET', '/api/assignments/pending', { token: adminToken });
    check(
        'GET /api/assignments/pending lists unacknowledged custody',
        pendingList.status === 200 &&
            !!(pendingList.body && pendingList.body.data) &&
            pendingList.body.data.assignments.some(
                (row) => Number(row.id) === Number(assignment.id)
            ),
        `${pendingList.status} ${pendingList.raw}`
    );

    const overdueList = await request('GET', '/api/assignments/overdue', { token: adminToken });
    check(
        'GET /api/assignments/overdue returns 200 with an as_of date',
        overdueList.status === 200 &&
            !!(overdueList.body && overdueList.body.data && overdueList.body.data.as_of),
        `${overdueList.status} ${overdueList.raw}`
    );
    check(
        'the assignment with a future return date is NOT overdue',
        !!(overdueList.body && overdueList.body.data) &&
            !overdueList.body.data.assignments.some(
                (row) => Number(row.id) === Number(assignment.id)
            ),
        overdueList.raw
    );

    const stats = await request('GET', '/api/assignments/stats', { token: adminToken });
    check(
        'GET /api/assignments/stats returns aggregate counts',
        stats.status === 200 &&
            !!(stats.body && stats.body.data) &&
            typeof stats.body.data.active === 'number' &&
            Array.isArray(stats.body.data.byStatus),
        `${stats.status} ${stats.raw}`
    );

    const meta = await request('GET', '/api/assignments/meta', { token: ictToken });
    check(
        'GET /api/assignments/meta returns the status list and custodian pick-list',
        meta.status === 200 &&
            !!(meta.body && meta.body.data) &&
            Array.isArray(meta.body.data.statuses) &&
            Array.isArray(meta.body.data.users) &&
            meta.body.data.users.some((u) => Number(u.id) === ctx.deptId),
        `${meta.status} ${meta.raw}`
    );
    check(
        'the meta status list matches the schema ENUM',
        !!(meta.body && meta.body.data) &&
            ['Active', 'Returned', 'Transferred', 'Cancelled'].every((s) =>
                meta.body.data.statuses.includes(s)
            ),
        meta.raw
    );

    const metaAsAuditor = await request('GET', '/api/assignments/meta', { token: auditorToken });
    check(
        'an Auditor cannot read assignment meta (403)',
        metaAsAuditor.status === 403,
        `${metaAsAuditor.status} ${metaAsAuditor.raw}`
    );

    /* By asset ------------------------------------------------------------- */
    const byAsset = await request('GET', `/api/assignments/asset/${assetA.asset.id}`, {
        token: adminToken
    });
    check(
        'GET /api/assignments/asset/:id returns the current custody',
        byAsset.status === 200 &&
            !!(byAsset.body && byAsset.body.data) &&
            byAsset.body.data.assigned === true &&
            Number(byAsset.body.data.assignment.id) === Number(assignment.id),
        `${byAsset.status} ${byAsset.raw}`
    );

    const byAssetCode = await request('GET', `/api/assignments/asset/${assetA.asset.asset_id}`, {
        token: adminToken
    });
    check(
        'a generated asset code resolves to the same custody record',
        byAssetCode.status === 200 &&
            !!(byAssetCode.body && byAssetCode.body.data) &&
            byAssetCode.body.data.assigned === true,
        `${byAssetCode.status} ${byAssetCode.raw}`
    );

    const byAssetTag = await request('GET', `/api/assignments/asset/${assetA.asset.asset_tag}`, {
        token: adminToken
    });
    check(
        'a physical asset tag resolves to the same custody record',
        byAssetTag.status === 200 &&
            !!(byAssetTag.body && byAssetTag.body.data) &&
            byAssetTag.body.data.assigned === true,
        `${byAssetTag.status} ${byAssetTag.raw}`
    );

    const unassignedAsset = await request('GET', `/api/assignments/asset/${assetC.asset.id}`, {
        token: adminToken
    });
    check(
        'an unassigned asset reports assigned=false without an error',
        unassignedAsset.status === 200 &&
            !!(unassignedAsset.body && unassignedAsset.body.data) &&
            unassignedAsset.body.data.assigned === false &&
            unassignedAsset.body.data.assignment === null,
        `${unassignedAsset.status} ${unassignedAsset.raw}`
    );

    const history = await request('GET', `/api/assignments/asset/${assetA.asset.id}/history`, {
        token: auditorToken
    });
    check(
        'GET /api/assignments/asset/:id/history returns the custody history',
        history.status === 200 &&
            !!(history.body && history.body.data) &&
            history.body.data.history.length >= 1,
        `${history.status} ${history.raw}`
    );

    /* By custodian --------------------------------------------------------- */
    const byUser = await request('GET', `/api/assignments/user/${ctx.deptId}`, {
        token: adminToken
    });
    check(
        'GET /api/assignments/user/:userId returns that custodian holdings',
        byUser.status === 200 &&
            !!(byUser.body && byUser.body.data) &&
            byUser.body.data.assignments.some((row) => Number(row.id) === Number(assignment.id)),
        `${byUser.status} ${byUser.raw}`
    );

    const byUserActive = await request(
        'GET',
        `/api/assignments/user/${ctx.deptId}?active_only=true`,
        { token: adminToken }
    );
    check(
        'active_only=true filters to current holdings',
        byUserActive.status === 200 &&
            !!(byUserActive.body && byUserActive.body.data) &&
            byUserActive.body.data.assignments.every((row) => !row.released_at),
        `${byUserActive.status} ${byUserActive.raw}`
    );

    /* Departmental User scoping -------------------------------------------- */
    const deptSeesOwn = await request('GET', '/api/assignments?limit=100', { token: deptToken });
    check(
        'a Departmental User only sees their own assignments',
        deptSeesOwn.status === 200 &&
            !!(deptSeesOwn.body && deptSeesOwn.body.data) &&
            deptSeesOwn.body.data.assignments.every(
                (row) => Number(row.assigned_user_id) === ctx.deptId
            ),
        `${deptSeesOwn.status} ${deptSeesOwn.raw}`
    );

    const otherCustody = await request('GET', `/api/assignments/asset/${assetA.asset.id}`, {
        token: otherDeptToken
    });
    check(
        'a Departmental User cannot read another custodian asset assignment (404)',
        otherCustody.status === 404,
        otherCustody.raw
    );
    const otherCustodyHistory = await request('GET', `/api/assignments/asset/${assetA.asset.id}/history`, {
        token: otherDeptToken
    });
    check(
        'a Departmental User cannot read another custodian assignment history (404)',
        otherCustodyHistory.status === 404,
        otherCustodyHistory.raw
    );

    const deptAsksOther = await request('GET', `/api/assignments/user/${ctx.otherDeptId}`, {
        token: deptToken
    });
    check(
        'a Departmental User cannot read another custodian holdings (403)',
        deptAsksOther.status === 403,
        `${deptAsksOther.status} ${deptAsksOther.raw}`
    );

    const otherSeesOwn = await request('GET', `/api/assignments/${assignment.id}`, {
        token: otherDeptToken
    });

    /* ---------------------------------------------------------------- */
    section('6. Acknowledgement of receipt');
    /* ---------------------------------------------------------------- */
    const ackByOther = await request(
        'PATCH',
        `/api/assignments/${assignment.id}/acknowledge`,
        { token: otherDeptToken, body: { remarks: 'Not mine' } }
    );
    check(
        'a different custodian cannot acknowledge the assignment (403)',
        ackByOther.status === 403,
        `${ackByOther.status} ${ackByOther.raw}`
    );

    const ackByDept = await request('PATCH', `/api/assignments/${assignment.id}/acknowledge`, {
        token: deptToken,
        body: { remarks: 'Received in good order.' }
    });
    check(
        'the custodian can acknowledge their own assignment (200)',
        ackByDept.status === 200,
        `${ackByDept.status} ${ackByDept.raw}`
    );

    const acked =
        ackByDept.body && ackByDept.body.data ? ackByDept.body.data.assignment : null;
    check(
        'the acknowledgement timestamp is recorded',
        !!(acked && acked.acknowledged_at),
        acked ? String(acked.acknowledged_at) : 'none'
    );
    check(
        'the acknowledging user is recorded',
        !!(acked && Number(acked.acknowledged_by) === ctx.deptId),
        acked ? String(acked.acknowledged_by) : 'none'
    );
    check(
        'the acknowledgement remarks are stored',
        !!(acked && acked.acknowledged_remarks === 'Received in good order.'),
        acked ? String(acked.acknowledged_remarks) : 'none'
    );
    check(
        'the joined acknowledger name comes back',
        !!(acked && acked.acknowledged_by_name === deptUser.fullName),
        acked ? String(acked.acknowledged_by_name) : 'none'
    );

    const ackTwice = await request('PATCH', `/api/assignments/${assignment.id}/acknowledge`, {
        token: deptToken
    });
    check(
        'acknowledging twice returns 409',
        ackTwice.status === 409,
        `${ackTwice.status} ${ackTwice.raw}`
    );

    const pendingAfterAck = await request('GET', '/api/assignments/pending', {
        token: adminToken
    });
    check(
        'an acknowledged assignment leaves the pending list',
        !!(pendingAfterAck.body && pendingAfterAck.body.data) &&
            !pendingAfterAck.body.data.assignments.some(
                (row) => Number(row.id) === Number(assignment.id)
            ),
        pendingAfterAck.raw
    );

    const ackAsAuditor = await request('PATCH', `/api/assignments/${assignment.id}/acknowledge`, {
        token: auditorToken
    });
    check(
        'an Auditor cannot acknowledge receipt (403)',
        ackAsAuditor.status === 403,
        `${ackAsAuditor.status} ${ackAsAuditor.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('7. Correcting assignment details');
    /* ---------------------------------------------------------------- */
    const patchDetails = await request('PUT', `/api/assignments/${assignment.id}`, {
        token: ictToken,
        body: {
            location: 'Head Office - Ground Floor',
            purpose: 'Field work laptop (revised)',
            expected_return_date: '2027-01-31'
        }
    });
    check(
        'PUT /api/assignments/:id updates the descriptive fields (200)',
        patchDetails.status === 200,
        `${patchDetails.status} ${patchDetails.raw}`
    );
    check(
        'the changed values are persisted',
        !!(patchDetails.body &&
            patchDetails.body.data &&
            patchDetails.body.data.assignment.location === 'Head Office - Ground Floor' &&
            isoDay(patchDetails.body.data.assignment.expected_return_date) === '2027-01-31'),
        patchDetails.raw
    );
    check(
        'the response reports which fields changed',
        !!(patchDetails.body &&
            patchDetails.body.data &&
            Array.isArray(patchDetails.body.data.changed_fields) &&
            patchDetails.body.data.changed_fields.includes('location')),
        patchDetails.raw
    );

    const patchCustodian = await request('PUT', `/api/assignments/${assignment.id}`, {
        token: adminToken,
        body: { assigned_user_id: ctx.adminId }
    });
    check(
        'changing the custodian via PUT is refused (400) - use transfer',
        patchCustodian.status === 400,
        `${patchCustodian.status} ${patchCustodian.raw}`
    );

    const patchAsset = await request('PUT', `/api/assignments/${assignment.id}`, {
        token: adminToken,
        body: { asset_id: assetB.asset.id }
    });
    check(
        'changing the asset of an assignment is refused (400)',
        patchAsset.status === 400,
        `${patchAsset.status} ${patchAsset.raw}`
    );

    const patchEmpty = await request('PUT', `/api/assignments/${assignment.id}`, {
        token: adminToken,
        body: {}
    });
    check(
        'an empty update body returns 400',
        patchEmpty.status === 400,
        `${patchEmpty.status} ${patchEmpty.raw}`
    );

    const patchBadDate = await request('PUT', `/api/assignments/${assignment.id}`, {
        token: adminToken,
        body: { expected_return_date: 'not-a-date' }
    });
    check(
        'an invalid date returns 400',
        patchBadDate.status === 400,
        `${patchBadDate.status} ${patchBadDate.raw}`
    );

    // The assignment_date is 2026-01-15, so an earlier return date is invalid.
    const patchEarlierDate = await request('PUT', `/api/assignments/${assignment.id}`, {
        token: adminToken,
        body: { expected_return_date: '2025-12-31' }
    });
    check(
        'a return date earlier than the stored assignment date is refused',
        patchEarlierDate.status === 400,
        `${patchEarlierDate.status} ${patchEarlierDate.raw}`
    );

    const patchAsAuditor = await request('PUT', `/api/assignments/${assignment.id}`, {
        token: auditorToken,
        body: { location: 'Should not change' }
    });
    check(
        'an Auditor cannot update an assignment (403)',
        patchAsAuditor.status === 403,
        `${patchAsAuditor.status} ${patchAsAuditor.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('8. Transfer (history must be preserved)');
    /* ---------------------------------------------------------------- */
    const transferSameCustodian = await request(
        'PATCH',
        `/api/assignments/${assignment.id}/transfer`,
        { token: adminToken, body: { assigned_user_id: ctx.deptId } }
    );
    check(
        'transferring to the current custodian is refused (400)',
        transferSameCustodian.status === 400,
        `${transferSameCustodian.status} ${transferSameCustodian.raw}`
    );

    const transferNoCustodian = await request(
        'PATCH',
        `/api/assignments/${assignment.id}/transfer`,
        { token: adminToken, body: { remarks: 'no custodian supplied' } }
    );
    check(
        'transferring without a receiving custodian is refused (400)',
        transferNoCustodian.status === 400,
        `${transferNoCustodian.status} ${transferNoCustodian.raw}`
    );

    const transfer = await request('PATCH', `/api/assignments/${assignment.id}/transfer`, {
        token: ictToken,
        body: {
            assigned_user_id: ctx.otherDeptId,
            location: 'Bulawayo Branch',
            department: 'Operations',
            purpose: 'Regional deployment',
            assignment_date: '2026-07-01',
            expected_return_date: '2027-06-30',
            release_reason: 'Reassigned to the Operations team'
        }
    });
    check(
        'PATCH /:id/transfer hands the asset to a new custodian (201)',
        transfer.status === 201,
        `${transfer.status} ${transfer.raw}`
    );

    const transferData = transfer.body && transfer.body.data ? transfer.body.data : null;
    const newAssignment = transferData ? transferData.assignment : null;
    const oldAssignment = transferData ? transferData.previous_assignment : null;
    if (newAssignment) createdAssignmentIds.push(newAssignment.id);

    check(
        'the transfer returns both the closed and the new row',
        !!(newAssignment && oldAssignment),
        transfer.raw
    );
    check(
        'the previous row is closed with status "Transferred"',
        !!(oldAssignment && oldAssignment.status === 'Transferred' && oldAssignment.released_at),
        oldAssignment ? `${oldAssignment.status} / ${oldAssignment.released_at}` : 'none'
    );
    check(
        'the previous row keeps its original custodian (history intact)',
        !!(oldAssignment && Number(oldAssignment.assigned_user_id) === ctx.deptId),
        oldAssignment ? String(oldAssignment.assigned_user_id) : 'none'
    );
    check(
        'the previous row keeps its original assignment date',
        !!(oldAssignment && isoDay(oldAssignment.assignment_date) === '2026-01-15'),
        oldAssignment ? isoDay(oldAssignment.assignment_date) : 'none'
    );
    check(
        'the previous row records the release reason and officer',
        !!(
            oldAssignment &&
            oldAssignment.release_reason &&
            Number(oldAssignment.released_by) === ctx.ictId
        ),
        oldAssignment ? String(oldAssignment.release_reason) : 'none'
    );
    check(
        'the new row is open and Active',
        !!(newAssignment && newAssignment.status === 'Active' && !newAssignment.released_at),
        newAssignment ? `${newAssignment.status} / ${newAssignment.released_at}` : 'none'
    );
    check(
        'the new row names the receiving custodian',
        !!(newAssignment && Number(newAssignment.assigned_user_id) === ctx.otherDeptId),
        newAssignment ? String(newAssignment.assigned_user_id) : 'none'
    );
    check(
        'the new row starts unacknowledged',
        !!(newAssignment && !newAssignment.acknowledged_at),
        newAssignment ? String(newAssignment.acknowledged_at) : 'none'
    );
    check(
        'the asset now shows the new custodian',
        !!(transferData &&
            transferData.asset &&
            Number(transferData.asset.assigned_user_id) === ctx.otherDeptId &&
            transferData.asset.status === 'In Use'),
        transferData && transferData.asset
            ? `${transferData.asset.assigned_user_id} / ${transferData.asset.status}`
            : 'none'
    );

    /* History is the whole point of this section. */
    const historyAfterTransfer = await request(
        'GET',
        `/api/assignments/asset/${assetA.asset.id}/history`,
        { token: auditorToken }
    );
    const historyRows =
        historyAfterTransfer.body && historyAfterTransfer.body.data
            ? historyAfterTransfer.body.data.history
            : [];

    check(
        'the asset history now contains BOTH custody rows',
        historyRows.length >= 2,
        `rows: ${historyRows.length}`
    );
    check(
        'the closed row is still retrievable from the history',
        historyRows.some(
            (row) => Number(row.id) === Number(assignment.id) && row.status === 'Transferred'
        ),
        historyAfterTransfer.raw
    );
    check(
        'the history reports the current assignment id',
        !!(historyAfterTransfer.body &&
            historyAfterTransfer.body.data &&
            Number(historyAfterTransfer.body.data.current_assignment_id) ===
                Number(newAssignment.id)),
        historyAfterTransfer.raw
    );
    check(
        'exactly one row in the history is open',
        historyRows.filter((row) => !row.released_at).length === 1,
        `open rows: ${historyRows.filter((row) => !row.released_at).length}`
    );

    const oldCustodianHoldings = await request(
        'GET',
        `/api/assignments/user/${ctx.deptId}?active_only=true`,
        { token: adminToken }
    );
    check(
        'the previous custodian no longer holds the asset',
        !!(oldCustodianHoldings.body && oldCustodianHoldings.body.data) &&
            !oldCustodianHoldings.body.data.assignments.some(
                (row) => Number(row.id) === Number(assignment.id)
            ),
        oldCustodianHoldings.raw
    );

    /* ---------------------------------------------------------------- */
    section('9. Returning an asset to ICT stores');
    /* ---------------------------------------------------------------- */
    // Assign asset B so the return path is exercised on a fresh record.
    const assignB = await request('POST', '/api/assignments', {
        token: adminToken,
        body: {
            asset_id: assetB.asset.id,
            assigned_user_id: ctx.deptId,
            location: 'Head Office',
            assignment_date: '2026-02-01',
            expected_return_date: '2026-03-01'
        }
    });
    const assignmentB = assignB.body && assignB.body.data ? assignB.body.data.assignment : null;
    if (assignmentB) createdAssignmentIds.push(assignmentB.id);
    check('a second assignment was created for the return test', !!assignmentB, assignB.raw);

    // A past expected return date makes this row show up as overdue.
    const overdueAfter = await request('GET', '/api/assignments/overdue', { token: adminToken });
    check(
        'an open assignment past its return date appears in /overdue',
        !!(overdueAfter.body && overdueAfter.body.data) &&
            overdueAfter.body.data.assignments.some(
                (row) => Number(row.id) === Number(assignmentB.id) && isoDay(row.expected_return_date) === '2026-03-01'
            ),
        overdueAfter.raw
    );

    const badCondition = await request('PATCH', `/api/assignments/${assignmentB.id}/return`, {
        token: adminToken,
        body: { condition_status: 'Broken' }
    });
    check(
        'an invalid condition_status on return returns 400',
        badCondition.status === 400,
        `${badCondition.status} ${badCondition.raw}`
    );

    const returnRes = await request('PATCH', `/api/assignments/${assignmentB.id}/return`, {
        token: ictToken,
        body: {
            condition_status: 'Fair',
            location: 'ICT Store Room',
            release_reason: 'Contract ended'
        }
    });
    check(
        'PATCH /:id/return closes the custody (200)',
        returnRes.status === 200,
        `${returnRes.status} ${returnRes.raw}`
    );

    const returned = returnRes.body && returnRes.body.data ? returnRes.body.data.assignment : null;
    const returnedAsset = returnRes.body && returnRes.body.data ? returnRes.body.data.asset : null;

    check(
        'the returned row is closed with status "Returned"',
        !!(returned && returned.status === 'Returned' && returned.released_at),
        returned ? `${returned.status} / ${returned.released_at}` : 'none'
    );
    check(
        'the return records who released the asset',
        !!(returned && Number(returned.released_by) === ctx.ictId),
        returned ? String(returned.released_by) : 'none'
    );
    check(
        'the return records the release reason',
        !!(returned && returned.release_reason === 'Contract ended'),
        returned ? String(returned.release_reason) : 'none'
    );
    check(
        'the returned row keeps its custodian for the history',
        !!(returned && Number(returned.assigned_user_id) === ctx.deptId),
        returned ? String(returned.assigned_user_id) : 'none'
    );
    check(
        'the asset goes back to "In Stock" and loses its custodian',
        !!(returnedAsset &&
            returnedAsset.status === 'In Stock' &&
            !returnedAsset.assigned_user_id),
        returnedAsset
            ? `${returnedAsset.status} / ${returnedAsset.assigned_user_id}`
            : 'none'
    );
    check(
        'the condition recorded on return is applied to the asset',
        !!(returnedAsset && returnedAsset.condition_status === 'Fair'),
        returnedAsset ? String(returnedAsset.condition_status) : 'none'
    );
    check(
        'the storage location is applied to the asset',
        !!(returnedAsset && returnedAsset.location === 'ICT Store Room'),
        returnedAsset ? String(returnedAsset.location) : 'none'
    );

    const doubleReturn = await request('PATCH', `/api/assignments/${assignmentB.id}/return`, {
        token: adminToken
    });
    check(
        'returning an already-returned assignment returns 409',
        doubleReturn.status === 409,
        `${doubleReturn.status} ${doubleReturn.raw}`
    );

    const reAssignB = await request('POST', '/api/assignments', {
        token: adminToken,
        body: { asset_id: assetB.asset.id, assigned_user_id: ctx.ictId }
    });
    const reAssignedB =
        reAssignB.body && reAssignB.body.data ? reAssignB.body.data.assignment : null;
    if (reAssignedB) createdAssignmentIds.push(reAssignedB.id);
    check(
        'a returned asset can be assigned again',
        reAssignB.status === 201 && !!reAssignedB,
        `${reAssignB.status} ${reAssignB.raw}`
    );

    const historyB = await request('GET', `/api/assignments/asset/${assetB.asset.id}/history`, {
        token: adminToken
    });
    check(
        'the asset history shows both the returned and the new custody',
        !!(historyB.body && historyB.body.data) && historyB.body.data.history.length >= 2,
        historyB.raw
    );

    /* ---------------------------------------------------------------- */
    section('10. Cancelling a mistaken assignment');
    /* ---------------------------------------------------------------- */
    const cancelAsIct = await request('PATCH', `/api/assignments/${reAssignedB.id}/cancel`, {
        token: ictToken
    });
    check(
        'an ICT Officer cannot cancel an assignment (403)',
        cancelAsIct.status === 403,
        `${cancelAsIct.status} ${cancelAsIct.raw}`
    );

    const cancelRes = await request('PATCH', `/api/assignments/${reAssignedB.id}/cancel`, {
        token: hisoToken,
        body: { release_reason: 'Recorded against the wrong asset' }
    });
    check(
        'HISO can cancel a mistaken assignment (200)',
        cancelRes.status === 200,
        `${cancelRes.status} ${cancelRes.raw}`
    );

    const cancelled = cancelRes.body && cancelRes.body.data ? cancelRes.body.data.assignment : null;
    check(
        'the cancelled row is retained with status "Cancelled"',
        !!(cancelled && cancelled.status === 'Cancelled' && cancelled.released_at),
        cancelled ? `${cancelled.status} / ${cancelled.released_at}` : 'none'
    );
    check(
        'the cancellation reason and officer are recorded',
        !!(cancelled &&
            cancelled.release_reason === 'Recorded against the wrong asset' &&
            Number(cancelled.released_by) === ctx.hisoId),
        cancelled ? String(cancelled.release_reason) : 'none'
    );
    check(
        'the cancelled row still exists (never deleted)',
        !!(cancelled && cancelled.id),
        cancelRes.raw
    );

    const doubleCancel = await request('PATCH', `/api/assignments/${reAssignedB.id}/cancel`, {
        token: adminToken
    });
    check(
        'cancelling an already-closed assignment returns 409',
        doubleCancel.status === 409,
        `${doubleCancel.status} ${doubleCancel.raw}`
    );

    const historyAfterCancel = await request(
        'GET',
        `/api/assignments/asset/${assetB.asset.id}/history`,
        { token: auditorToken }
    );
    check(
        'the cancelled row remains in the asset history',
        !!(historyAfterCancel.body && historyAfterCancel.body.data) &&
            historyAfterCancel.body.data.history.some(
                (row) => Number(row.id) === Number(reAssignedB.id) && row.status === 'Cancelled'
            ),
        historyAfterCancel.raw
    );

    /* ---------------------------------------------------------------- */
    section('11. Guard rails: disposed assets');
    /* ---------------------------------------------------------------- */
    const disposeC = await request('DELETE', `/api/assets/${assetC.asset.id}`, {
        token: adminToken,
        body: { condition_status: 'Obsolete' }
    });
    check(
        'asset disposal cannot bypass its approval workflow (409)',
        disposeC.status === 409,
        disposeC.raw
    );

    /* ---------------------------------------------------------------- */
    section('12. Audit trail');
    /* ---------------------------------------------------------------- */
    const auditLogs = await request(
        'GET',
        '/api/auth/audit-logs?table_name=asset_assignments&limit=200',
        { token: adminToken }
    );
    const logs = auditLogs.body && auditLogs.body.data ? auditLogs.body.data.logs || [] : [];

    check(
        'ASSIGN is recorded in the audit trail',
        auditLogs.status === 200 && logs.some((l) => l.action === 'ASSIGN'),
        `${auditLogs.status}`
    );
    check(
        'ACKNOWLEDGE is recorded in the audit trail',
        logs.some((l) => l.action === 'ACKNOWLEDGE'),
        'no ACKNOWLEDGE row'
    );
    check(
        'TRANSFER is recorded in the audit trail',
        logs.some((l) => l.action === 'TRANSFER'),
        'no TRANSFER row'
    );
    check(
        'RETURN is recorded in the audit trail',
        logs.some((l) => l.action === 'RETURN'),
        'no RETURN row'
    );
    check(
        'CANCEL is recorded in the audit trail',
        logs.some((l) => l.action === 'CANCEL'),
        'no CANCEL row'
    );
    check(
        'audit rows carry the acting user and the new values',
        logs.some((l) => Number(l.user_id) === ctx.ictId && !!l.new_values),
        'no row with actor + new_values'
    );

    const assetAudit = await request(
        'GET',
        `/api/assets/${assetA.asset.id}/history`,
        { token: adminToken }
    );
    check(
        'the asset audit timeline reflects the custody changes',
        assetAudit.status === 200 &&
            !!(assetAudit.body && assetAudit.body.data) &&
            assetAudit.body.data.history.length >= 2,
        `${assetAudit.status} ${assetAudit.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('13. Malformed input handling');
    /* ---------------------------------------------------------------- */
    const badJson = await new Promise((resolve, reject) => {
        const payload = '{"asset_id": 1, ';
        const req = http.request(
            `${BASE}/api/assignments`,
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

    const unknownRoute = await request('GET', '/api/assignments/1/does-not-exist', {
        token: adminToken
    });
    check(
        'an unknown assignment sub-route returns 404',
        unknownRoute.status === 404,
        `${unknownRoute.status} ${unknownRoute.raw}`
    );
}

/* -------------------------------------------------------------------------
 * Bootstrap: start server, run suite, always clean up, exit explicitly.
 * ---------------------------------------------------------------------- */
server = app.listen(PORT, async () => {
    console.log('======================================================');
    console.log('  NBSZ Asset Management - Assignment Test Suite');
    console.log('======================================================');
    console.log(`Target: ${BASE}`);
    console.log(`Time:   ${new Date().toISOString()}`);

    let failure = null;
    try {
        await connectDb();
        // The assignment module owns its own DDL so the suite can run on a
        // database that has not had scripts/initDb.js re-applied.
        await assignmentModel.ensureTable();
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
