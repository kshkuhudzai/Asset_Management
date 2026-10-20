'use strict';

// scripts/smokeTestAuth.js
// End-to-end smoke test for the authentication layer. Start the server first
// (npm start) then run: node scripts/smokeTestAuth.js
//
// Exercises: health -> login (bad + good) -> getMe -> updateMe ->
// register -> list/get/update -> change-password -> reset-password ->
// deactivate/activate -> soft delete -> audit logs -> RBAC denial -> logout.

require('dotenv').config();

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000/api';
const mysql = require('mysql2/promise');
const testUsernames = new Set();

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
    if (condition) {
        passed += 1;
        console.log(`  PASS  ${label}`);
    } else {
        failed += 1;
        console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
    }
}

async function call(method, path, { body, token } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await res.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch (err) {
        json = { raw: text };
    }
    return { status: res.status, body: json };
}

async function runSmokeTests() {
    console.log(`\nRunning auth smoke tests against ${BASE}\n`);

    /* 1. Health ---------------------------------------------------------- */
    console.log('[1] Health check');
    const health = await call('GET', '/health');
    check('GET /health returns 200', health.status === 200, `got ${health.status}`);

    /* 2. Login rejections ------------------------------------------------ */
    console.log('\n[2] Login rejections');
    const bad = await call('POST', '/auth/login', {
        body: { username: 'admin', password: 'definitely-wrong' }
    });
    check('Wrong password -> 401', bad.status === 401, `got ${bad.status}`);

    const missing = await call('POST', '/auth/login', { body: {} });
    check('Missing fields -> 400', missing.status === 400, `got ${missing.status}`);

    const noAuth = await call('GET', '/auth/me');
    check('No token -> 401', noAuth.status === 401, `got ${noAuth.status}`);

    const badToken = await call('GET', '/auth/me', { token: 'not.a.real.token' });
    check('Bad token -> 401', badToken.status === 401, `got ${badToken.status}`);

    /* 3. Login success --------------------------------------------------- */
    console.log('\n[3] Login success');
    const login = await call('POST', '/auth/login', {
        body: { username: 'admin', password: 'Admin@123' }
    });
    check('Valid credentials -> 200', login.status === 200, `got ${login.status}`);
    check('Token returned', Boolean(login.body && login.body.data && login.body.data.token));
    check(
        'Password hash not leaked',
        login.body && login.body.data && login.body.data.user &&
            login.body.data.user.password_hash === undefined
    );
    const adminToken = login.body && login.body.data ? login.body.data.token : null;

    /* 4. getMe ----------------------------------------------------------- */
    console.log('\n[4] GET /auth/me');
    const me = await call('GET', '/auth/me', { token: adminToken });
    check('Valid token -> 200', me.status === 200, `got ${me.status}`);
    check('Correct user returned', me.body.data.user.username === 'admin');

    /* 5. updateMe -------------------------------------------------------- */
    console.log('\n[5] PATCH /auth/me');
    const patch = await call('PATCH', '/auth/me', {
        token: adminToken,
        body: { full_name: 'System Administrator' }
    });
    check('Profile update -> 200', patch.status === 200, `got ${patch.status}`);

    const patchBad = await call('PATCH', '/auth/me', {
        token: adminToken,
        body: { email: 'not-an-email' }
    });
    check('Invalid email -> 400', patchBad.status === 400, `got ${patchBad.status}`);

    /* 6. Register -------------------------------------------------------- */
    console.log('\n[6] POST /auth/register');
    const uniq = Date.now();
    const newUser = {
        username: `smoke_${uniq}`,
        password: 'SmokeTest123!',
        email: `smoke_${uniq}@nbsz.co.zw`,
        full_name: 'Smoke Test User',
        role: 'ICT Officer',
        must_change_password: false
    };
    testUsernames.add(newUser.username);
    const reg = await call('POST', '/auth/register', {
        token: adminToken,
        body: newUser
    });
    check('Register -> 201', reg.status === 201, `got ${reg.status}`);
    const newUserId = reg.body.data.user.id;

    const onboardingUser = {
        username: `onboarding_${uniq}`,
        password: 'Temporary123!',
        email: `onboarding_${uniq}@nbsz.co.zw`,
        full_name: 'First Login Test',
        role: 'ICT Officer'
    };
    testUsernames.add(onboardingUser.username);
    const onboardingRegistration = await call('POST', '/auth/register', {
        token: adminToken,
        body: onboardingUser
    });
    check('Registration defaults to requiring a first-login password change',
        onboardingRegistration.status === 201 &&
            onboardingRegistration.body.data.user.must_change_password === true);
    const onboardingLogin = await call('POST', '/auth/login', {
        body: { username: onboardingUser.username, password: onboardingUser.password }
    });
    const onboardingToken = onboardingLogin.body.data.token;
    check('New user can sign in with the temporary password', onboardingLogin.status === 200);
    const blockedBeforeChange = await call('GET', '/assets', { token: onboardingToken });
    check('Temporary password blocks normal API access', blockedBeforeChange.status === 403);
    const firstPasswordChange = await call('POST', '/auth/change-password', {
        token: onboardingToken,
        body: {
            current_password: onboardingUser.password,
            new_password: 'Permanent123!',
            confirm_password: 'Permanent123!'
        }
    });
    check('User can complete the required password change', firstPasswordChange.status === 200);
    const allowedAfterChange = await call('GET', '/assets', { token: onboardingToken });
    check('Normal API access is restored after password change', allowedAfterChange.status === 200);
    await call('DELETE', `/auth/users/${onboardingRegistration.body.data.user.id}`, {
        token: adminToken
    });

    const dup = await call('POST', '/auth/register', {
        token: adminToken,
        body: newUser
    });
    check('Duplicate username/email -> 409', dup.status === 409, `got ${dup.status}`);

    const weak = await call('POST', '/auth/register', {
        token: adminToken,
        body: {
            username: `weak_${uniq}`,
            password: 'short',
            email: `w${uniq}@nbsz.co.zw`,
            full_name: 'W',
            role: 'Auditor'
        }
    });
    check('Weak password -> 400', weak.status === 400, `got ${weak.status}`);

    const weakPasswords = [
        ['missing uppercase letter', 'validpass1!'],
        ['missing lowercase letter', 'VALIDPASS1!'],
        ['missing number', 'ValidPass!!'],
        ['missing special character', 'ValidPass123']
    ];
    for (const [reason, password] of weakPasswords) {
        const invalidPassword = await call('POST', '/auth/register', {
            token: adminToken,
            body: {
                username: `weak_${reason.replace(/\W/g, '')}_${uniq}`,
                password,
                email: `w${reason.replace(/\W/g, '')}${uniq}@nbsz.co.zw`,
                full_name: 'Weak Password Test',
                role: 'Auditor'
            }
        });
        check(`Password ${reason} -> 400`, invalidPassword.status === 400, `got ${invalidPassword.status}`);
    }

    const badRole = await call('POST', '/auth/register', {
        token: adminToken,
        body: {
            username: `r_${uniq}`,
            password: 'ValidPass123!',
            email: `r${uniq}@nbsz.co.zw`,
            full_name: 'R',
            role: 'Wizard'
        }
    });
    check('Invalid role -> 400', badRole.status === 400, `got ${badRole.status}`);

    /* 7. Listing / detail ------------------------------------------------ */
    console.log('\n[7] User listing / detail');
    const list = await call('GET', '/auth/users?limit=10', { token: adminToken });
    check('List users -> 200', list.status === 200, `got ${list.status}`);
    check('Pagination returned', Boolean(list.body.data.pagination));
    check(
        'No password hashes in list',
        Array.isArray(list.body.data.users) &&
            list.body.data.users.every((u) => u.password_hash === undefined)
    );

    const search = await call('GET', `/auth/users?search=smoke_${uniq}`, {
        token: adminToken
    });
    check(
        'Search filter works',
        search.body.data.pagination.total === 1,
        `total=${search.body.data.pagination.total}`
    );

    const one = await call('GET', `/auth/users/${newUserId}`, { token: adminToken });
    check('Get user by id -> 200', one.status === 200, `got ${one.status}`);

    const missingUser = await call('GET', '/auth/users/999999', { token: adminToken });
    check('Unknown user -> 404', missingUser.status === 404, `got ${missingUser.status}`);

    /* 8. Update + safety rails ------------------------------------------- */
    console.log('\n[8] PUT /auth/users/:id');
    const upd = await call('PUT', `/auth/users/${newUserId}`, {
        token: adminToken,
        body: { full_name: 'Smoke Test Updated', role: 'Auditor' }
    });
    check('Update user -> 200', upd.status === 200, `got ${upd.status}`);
    check('Role changed', upd.body.data.user.role === 'Auditor');

    const selfDemote = await call('PUT', '/auth/users/1', {
        token: adminToken,
        body: { role: 'Auditor' }
    });
    check('Cannot demote self -> 400', selfDemote.status === 400, `got ${selfDemote.status}`);

    const selfDelete = await call('DELETE', '/auth/users/1', { token: adminToken });
    check('Cannot delete self -> 400', selfDelete.status === 400, `got ${selfDelete.status}`);

    /* 9. RBAC ------------------------------------------------------------ */
    console.log('\n[9] RBAC enforcement');
    const auditorLogin = await call('POST', '/auth/login', {
        body: { username: newUser.username, password: newUser.password }
    });
    check('Auditor can log in', auditorLogin.status === 200, `got ${auditorLogin.status}`);
    const auditorToken = auditorLogin.body.data.token;

    const auditorList = await call('GET', '/auth/users', { token: auditorToken });
    check(
        'Auditor blocked from user list -> 403',
        auditorList.status === 403,
        `got ${auditorList.status}`
    );

    const auditorRegister = await call('POST', '/auth/register', {
        token: auditorToken,
        body: {
            username: 'x',
            password: 'ValidPass123!',
            email: 'x@y.co.zw',
            full_name: 'X',
            role: 'Auditor'
        }
    });
    check(
        'Auditor blocked from register -> 403',
        auditorRegister.status === 403,
        `got ${auditorRegister.status}`
    );

    const auditorLogs = await call('GET', '/auth/audit-logs', { token: auditorToken });
    check(
        'Auditor allowed on audit logs -> 200',
        auditorLogs.status === 200,
        `got ${auditorLogs.status}`
    );


    /* 10. change-password ------------------------------------------------ */
    console.log('\n[10] POST /auth/change-password');
    const wrongCurrent = await call('POST', '/auth/change-password', {
        token: auditorToken,
        body: { current_password: 'nope', new_password: 'BrandNew123!' }
    });
    check(
        'Wrong current password -> 400',
        wrongCurrent.status === 400,
        `got ${wrongCurrent.status}`
    );

    const sameSame = await call('POST', '/auth/change-password', {
        token: auditorToken,
        body: { current_password: 'SmokeTest123!', new_password: 'SmokeTest123!' }
    });
    check('Same as current -> 400', sameSame.status === 400, `got ${sameSame.status}`);

    const changed = await call('POST', '/auth/change-password', {
        token: auditorToken,
        body: {
            current_password: 'SmokeTest123!',
            new_password: 'BrandNew123!',
            confirm_password: 'BrandNew123!'
        }
    });
    check('Change password -> 200', changed.status === 200, `got ${changed.status}`);
    check('requireReLogin flag set', changed.body.data.requireReLogin === true);

    const oldPwLogin = await call('POST', '/auth/login', {
        body: { username: newUser.username, password: 'SmokeTest123!' }
    });
    check('Old password rejected -> 401', oldPwLogin.status === 401, `got ${oldPwLogin.status}`);

    const newPwLogin = await call('POST', '/auth/login', {
        body: { username: newUser.username, password: 'BrandNew123!' }
    });
    check('New password accepted -> 200', newPwLogin.status === 200, `got ${newPwLogin.status}`);

    /* 11. Admin password reset ------------------------------------------- */
    console.log('\n[11] POST /auth/users/:id/reset-password');
    const reset = await call('POST', `/auth/users/${newUserId}/reset-password`, {
        token: adminToken,
        body: { new_password: 'ResetByAdmin123!', confirm_password: 'ResetByAdmin123!' }
    });
    check('Admin reset -> 200', reset.status === 200, `got ${reset.status}`);

    const resetLogin = await call('POST', '/auth/login', {
        body: { username: newUser.username, password: 'ResetByAdmin123!' }
    });
    check('Reset password works -> 200', resetLogin.status === 200, `got ${resetLogin.status}`);
    const auditorToken2 = resetLogin.body.data.token;
    check(
        'Admin reset requires a first-login password change',
        reset.body.data.user.must_change_password === true &&
            resetLogin.body.data.user.must_change_password === true
    );
    const gated = await call('GET', '/auth/users', { token: auditorToken2 });
    check('Temporary password blocks normal API use -> 403', gated.status === 403, `got ${gated.status}`);
    const completedFirstLogin = await call('POST', '/auth/change-password', {
        token: auditorToken2,
        body: {
            current_password: 'ResetByAdmin123!',
            new_password: 'AfterReset123!',
            confirm_password: 'AfterReset123!'
        }
    });
    check('User can complete required first-login password change -> 200', completedFirstLogin.status === 200);

    /* 12. Soft delete / activate ----------------------------------------- */
    console.log('\n[12] Soft delete / activate');
    const del = await call('DELETE', `/auth/users/${newUserId}`, { token: adminToken });
    check('Delete user -> 200', del.status === 200, `got ${del.status}`);

    const deletedLogin = await call('POST', '/auth/login', {
        body: { username: newUser.username, password: 'AfterReset123!' }
    });
    check(
        'Deactivated user blocked -> 403',
        deletedLogin.status === 403,
        `got ${deletedLogin.status}`
    );

    const stale = await call('GET', '/auth/me', { token: auditorToken2 });
    check(
        'Existing token rejected after deactivation -> 403',
        stale.status === 403,
        `got ${stale.status}`
    );

    const react = await call('PATCH', `/auth/users/${newUserId}/activate`, {
        token: adminToken
    });
    check('Reactivate -> 200', react.status === 200, `got ${react.status}`);

    const relogin = await call('POST', '/auth/login', {
        body: { username: newUser.username, password: 'AfterReset123!' }
    });
    check('Reactivated user can log in -> 200', relogin.status === 200, `got ${relogin.status}`);


    /* 13. Audit log ------------------------------------------------------ */
    console.log('\n[13] GET /auth/audit-logs');
    const logs = await call('GET', '/auth/audit-logs?limit=5', { token: adminToken });
    check('Audit logs -> 200', logs.status === 200, `got ${logs.status}`);
    check('Logs present', (logs.body.data.logs.length || 0) > 0);

    const loginLogs = await call('GET', '/auth/audit-logs?action=LOGIN', {
        token: adminToken
    });
    check('Filter by action works', loginLogs.status === 200, `got ${loginLogs.status}`);
    check(
        'Actor name joined in',
        Boolean(loginLogs.body.data.logs[0] && loginLogs.body.data.logs[0].actor_username)
    );

    const failedLogs = await call('GET', '/auth/audit-logs?action=FAILED_LOGIN', {
        token: adminToken
    });
    check(
        'Failed logins recorded',
        (failedLogs.body.data.pagination.total || 0) > 0,
        `total=${failedLogs.body.data.pagination.total}`
    );

    const badDate = await call('GET', '/auth/audit-logs?date_from=01-01-2026', {
        token: adminToken
    });
    check('Bad date format -> 400', badDate.status === 400, `got ${badDate.status}`);

    /* 14. Logout --------------------------------------------------------- */
    console.log('\n[14] POST /auth/logout');
    const out = await call('POST', '/auth/logout', { token: adminToken });
    check('Logout -> 200', out.status === 200, `got ${out.status}`);

    /* 15. 404 handling --------------------------------------------------- */
    console.log('\n[15] 404 handling');
    const notFound = await call('GET', '/does-not-exist');
    check('Unknown route -> 404', notFound.status === 404, `got ${notFound.status}`);

    /* Summary ------------------------------------------------------------ */
    console.log('\n' + '='.repeat(62));
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('='.repeat(62) + '\n');

    if (failed > 0) process.exitCode = 1;
}

async function cleanupTestUsers() {
    if (testUsernames.size === 0) return;

    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        const [users] = await connection.query(
            'SELECT id FROM users WHERE username IN (?)',
            [[...testUsernames]]
        );
        const ids = users.map((user) => user.id);
        if (!ids.length) return;

        await connection.query('DELETE FROM audit_logs WHERE user_id IN (?)', [ids]);
        await connection.query('DELETE FROM users WHERE id IN (?)', [ids]);
    } finally {
        await connection.end();
    }
}

async function main() {
    try {
        await runSmokeTests();
    } finally {
        await cleanupTestUsers();
    }
}

main().catch((err) => {
    console.error('\nSmoke test crashed:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
