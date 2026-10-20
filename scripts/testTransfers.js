'use strict';

/**
 * scripts/testTransfers.js
 * ---------------------------------------------------------------------------
 * Standalone smoke/regression test for the Asset Transfer slice (§5.4).
 *
 * Boots the real Express app (which also verifies the MySQL connection) on an
 * isolated port, fires real HTTP requests at it, and asserts on the responses.
 * No test-runner dependency is required - run it with:
 *
 *     node scripts/testTransfers.js
 *
 * The suite is self-contained: it creates its own role accounts, category,
 * assets and transfer rows, and hard-deletes everything it created at the end
 * (the API itself never deletes movement rows, by design).
 *
 * Exit code 0 = all checks passed, 1 = at least one check failed.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const app = require('../server');
const transferModel = require('../models/transferModel');
const assignmentModel = require('../models/assetAssignmentModel');
const assetModel = require('../models/assetModel');

// Dedicated port so this can run even while the dev server is up.
const PORT = process.env.TRANSFER_TEST_PORT || 3996;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let server = null;

// Ids created during the run, cleaned up at the end.
const createdTransferIds = [];
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
 * Removes everything this suite created. Child rows (transfers, assignments,
 * audit_logs) must go before the parent users/assets because of the foreign
 * keys.
 */
async function cleanup() {
    if (!db) return;

    try {
        if (createdTransferIds.length) {
            await db.query(
                `DELETE FROM audit_logs
                 WHERE table_name = 'transfers' AND record_id IN (?)`,
                [createdTransferIds]
            );
            await db.query('DELETE FROM transfers WHERE id IN (?)', [createdTransferIds]);
        }

        if (createdAssetIds.length) {
            // Any transfer/assignment row pointing at a throwaway asset goes too.
            await db.query(
                `DELETE FROM audit_logs WHERE table_name = 'transfers' AND record_id IN (
                    SELECT id FROM transfers WHERE asset_id IN (?)
                 )`,
                [createdAssetIds]
            );
            await db.query('DELETE FROM transfers WHERE asset_id IN (?)', [createdAssetIds]);
            await db.query(
                `DELETE FROM audit_logs
                 WHERE table_name = 'asset_assignments' AND record_id IN (
                    SELECT id FROM asset_assignments WHERE asset_id IN (?)
                 )`,
                [createdAssetIds]
            );
            await db.query('DELETE FROM asset_assignments WHERE asset_id IN (?)', [createdAssetIds]);
            await db.query(
                `DELETE FROM audit_logs WHERE table_name = 'assets' AND record_id IN (?)`,
                [createdAssetIds]
            );
            await db.query('DELETE FROM assets WHERE id IN (?)', [createdAssetIds]);
        }

        if (createdAssignmentIds.length) {
            await db.query('DELETE FROM asset_assignments WHERE id IN (?)', [createdAssignmentIds]);
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
    const tagSeed = `TRF-${stamp}`;

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
        username: 'trf_admin_test',
        email: 'trf.admin.test@nbsz.co.zw',
        password: 'TrfAdmin@123',
        fullName: 'Transfer Test Administrator',
        role: 'System Administrator'
    };
    const hisoUser = {
        username: 'trf_hiso_test',
        email: 'trf.hiso.test@nbsz.co.zw',
        password: 'TrfHiso@123',
        fullName: 'Transfer Test HISO',
        role: 'HISO'
    };
    const ictUser = {
        username: 'trf_ict_test',
        email: 'trf.ict.test@nbsz.co.zw',
        password: 'TrfIct@123',
        fullName: 'Transfer Test ICT Officer',
        role: 'ICT Officer'
    };
    const deptUser = {
        username: 'trf_dept_test',
        email: 'trf.dept.test@nbsz.co.zw',
        password: 'TrfDept@123',
        fullName: 'Transfer Test Custodian',
        role: 'Departmental User'
    };
    const auditorUser = {
        username: 'trf_auditor_test',
        email: 'trf.auditor.test@nbsz.co.zw',
        password: 'TrfAudit@123',
        fullName: 'Transfer Test Auditor',
        role: 'Auditor'
    };
    const otherDeptUser = {
        username: 'trf_dept2_test',
        email: 'trf.dept2.test@nbsz.co.zw',
        password: 'TrfDept2@123',
        fullName: 'Transfer Test Second Custodian',
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

    // A transfer endpoint must reject an anonymous caller.
    const anon = await request('GET', '/api/transfers');
    check('an unauthenticated transfer request is rejected (401)', anon.status === 401, anon.raw);

    // Expose the ids the later sections need.
    const ctx = { adminId, hisoId, ictId, deptId, auditorId, otherDeptId };


    /* ---------------------------------------------------------------- */
    section('4. Fixtures: category and assets');
    /* ---------------------------------------------------------------- */
    const categoryName = `Transfer Category ${tagSeed}`;
    const createCategory = await request('POST', '/api/assets/categories', {
        token: adminToken,
        body: { name: categoryName, description: 'Created by the transfer test suite.' }
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
            manufacturer: 'TransferTest',
            model: 'Model-X',
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

    const stockBound = await createAsset('C');
    check('stock-bound test asset created', !!stockBound.asset, stockBound.res.raw);

    const spare2 = await createAsset('D');
    check('second spare test asset created', !!spare2.asset, spare2.res.raw);

    const approvalAsset = await createAsset('E');
    check('approval test asset created', !!approvalAsset.asset, approvalAsset.res.raw);
    const cancellationAsset = await createAsset('F');
    check('pending cancellation test asset created', !!cancellationAsset.asset, cancellationAsset.res.raw);
    const concurrentApprovalAsset = await createAsset('G');
    check('concurrent approval test asset created', !!concurrentApprovalAsset.asset, concurrentApprovalAsset.res.raw);

    if (!asset) {
        throw new Error('Cannot continue without the primary test asset.');
    }

    const pendingResponse = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: approvalAsset.asset.id,
            to_user_id: deptId,
            transfer_type: 'User',
            transfer_date: today(),
            reason: 'Approval workflow integration test',
            status: 'Pending'
        }
    });
    const pendingTransfer =
        pendingResponse.body && pendingResponse.body.data
            ? pendingResponse.body.data.transfer
            : null;
    if (pendingTransfer) createdTransferIds.push(pendingTransfer.id);
    check(
        'a transfer can be recorded as pending approval',
        pendingResponse.status === 201 && pendingTransfer && pendingTransfer.status === 'Pending',
        pendingResponse.raw
    );
    const pendingCustody = await assignmentModel.findActiveByAssetId(approvalAsset.asset.id);
    const pendingAssetState = await assetModel.findById(approvalAsset.asset.id);
    check(
        'pending transfer leaves the assignment and asset register unchanged',
        !pendingCustody &&
            pendingAssetState &&
            pendingAssetState.assigned_user_id === null &&
            pendingAssetState.status === 'In Stock',
        JSON.stringify({ pendingCustody, pendingAssetState })
    );

    if (pendingTransfer) {
        const selfApproval = await request('PATCH', `/api/transfers/${pendingTransfer.id}/approve`, {
            token: adminToken,
            body: {}
        });
        check(
            'the transfer initiator cannot approve their own pending transfer',
            selfApproval.status === 409,
            selfApproval.raw
        );
        const unauthorizedApproval = await request(
            'PATCH',
            `/api/transfers/${pendingTransfer.id}/approve`,
            { token: ictToken, body: {} }
        );
        check(
            'an ICT Officer cannot approve a pending transfer (403)',
            unauthorizedApproval.status === 403,
            unauthorizedApproval.raw
        );
        const approved = await request('PATCH', `/api/transfers/${pendingTransfer.id}/approve`, {
            token: hisoToken,
            body: {}
        });
        check(
            'a different HISO can approve a pending transfer',
            approved.status === 200 &&
                approved.body &&
                approved.body.data &&
                approved.body.data.transfer.status === 'Completed' &&
                Number(approved.body.data.transfer.approved_by) === Number(hisoId),
            approved.raw
        );
        const approvedCustody = await assignmentModel.findActiveByAssetId(approvalAsset.asset.id);
        const approvedAssetState = await assetModel.findById(approvalAsset.asset.id);
        check(
            'approval applies the destination to custody and asset register',
            approvedCustody &&
                Number(approvedCustody.assigned_user_id) === Number(deptId) &&
                approvedAssetState &&
                Number(approvedAssetState.assigned_user_id) === Number(deptId) &&
                approvedCustody.status === 'Active' &&
                approved.body.data.transfer.assignment_id === approvedCustody.id,
            JSON.stringify({ approvedCustody, approvedAssetState })
        );
        const approveAgain = await request('PATCH', `/api/transfers/${pendingTransfer.id}/approve`, {
            token: hisoToken,
            body: {}
        });
        check('a completed transfer cannot be approved twice', approveAgain.status === 409, approveAgain.raw);
    }

    const pendingCancelResponse = await request('POST', '/api/transfers', {
        token: ictToken,
        body: {
            asset_id: cancellationAsset.asset.id,
            to_user_id: deptId,
            transfer_type: 'User',
            transfer_date: today(),
            reason: 'Pending cancellation integration test',
            status: 'Pending'
        }
    });
    const pendingCancelTransfer =
        pendingCancelResponse.body && pendingCancelResponse.body.data
            ? pendingCancelResponse.body.data.transfer
            : null;
    if (pendingCancelTransfer) createdTransferIds.push(pendingCancelTransfer.id);
    check(
        'a second pending transfer can be created for cancellation',
        pendingCancelResponse.status === 201 && !!pendingCancelTransfer,
        pendingCancelResponse.raw
    );
    if (pendingCancelTransfer) {
        const cancelPending = await request(
            'PATCH',
            `/api/transfers/${pendingCancelTransfer.id}/cancel`,
            { token: hisoToken, body: { reason: 'Request withdrawn before approval' } }
        );
        const cancelledCustody = await assignmentModel.findActiveByAssetId(cancellationAsset.asset.id);
        const cancelledAssetState = await assetModel.findById(cancellationAsset.asset.id);
        check(
            'cancelling a pending transfer leaves custody and the asset register unchanged',
            cancelPending.status === 200 &&
                cancelPending.body.data.transfer.status === 'Cancelled' &&
                !cancelledCustody &&
                cancelledAssetState &&
                cancelledAssetState.assigned_user_id === null &&
                cancelledAssetState.status === 'In Stock',
            JSON.stringify({ cancelPending: cancelPending.body, cancelledCustody, cancelledAssetState })
        );
    }

    const competingTransfers = [];
    for (const receiverId of [deptId, otherDeptId]) {
        const competingResponse = await request('POST', '/api/transfers', {
            token: ictToken,
            body: {
                asset_id: concurrentApprovalAsset.asset.id,
                to_user_id: receiverId,
                transfer_type: 'User',
                transfer_date: today(),
                reason: 'Competing approval integration test',
                status: 'Pending'
            }
        });
        const competingTransfer =
            competingResponse.body && competingResponse.body.data
                ? competingResponse.body.data.transfer
                : null;
        if (competingTransfer) {
            createdTransferIds.push(competingTransfer.id);
            competingTransfers.push(competingTransfer);
        }
        check(
            'competing pending transfer request is recorded',
            competingResponse.status === 201 && !!competingTransfer,
            competingResponse.raw
        );
    }

    if (competingTransfers.length === 2) {
        const approvalResults = await Promise.all([
            request('PATCH', `/api/transfers/${competingTransfers[0].id}/approve`, {
                token: hisoToken,
                body: {}
            }),
            request('PATCH', `/api/transfers/${competingTransfers[1].id}/approve`, {
                token: adminToken,
                body: {}
            })
        ]);
        const winnerIndex = approvalResults.findIndex((result) => result.status === 200);
        const loserIndex = winnerIndex === 0 ? 1 : 0;
        const liveAssignment = await assignmentModel.findActiveByAssetId(concurrentApprovalAsset.asset.id);
        const liveAsset = await assetModel.findById(concurrentApprovalAsset.asset.id);
        const completedCount = competingTransfers.filter(
            (transfer, index) => approvalResults[index].status === 200
        ).length;
        check(
            'only one competing approval moves custody and the stale request is rejected',
            winnerIndex !== -1 &&
                approvalResults[loserIndex].status === 409 &&
                completedCount === 1 &&
                liveAssignment &&
                Number(liveAssignment.assigned_user_id) ===
                    Number(competingTransfers[winnerIndex].to_user_id) &&
                liveAsset &&
                Number(liveAsset.assigned_user_id) ===
                    Number(competingTransfers[winnerIndex].to_user_id),
            JSON.stringify({
                statuses: approvalResults.map((result) => result.status),
                liveAssignment,
                liveAsset
            })
        );
    }

    /* ---------------------------------------------------------------- */
    section('5. Reference data and empty-state summaries');
    /* ---------------------------------------------------------------- */
    const meta = await request('GET', '/api/transfers/meta', { token: ictToken });
    check('GET /api/transfers/meta returns 200', meta.status === 200, meta.raw);
    check(
        'meta exposes the transfer statuses',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.statuses) &&
            meta.body.data.statuses.includes('Completed'),
        meta.raw
    );
    check(
        'meta exposes the transfer types',
        !!meta.body &&
            !!meta.body.data &&
            Array.isArray(meta.body.data.transfer_types) &&
            meta.body.data.transfer_types.includes('User'),
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
        'meta exposes a next transfer reference (TRF- prefix)',
        !!meta.body &&
            !!meta.body.data &&
            /^TRF-\d+$/.test(String(meta.body.data.next_transfer_ref)),
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

    // A Departmental User may read lists but not the administrative meta.
    const metaAsDept = await request('GET', '/api/transfers/meta', { token: deptToken });
    check(
        'a Departmental User cannot read transfer meta (403)',
        metaAsDept.status === 403,
        metaAsDept.raw
    );

    const stats = await request('GET', '/api/transfers/stats', { token: auditorToken });
    check('GET /api/transfers/stats returns 200 for an Auditor', stats.status === 200, stats.raw);
    check(
        'stats expose the expected aggregate shape',
        !!stats.body &&
            !!stats.body.data &&
            typeof stats.body.data.total === 'number' &&
            Array.isArray(stats.body.data.byStatus) &&
            Array.isArray(stats.body.data.byType) &&
            Array.isArray(stats.body.data.byMonth) &&
            Array.isArray(stats.body.data.byDestination),
        stats.raw
    );

    const statsAsDept = await request('GET', '/api/transfers/stats', { token: deptToken });
    check(
        'a Departmental User cannot read transfer stats (403)',
        statsAsDept.status === 403,
        statsAsDept.raw
    );

    const emptyList = await request('GET', '/api/transfers?limit=5', { token: adminToken });
    check('GET /api/transfers returns 200', emptyList.status === 200, emptyList.raw);
    check(
        'the list envelope carries transfers/total/returned',
        !!emptyList.body &&
            !!emptyList.body.data &&
            Array.isArray(emptyList.body.data.transfers) &&
            typeof emptyList.body.data.total === 'number' &&
            typeof emptyList.body.data.returned === 'number',
        emptyList.raw
    );


    /* ---------------------------------------------------------------- */
    section('6. Assign the asset, then transfer it (the core workflow)');
    /* ---------------------------------------------------------------- */
    const assignRes = await request('POST', '/api/assignments', {
        token: adminToken,
        body: {
            asset_id: asset.id,
            assigned_user_id: deptId,
            assigned_to_name: deptUser.fullName,
            department: 'ICT',
            location: 'Head Office',
            responsible_officer: 'Transfer Test Officer',
            assignment_date: today(),
            purpose: 'In use by the first custodian'
        }
    });
    const initialAssignment =
        assignRes.body && assignRes.body.data && assignRes.body.data.assignment
            ? assignRes.body.data.assignment
            : null;
    if (initialAssignment) createdAssignmentIds.push(initialAssignment.id);
    check(
        'the asset is first assigned to custodian A',
        assignRes.status === 201 && !!initialAssignment,
        assignRes.raw
    );

    // Now move the asset from custodian A to custodian B.
    const transferRes = await request('POST', '/api/transfers', {
        token: ictToken,
        body: {
            asset_id: asset.id,
            to_user_id: otherDeptId,
            to_custodian_name: otherDeptUser.fullName,
            to_department: 'Finance',
            to_location: 'Bulawayo Branch',
            transfer_date: today(),
            transfer_type: 'User',
            reason: 'Redeployed to Finance for month-end processing',
            remarks: 'Handed over in person; charger included.',
            responsible_officer: 'Transfer Test Officer',
            receiving_party_name: otherDeptUser.fullName,
            to_condition: 'Good'
        }
    });

    const transfer =
        transferRes.body && transferRes.body.data && transferRes.body.data.transfer
            ? transferRes.body.data.transfer
            : null;
    if (transfer) createdTransferIds.push(transfer.id);

    check(
        'POST /api/transfers records the movement (201)',
        transferRes.status === 201 && !!transfer,
        transferRes.raw
    );

    check(
        'the transfer gets a TRF- reference',
        !!transfer && /^TRF-\d+$/.test(String(transfer.transfer_ref)),
        transfer ? `ref: ${transfer.transfer_ref}` : 'no transfer'
    );

    check(
        'the transfer snapshots the NEW custodian',
        !!transfer && Number(transfer.to_user_id) === Number(ctx.otherDeptId),
        transfer ? `to_user_id: ${transfer.to_user_id}` : 'no transfer'
    );

    check(
        'the transfer snapshots the PREVIOUS custodian (history preserved)',
        !!transfer && Number(transfer.from_user_id) === Number(ctx.deptId),
        transfer ? `from_user_id: ${transfer.from_user_id}` : 'no transfer'
    );

    check(
        'the previous custodian AND the new custodian are both readable',
        !!transfer &&
            transfer.from_custodian_name === deptUser.fullName &&
            transfer.to_custodian_name === otherDeptUser.fullName,
        transfer
            ? `from: ${transfer.from_custodian_name} -> to: ${transfer.to_custodian_name}`
            : 'no transfer'
    );

    check(
        'the previous AND new location are both recorded',
        !!transfer &&
            transfer.from_location === 'Head Office' &&
            transfer.to_location === 'Bulawayo Branch',
        transfer
            ? `from: ${transfer.from_location} -> to: ${transfer.to_location}`
            : 'no transfer'
    );

    check(
        'the previous AND new department are both recorded',
        !!transfer && transfer.from_department === 'ICT' && transfer.to_department === 'Finance',
        transfer
            ? `from: ${transfer.from_department} -> to: ${transfer.to_department}`
            : 'no transfer'
    );


    check(
        'the transfer reason is stored',
        !!transfer && String(transfer.reason).includes('Redeployed to Finance'),
        transfer ? `reason: ${transfer.reason}` : 'no transfer'
    );

    check(
        'the transfer date round-trips unchanged',
        !!transfer && isoDay(transfer.transfer_date) === today(),
        transfer ? `transfer_date: ${transfer.transfer_date}` : 'no transfer'
    );

    check(
        'the initiating officer is recorded',
        !!transfer && Number(transfer.initiated_by) === Number(ctx.ictId),
        transfer ? `initiated_by: ${transfer.initiated_by}` : 'no transfer'
    );

    check(
        'the old custody row was closed as Transferred',
        !!transferRes.body.data.previous_assignment &&
            transferRes.body.data.previous_assignment.status === 'Transferred' &&
            !!transferRes.body.data.previous_assignment.released_at,
        transferRes.raw
    );

    check(
        'a NEW open custody row was opened for the receiver',
        !!transferRes.body.data.assignment &&
            Number(transferRes.body.data.assignment.assigned_user_id) ===
                Number(ctx.otherDeptId) &&
            !transferRes.body.data.assignment.released_at,
        transferRes.raw
    );

    check(
        'the transfer links to the custody row it opened',
        !!transfer &&
            !!transferRes.body.data.assignment &&
            Number(transfer.assignment_id) === Number(transferRes.body.data.assignment.id),
        transfer ? `assignment_id: ${transfer.assignment_id}` : 'no transfer'
    );

    check(
        'the asset register now shows the new custodian',
        !!transferRes.body.data.asset &&
            Number(transferRes.body.data.asset.assigned_user_id) === Number(ctx.otherDeptId),
        transferRes.raw
    );

    check(
        'the asset register now shows the new location and department',
        !!transferRes.body.data.asset &&
            transferRes.body.data.asset.location === 'Bulawayo Branch' &&
            transferRes.body.data.asset.department === 'Finance',
        transferRes.raw
    );

    check(
        'the asset is marked In Use once it has a custodian',
        !!transferRes.body.data.asset && transferRes.body.data.asset.status === 'In Use',
        transferRes.raw
    );


    /* ---------------------------------------------------------------- */
    section('7. Permanent history (the "no loss of history" requirement)');
    /* ---------------------------------------------------------------- */
    const history = await request('GET', `/api/transfers/asset/${asset.id}/history`, {
        token: auditorToken
    });
    check('GET asset transfer history returns 200', history.status === 200, history.raw);
    check(
        'the asset history contains the movement',
        !!history.body &&
            !!history.body.data &&
            Array.isArray(history.body.data.transfers) &&
            history.body.data.transfers.length === 1,
        history.raw
    );
    const unrelatedHistory = await request('GET', `/api/transfers/asset/${stockBound.asset.id}/history`, {
        token: otherDeptToken
    });
    check(
        'a Departmental User cannot read transfers for unrelated custody (404)',
        unrelatedHistory.status === 404,
        unrelatedHistory.raw
    );

    const assignmentHistory = await request(
        'GET',
        `/api/assignments/asset/${asset.id}/history`,
        { token: auditorToken }
    );
    check(
        'BOTH custody rows survive the transfer (assignment history preserved)',
        !!assignmentHistory.body &&
            !!assignmentHistory.body.data &&
            Array.isArray(assignmentHistory.body.data.history) &&
            assignmentHistory.body.data.history.length === 2,
        assignmentHistory.raw
    );

    const closedRow =
        assignmentHistory.body && assignmentHistory.body.data
            ? assignmentHistory.body.data.history.find(
                  (row) => Number(row.assigned_user_id) === Number(ctx.deptId)
              )
            : null;
    check(
        'the FIRST custodian is still visible in the custody history',
        !!closedRow && closedRow.status === 'Transferred',
        closedRow ? `status: ${closedRow.status}` : 'row not found'
    );

    // A second movement, so we can prove ordering and accumulation.
    const secondTransfer = await request('POST', '/api/transfers', {
        token: hisoToken,
        body: {
            asset_id: asset.id,
            to_user_id: deptId,
            to_custodian_name: deptUser.fullName,
            to_department: 'ICT',
            to_location: 'Head Office',
            transfer_date: dayOffset(1),
            transfer_type: 'User',
            reason: 'Returned to ICT for imaging'
        }
    });
    const secondRow =
        secondTransfer.body && secondTransfer.body.data && secondTransfer.body.data.transfer
            ? secondTransfer.body.data.transfer
            : null;
    if (secondRow) createdTransferIds.push(secondRow.id);
    check(
        'a second movement is recorded',
        secondTransfer.status === 201 && !!secondRow,
        secondTransfer.raw
    );

    check(
        'the two movements have distinct references',
        !!transfer && !!secondRow && transfer.transfer_ref !== secondRow.transfer_ref,
        `refs: ${transfer ? transfer.transfer_ref : '-'} / ${
            secondRow ? secondRow.transfer_ref : '-'
        }`
    );

    const history2 = await request('GET', `/api/transfers/asset/${asset.id}/history`, {
        token: auditorToken
    });
    check(
        'the history now has BOTH movements',
        !!history2.body && !!history2.body.data && history2.body.data.transfers.length === 2,
        history2.raw
    );

    check(
        'the history is ordered newest first',
        !!history2.body &&
            !!history2.body.data &&
            isoDay(history2.body.data.transfers[0].transfer_date) === dayOffset(1),
        history2.raw
    );

    check(
        'the FIRST movement is still present after a later one (nothing overwritten)',
        !!history2.body &&
            !!history2.body.data &&
            history2.body.data.transfers.some((row) => Number(row.id) === Number(transfer.id)),
        history2.raw
    );

    const latest = await request('GET', `/api/transfers/asset/${asset.id}/latest`, {
        token: deptToken
    });
    check('GET latest asset transfer returns 200', latest.status === 200, latest.raw);
    check(
        'the latest movement is the most recent one',
        !!latest.body &&
            !!latest.body.data &&
            !!latest.body.data.transfer &&
            !!secondRow &&
            Number(latest.body.data.transfer.id) === Number(secondRow.id),
        latest.raw
    );


    /* ---------------------------------------------------------------- */
    section('8. Department and location moves (same custodian)');
    /* ---------------------------------------------------------------- */
    // The asset is currently with custodian A; move it between locations
    // WITHOUT handing it to a new person. The open custody row must be
    // corrected in place, not reopened.
    const locationMove = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: asset.id,
            to_user_id: deptId,
            to_location: 'Mutare Branch',
            to_department: 'ICT',
            transfer_date: today(),
            transfer_type: 'Location',
            reason: 'Staff relocated to the Mutare branch'
        }
    });
    const locationRow =
        locationMove.body && locationMove.body.data && locationMove.body.data.transfer
            ? locationMove.body.data.transfer
            : null;
    if (locationRow) createdTransferIds.push(locationRow.id);

    check('a location-only move is recorded', locationMove.status === 201, locationMove.raw);
    check(
        'the location move records the old AND new location',
        !!locationRow &&
            locationRow.from_location === 'Head Office' &&
            locationRow.to_location === 'Mutare Branch',
        locationRow
            ? `from: ${locationRow.from_location} -> to: ${locationRow.to_location}`
            : 'no row'
    );
    check(
        'a location move keeps the same custodian',
        !!locationRow &&
            Number(locationRow.from_user_id) === Number(locationRow.to_user_id) &&
            Number(locationRow.to_user_id) === Number(ctx.deptId),
        locationRow ? `from/to: ${locationRow.from_user_id}/${locationRow.to_user_id}` : 'no row'
    );
    check(
        'the asset register reflects the new location',
        !!locationMove.body.data.asset && locationMove.body.data.asset.location === 'Mutare Branch',
        locationMove.raw
    );

    // Moving into stores clears the custodian.
    const stockMove = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: stockBound.asset.id,
            to_location: 'ICT Stores',
            to_department: 'ICT',
            transfer_date: today(),
            transfer_type: 'Stock',
            reason: 'Returned to stores unused'
        }
    });
    const stockRow =
        stockMove.body && stockMove.body.data && stockMove.body.data.transfer
            ? stockMove.body.data.transfer
            : null;
    if (stockRow) createdTransferIds.push(stockRow.id);
    check('a move into stores is recorded', stockMove.status === 201, stockMove.raw);
    check(
        'a stores-bound asset has no receiving custodian',
        !!stockRow && stockRow.to_user_id === null,
        stockRow ? `to_user_id: ${stockRow.to_user_id}` : 'no row'
    );
    check(
        'the asset register shows it back In Stock',
        !!stockMove.body.data.asset && stockMove.body.data.asset.status === 'In Stock',
        stockMove.raw
    );


    /* ---------------------------------------------------------------- */
    section('9. Validation');
    /* ---------------------------------------------------------------- */
    const noAsset = await request('POST', '/api/transfers', {
        token: adminToken,
        body: { to_user_id: otherDeptId, transfer_date: today() }
    });
    check(
        'a transfer with no asset is rejected (404/400)',
        noAsset.status === 404 || noAsset.status === 400,
        noAsset.raw
    );

    const unknownAsset = await request('POST', '/api/transfers', {
        token: adminToken,
        body: { asset_id: 999999999, to_user_id: otherDeptId, transfer_date: today() }
    });
    check(
        'a transfer for an unknown asset is rejected (404)',
        unknownAsset.status === 404,
        unknownAsset.raw
    );

    const noDestination = await request('POST', '/api/transfers', {
        token: adminToken,
        body: { asset_id: spare1.asset.id, transfer_date: today() }
    });
    check(
        'a transfer with no destination is rejected (400)',
        noDestination.status === 400,
        noDestination.raw
    );
    check(
        'the no-destination error names the missing destination fields',
        !!noDestination.body &&
            Array.isArray(noDestination.body.errors) &&
            noDestination.body.errors.some((e) => e.field === 'to_user_id'),
        noDestination.raw
    );

    const badDate = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: spare1.asset.id,
            to_user_id: otherDeptId,
            transfer_date: '2026-02-30'
        }
    });
    check('an impossible calendar date is rejected (400)', badDate.status === 400, badDate.raw);

    const badType = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: spare1.asset.id,
            to_user_id: otherDeptId,
            transfer_date: today(),
            transfer_type: 'Teleport'
        }
    });
    check('an unknown transfer_type is rejected (400)', badType.status === 400, badType.raw);
    check(
        'the transfer_type error lists the allowed values',
        !!badType.body &&
            Array.isArray(badType.body.errors) &&
            badType.body.errors.some((e) => e.field === 'transfer_type'),
        badType.raw
    );

    const badUser = await request('POST', '/api/transfers', {
        token: adminToken,
        body: { asset_id: spare1.asset.id, to_user_id: 999999999, transfer_date: today() }
    });
    check(
        'a transfer to a non-existent user is rejected (400)',
        badUser.status === 400,
        badUser.raw
    );

    const longReason = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: spare1.asset.id,
            to_user_id: otherDeptId,
            transfer_date: today(),
            reason: 'x'.repeat(300)
        }
    });
    check('an over-long reason is rejected (400)', longReason.status === 400, longReason.raw);

    // A no-op handover to the custodian who already holds the asset.
    const selfTransfer = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: asset.id,
            to_user_id: deptId,
            transfer_date: today(),
            transfer_type: 'User',
            reason: 'Should be refused'
        }
    });
    check(
        'transferring to the current custodian is rejected (400)',
        selfTransfer.status === 400,
        selfTransfer.raw
    );


    /* ---------------------------------------------------------------- */
    section('10. Role-based access control');
    /* ---------------------------------------------------------------- */
    const createAsDept = await request('POST', '/api/transfers', {
        token: deptToken,
        body: {
            asset_id: spare1.asset.id,
            to_user_id: otherDeptId,
            transfer_date: today(),
            reason: 'Custodians must not move assets themselves'
        }
    });
    check(
        'a Departmental User cannot record a transfer (403)',
        createAsDept.status === 403,
        createAsDept.raw
    );

    const createAsAuditor = await request('POST', '/api/transfers', {
        token: auditorToken,
        body: {
            asset_id: spare1.asset.id,
            to_user_id: otherDeptId,
            transfer_date: today(),
            reason: 'Auditors are read-only'
        }
    });
    check(
        'an Auditor cannot record a transfer (403)',
        createAsAuditor.status === 403,
        createAsAuditor.raw
    );

    const cancelAsIct = await request('PATCH', `/api/transfers/${transfer.id}/cancel`, {
        token: ictToken,
        body: { reason: 'ICT must not be able to cancel an audit trail row' }
    });
    check(
        'an ICT Officer cannot cancel a transfer (admin/HISO only, 403)',
        cancelAsIct.status === 403,
        cancelAsIct.raw
    );

    const reverseAsIct = await request('PATCH', `/api/transfers/${transfer.id}/reverse`, {
        token: ictToken,
        body: { reason: 'ICT must not be able to reverse an audit trail row' }
    });
    check(
        'an ICT Officer cannot reverse a transfer (admin/HISO only, 403)',
        reverseAsIct.status === 403,
        reverseAsIct.raw
    );

    const readAsAuditor = await request('GET', '/api/transfers', { token: auditorToken });
    check(
        'an Auditor CAN read the transfer register (200)',
        readAsAuditor.status === 200,
        readAsAuditor.raw
    );

    const readAsDept = await request('GET', '/api/transfers', { token: deptToken });
    check(
        'a Departmental User CAN read the transfer register (200)',
        readAsDept.status === 200,
        readAsDept.raw
    );


    /* ---------------------------------------------------------------- */
    section('11. Acknowledge, cancel and reverse');
    /* ---------------------------------------------------------------- */
    const ack = await request('PATCH', `/api/transfers/${transfer.id}/acknowledge`, {
        token: ictToken,
        body: { receiving_party_name: otherDeptUser.fullName }
    });
    check('the receiving party can acknowledge (200)', ack.status === 200, ack.raw);
    check(
        'the acknowledgement timestamp is stored',
        !!ack.body &&
            !!ack.body.data &&
            !!ack.body.data.transfer &&
            !!ack.body.data.transfer.receiving_party_acknowledged_at,
        ack.raw
    );
    check(
        'the acknowledging user is recorded',
        !!ack.body.data.transfer &&
            Number(ack.body.data.transfer.receiving_party_acknowledged_by) === Number(ctx.ictId),
        ack.raw
    );

    const ackAgain = await request('PATCH', `/api/transfers/${transfer.id}/acknowledge`, {
        token: ictToken,
        body: {}
    });
    check('acknowledging twice is rejected (409)', ackAgain.status === 409, ackAgain.raw);

    const ackUnknown = await request('PATCH', '/api/transfers/999999999/acknowledge', {
        token: ictToken,
        body: {}
    });
    check('acknowledging an unknown transfer is a 404', ackUnknown.status === 404, ackUnknown.raw);

    // A transfer we explicitly cancel.
    const toCancel = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: spare1.asset.id,
            to_user_id: otherDeptId,
            transfer_date: today(),
            transfer_type: 'User',
            reason: 'Recorded in error - wrong asset scanned'
        }
    });
    const cancelTarget =
        toCancel.body && toCancel.body.data && toCancel.body.data.transfer
            ? toCancel.body.data.transfer
            : null;
    if (cancelTarget) createdTransferIds.push(cancelTarget.id);
    check('the disposable transfer was created', toCancel.status === 201, toCancel.raw);

    const cancelled = await request('PATCH', `/api/transfers/${cancelTarget.id}/cancel`, {
        token: hisoToken,
        body: { reason: 'Duplicate of an earlier entry' }
    });
    check('HISO can cancel a transfer (200)', cancelled.status === 200, cancelled.raw);
    check(
        'the cancelled row keeps its evidence (status Cancelled, not deleted)',
        !!cancelled.body &&
            !!cancelled.body.data &&
            cancelled.body.data.transfer.status === 'Cancelled',
        cancelled.raw
    );

    const cancelAgain = await request('PATCH', `/api/transfers/${cancelTarget.id}/cancel`, {
        token: hisoToken,
        body: {}
    });
    check('cancelling twice is rejected (409)', cancelAgain.status === 409, cancelAgain.raw);

    const stillReadable = await request('GET', `/api/transfers/${cancelTarget.id}`, {
        token: auditorToken
    });
    check(
        'a cancelled transfer is still retrievable (history is permanent)',
        stillReadable.status === 200 &&
            !!stillReadable.body.data.transfer &&
            stillReadable.body.data.transfer.status === 'Cancelled',
        stillReadable.raw
    );

    const ackCancelled = await request(
        'PATCH',
        `/api/transfers/${cancelTarget.id}/acknowledge`,
        { token: ictToken, body: {} }
    );
    check(
        'a cancelled transfer cannot be acknowledged (409)',
        ackCancelled.status === 409,
        ackCancelled.raw
    );

    // A transfer we explicitly reverse. Uses its own asset so it is never a
    // no-op handover to the custodian who already holds it.
    const toReverse = await request('POST', '/api/transfers', {
        token: adminToken,
        body: {
            asset_id: spare2.asset.id,
            to_user_id: otherDeptId,
            transfer_date: today(),
            transfer_type: 'User',
            reason: 'Will be reversed'
        }
    });
    check(
        'the transfer destined for reversal was created',
        toReverse.status === 201,
        toReverse.raw
    );
    const reverseTarget =
        toReverse.body && toReverse.body.data && toReverse.body.data.transfer
            ? toReverse.body.data.transfer
            : null;
    if (reverseTarget) createdTransferIds.push(reverseTarget.id);

    const reversed = await request(
        'PATCH',
        `/api/transfers/${reverseTarget ? reverseTarget.id : 0}/reverse`,
        {
            token: adminToken,
            body: { reason: 'Custodian never collected the asset' }
        }
    );
    check('an administrator can reverse a transfer (200)', reversed.status === 200, reversed.raw);
    check(
        'the reversed row keeps its record',
        !!reversed.body && !!reversed.body.data && reversed.body.data.transfer.status === 'Reversed',
        reversed.raw
    );
    check(
        'the reversal reason is recorded',
        !!reversed.body.data.transfer &&
            String(reversed.body.data.transfer.reason).includes('never collected'),
        reversed.raw
    );


    /* ---------------------------------------------------------------- */
    section('12. Correcting descriptive details (PUT/PATCH)');
    /* ---------------------------------------------------------------- */
    const updateRes = await request('PUT', `/api/transfers/${secondRow.id}`, {
        token: ictToken,
        body: {
            reason: 'Returned to ICT for imaging and disk wipe',
            remarks: 'Original reason corrected after review.'
        }
    });
    check('PUT can correct the descriptive details (200)', updateRes.status === 200, updateRes.raw);
    check(
        'the corrected reason is stored',
        !!updateRes.body &&
            !!updateRes.body.data &&
            String(updateRes.body.data.transfer.reason).includes('disk wipe'),
        updateRes.raw
    );
    check(
        'the corrected remarks are stored',
        !!updateRes.body.data.transfer &&
            String(updateRes.body.data.transfer.remarks).includes('corrected after review'),
        updateRes.raw
    );

    // Historical facts must not be rewritten even if supplied.
    const tamper = await request('PUT', `/api/transfers/${secondRow.id}`, {
        token: ictToken,
        body: {
            to_user_id: adminId,
            to_location: 'Tampered Location',
            transfer_date: '2000-01-01',
            reason: 'Attempting to rewrite history'
        }
    });
    check(
        'the update is accepted (only editable fields apply)',
        tamper.status === 200,
        tamper.raw
    );
    check(
        'the movement endpoints CANNOT be rewritten',
        !!tamper.body &&
            !!tamper.body.data &&
            Number(tamper.body.data.transfer.to_user_id) === Number(ctx.deptId) &&
            tamper.body.data.transfer.to_location === 'Head Office',
        tamper.raw
    );
    check(
        'the original transfer date CANNOT be rewritten',
        !!tamper.body.data.transfer &&
            isoDay(tamper.body.data.transfer.transfer_date) === dayOffset(1),
        tamper.raw
    );

    const emptyUpdate = await request('PATCH', `/api/transfers/${secondRow.id}`, {
        token: ictToken,
        body: { to_user_id: adminId }
    });
    check(
        'an update containing no editable field is rejected (400)',
        emptyUpdate.status === 400,
        emptyUpdate.raw
    );

    const statusUpdate = await request('PATCH', `/api/transfers/${secondRow.id}`, {
        token: adminToken,
        body: { status: 'Cancelled' }
    });
    check(
        'transfer status cannot be changed through the descriptive update endpoint',
        statusUpdate.status === 400,
        statusUpdate.raw
    );

    const updateUnknown = await request('PUT', '/api/transfers/999999999', {
        token: ictToken,
        body: { reason: 'n/a' }
    });
    check(
        'updating an unknown transfer is a 404',
        updateUnknown.status === 404,
        updateUnknown.raw
    );

    const updateAsDept = await request('PATCH', `/api/transfers/${secondRow.id}`, {
        token: deptToken,
        body: { reason: 'Custodians must not edit records' }
    });
    check(
        'a Departmental User cannot edit a transfer (403)',
        updateAsDept.status === 403,
        updateAsDept.raw
    );

    /* ---------------------------------------------------------------- */
    section('13. Per-custodian views and scoping');
    /* ---------------------------------------------------------------- */
    const byUserIn = await request(
        'GET',
        `/api/transfers/user/${ctx.otherDeptId}?direction=in`,
        { token: adminToken }
    );
    check('GET transfers received by a custodian returns 200', byUserIn.status === 200, byUserIn.raw);
    check(
        'the receiving custodian sees the movements addressed to them',
        !!byUserIn.body &&
            !!byUserIn.body.data &&
            Array.isArray(byUserIn.body.data.transfers) &&
            byUserIn.body.data.transfers.length > 0,
        byUserIn.raw
    );

    const byUserOut = await request(
        'GET',
        `/api/transfers/user/${ctx.deptId}?direction=out`,
        { token: adminToken }
    );
    check(
        "the releasing custodian's outbound movements are listed",
        byUserOut.status === 200 &&
            !!byUserOut.body.data &&
            Array.isArray(byUserOut.body.data.transfers) &&
            byUserOut.body.data.transfers.every(
                (row) => Number(row.from_user_id) === Number(ctx.deptId)
            ),
        byUserOut.raw
    );

    const deptOwnMovements = await request('GET', `/api/transfers/user/${ctx.deptId}`, {
        token: deptToken
    });
    check(
        'a Departmental User can read their OWN movements (200)',
        deptOwnMovements.status === 200,
        deptOwnMovements.raw
    );

    const deptOtherMovements = await request('GET', `/api/transfers/user/${ctx.otherDeptId}`, {
        token: deptToken
    });
    check(
        "a Departmental User cannot read another custodian's movements (403)",
        deptOtherMovements.status === 403,
        deptOtherMovements.raw
    );

    const deptListScoped = await request(
        'GET',
        `/api/transfers?to_user_id=${ctx.otherDeptId}&from_user_id=${ctx.otherDeptId}`,
        { token: deptToken }
    );
    const scopedRows =
        deptListScoped.body && deptListScoped.body.data
            ? deptListScoped.body.data.transfers
            : [];
    check(
        'a Departmental User cannot widen their list scope with query filters',
        deptListScoped.status === 200 &&
            scopedRows.every(
                (row) =>
                    Number(row.from_user_id) === Number(ctx.deptId) ||
                    Number(row.to_user_id) === Number(ctx.deptId)
            ),
        deptListScoped.raw
    );

    const unknownCustodian = await request('GET', '/api/transfers/user/999999999', {
        token: adminToken
    });
    check(
        'movements for an unknown custodian return 404',
        unknownCustodian.status === 404,
        unknownCustodian.raw
    );


    /* ---------------------------------------------------------------- */
    section('14. Search, filtering and summaries');
    /* ---------------------------------------------------------------- */
    const byStatus = await request('GET', '/api/transfers?status=Cancelled', {
        token: adminToken
    });
    check(
        'filtering by status returns only that status',
        byStatus.status === 200 &&
            !!byStatus.body.data &&
            byStatus.body.data.transfers.length > 0 &&
            byStatus.body.data.transfers.every((row) => row.status === 'Cancelled'),
        byStatus.raw
    );

    const byType = await request('GET', '/api/transfers?transfer_type=Stock', {
        token: adminToken
    });
    check(
        'filtering by transfer_type works',
        byType.status === 200 &&
            !!byType.body.data &&
            byType.body.data.transfers.every((row) => row.transfer_type === 'Stock'),
        byType.raw
    );

    const byDept = await request('GET', '/api/transfers?department=Finance', {
        token: adminToken
    });
    check(
        'filtering by department matches either side of the move',
        byDept.status === 200 &&
            !!byDept.body.data &&
            byDept.body.data.transfers.length > 0,
        byDept.raw
    );

    const byRef = await request('GET', `/api/transfers?search=${transfer.transfer_ref}`, {
        token: adminToken
    });
    check(
        'searching by transfer reference finds exactly that movement',
        byRef.status === 200 &&
            !!byRef.body.data &&
            byRef.body.data.transfers.length === 1 &&
            Number(byRef.body.data.transfers[0].id) === Number(transfer.id),
        byRef.raw
    );

    const futureOnly = await request('GET', `/api/transfers?date_from=${dayOffset(5)}`, {
        token: adminToken
    });
    check(
        'a future date_from returns no rows',
        futureOnly.status === 200 &&
            !!futureOnly.body.data &&
            futureOnly.body.data.transfers.length === 0,
        futureOnly.raw
    );

    const sortedAsc = await request('GET', '/api/transfers?sort_by=transfer_date&sort_dir=asc', {
        token: adminToken
    });
    check(
        'ascending sort is accepted',
        sortedAsc.status === 200 && !!sortedAsc.body.data,
        sortedAsc.raw
    );

    const paged = await request('GET', '/api/transfers?limit=1&offset=0', { token: adminToken });
    check(
        'limit/offset paging returns one row but the true total',
        paged.status === 200 &&
            !!paged.body.data &&
            paged.body.data.transfers.length === 1 &&
            paged.body.data.total > 1,
        paged.raw
    );

    const byIdFetch = await request('GET', `/api/transfers/${transfer.id}`, {
        token: auditorToken
    });
    check('GET /api/transfers/:id returns the movement', byIdFetch.status === 200, byIdFetch.raw);
    check(
        'the joined asset details are included',
        !!byIdFetch.body.data.transfer &&
            byIdFetch.body.data.transfer.asset_code === asset.asset_id &&
            byIdFetch.body.data.transfer.asset_tag === asset.asset_tag,
        byIdFetch.raw
    );

    const byRefFetch = await request('GET', `/api/transfers/${transfer.transfer_ref}`, {
        token: auditorToken
    });
    check(
        'GET /api/transfers/:ref resolves a TRF- reference',
        byRefFetch.status === 200 &&
            !!byRefFetch.body.data.transfer &&
            Number(byRefFetch.body.data.transfer.id) === Number(transfer.id),
        byRefFetch.raw
    );

    const missing = await request('GET', '/api/transfers/999999999', { token: adminToken });
    check('an unknown transfer id returns 404', missing.status === 404, missing.raw);

    const recent = await request('GET', '/api/transfers/recent?limit=3', { token: adminToken });
    check('GET /api/transfers/recent returns 200', recent.status === 200, recent.raw);
    check(
        'recent transfers respects the limit',
        !!recent.body.data && recent.body.data.transfers.length <= 3,
        recent.raw
    );

    const unack = await request('GET', '/api/transfers/unacknowledged', {
        token: adminToken
    });
    check('GET /api/transfers/unacknowledged returns 200', unack.status === 200, unack.raw);
    check(
        'every "unacknowledged" row really has no signature',
        !!unack.body.data &&
            unack.body.data.transfers.every((row) => !row.receiving_party_acknowledged_at),
        unack.raw
    );

    const statsNow = await request('GET', '/api/transfers/stats', { token: adminToken });
    check(
        'stats counts the movements we created',
        !!statsNow.body &&
            !!statsNow.body.data &&
            statsNow.body.data.total >= 5 &&
            statsNow.body.data.cancelled >= 1 &&
            statsNow.body.data.reversed >= 1,
        statsNow.raw
    );
    check(
        'stats reports the status breakdown',
        !!statsNow.body.data &&
            Array.isArray(statsNow.body.data.byStatus) &&
            statsNow.body.data.byStatus.some((row) => row.status === 'Cancelled'),
        statsNow.raw
    );
    check(
        'stats reports a destination breakdown',
        !!statsNow.body.data && statsNow.body.data.byDestination.length > 0,
        statsNow.raw
    );


    /* ---------------------------------------------------------------- */
    section('15. Audit trail');
    /* ---------------------------------------------------------------- */
    const [auditRows] = await db.query(
        `SELECT action, COUNT(*) AS total
         FROM audit_logs
         WHERE table_name = 'transfers' AND record_id IN (?)
         GROUP BY action`,
        [createdTransferIds]
    );

    const auditActions = {};
    for (const row of auditRows) auditActions[row.action] = Number(row.total);
    const auditSummary = JSON.stringify(auditActions);

    check('an audit entry is written for a recorded transfer', !!auditActions.TRANSFER, auditSummary);
    check('an audit entry is written for a correction', !!auditActions.UPDATE, auditSummary);
    check(
        'an audit entry is written for an acknowledgement',
        !!auditActions.ACKNOWLEDGE,
        auditSummary
    );
    check('an audit entry is written for a cancellation', !!auditActions.CANCEL, auditSummary);
    check('an audit entry is written for a reversal', !!auditActions.REVERSE, auditSummary);

    const [journalRows] = await db.query(
        `SELECT old_values, new_values
         FROM audit_logs
         WHERE table_name = 'transfers' AND record_id = ? AND action = 'TRANSFER'
         ORDER BY id DESC
         LIMIT 1`,
        [transfer.id]
    );

    let journal = null;
    if (journalRows.length) {
        const parse = (v) => {
            if (v === null || v === undefined) return null;
            if (typeof v === 'object') return v;
            try {
                return JSON.parse(v);
            } catch (e) {
                return null;
            }
        };
        journal = {
            old: parse(journalRows[0].old_values),
            next: parse(journalRows[0].new_values)
        };
    }

    check(
        'the audit journal records the OLD custodian and location',
        !!journal &&
            !!journal.old &&
            journal.old.custodian === deptUser.fullName &&
            journal.old.location === 'Head Office',
        journal ? JSON.stringify(journal.old) : 'no journal row'
    );

    check(
        'the audit journal records the NEW custodian and location',
        !!journal &&
            !!journal.next &&
            journal.next.custodian === otherDeptUser.fullName &&
            journal.next.location === 'Bulawayo Branch',
        journal ? JSON.stringify(journal.next) : 'no journal row'
    );

    /* ---------------------------------------------------------------- */
    section('16. Resilience');
    /* ---------------------------------------------------------------- */
    const unknownSubRoute = await request('GET', '/api/transfers/1/does-not-exist', {
        token: adminToken
    });
    check(
        'an unknown transfer sub-route returns 404',
        unknownSubRoute.status === 404,
        unknownSubRoute.raw
    );

    const badId = await request('PATCH', '/api/transfers/not-a-number/cancel', {
        token: adminToken,
        body: {}
    });
    check('a non-numeric transfer id is rejected (400)', badId.status === 400, badId.raw);

    // A malformed JSON body must produce 400, never a 500 crash.
    const badJson = await new Promise((resolve, reject) => {
        const payload = '{"asset_id": 1, ';
        const req = http.request(
            `${BASE}/api/transfers`,
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


    /* ---------------------------------------------------------------- */
    section('17. Model-level checks (direct database access)');
    /* ---------------------------------------------------------------- */
    const rowCount = await transferModel.countByAssetId(asset.id);
    check(
        'countByAssetId counts every movement of the asset',
        rowCount === 3,
        `count: ${rowCount}`
    );

    const byRefModel = await transferModel.findByRef(transfer.transfer_ref);
    check(
        'findByRef resolves a reference',
        !!byRefModel && Number(byRefModel.id) === Number(transfer.id),
        byRefModel ? `id: ${byRefModel.id}` : 'not found'
    );

    const refSuffix = await transferModel.findMaxRefSuffix('TRF-');
    check('findMaxRefSuffix returns a positive number', refSuffix > 0, `suffix: ${refSuffix}`);

    const refTaken = await transferModel.transferRefExists(transfer.transfer_ref);
    check('transferRefExists detects a used reference', refTaken === true, `taken: ${refTaken}`);

    const refFree = await transferModel.transferRefExists(`TRF-${stamp}-NOPE`);
    check('transferRefExists clears an unused reference', refFree === false, `free: ${refFree}`);

    const outbound = await transferModel.findByUserId(ctx.deptId, { direction: 'out' });
    check(
        "findByUserId('out') returns only that custodian's handovers",
        Array.isArray(outbound) &&
            outbound.length > 0 &&
            outbound.every((row) => Number(row.from_user_id) === Number(ctx.deptId)),
        `rows: ${outbound.length}`
    );

    const inbound = await transferModel.findByUserId(ctx.otherDeptId, { direction: 'in' });
    check(
        "findByUserId('in') returns only that custodian's receipts",
        Array.isArray(inbound) &&
            inbound.length > 0 &&
            inbound.every((row) => Number(row.to_user_id) === Number(ctx.otherDeptId)),
        `rows: ${inbound.length}`
    );

    // The asset's live custody must match the last recorded movement.
    const liveAssignment = await assignmentModel.findActiveByAssetId(asset.id);
    check(
        'the live custody row matches the final transfer destination',
        !!liveAssignment && Number(liveAssignment.assigned_user_id) === Number(ctx.deptId),
        liveAssignment
            ? `live custodian: ${liveAssignment.assigned_user_id}, expected: ${ctx.deptId}`
            : 'no open custody row'
    );
}

/* -------------------------------------------------------------------------
 * Bootstrap: start server, run suite, always clean up, exit explicitly.
 * ---------------------------------------------------------------------- */
server = app.listen(PORT, async () => {
    console.log('======================================================');
    console.log('  NBSZ Asset Management - Transfer Test Suite');
    console.log('======================================================');
    console.log(`Target: ${BASE}`);
    console.log(`Time:   ${new Date().toISOString()}`);

    let failure = null;
    try {
        await connectDb();
        // The transfer module owns its own DDL so the suite can run on a
        // database that has not had scripts/initDb.js re-applied. The
        // assignment table is a dependency (transfers.assignment_id) and is
        // created by the assignment module.
        await assignmentModel.ensureTable();
        await transferModel.ensureTable();
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
