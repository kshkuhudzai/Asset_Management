'use strict';

/**
 * scripts/testAuth.js
 * ---------------------------------------------------------------------------
 * Standalone smoke/regression test for the authentication slice.
 *
 * Boots the real Express app (which also verifies the MySQL connection) on an
 * isolated port, fires real HTTP requests at it, and asserts on the responses.
 * No test-runner dependency is required - run it with:
 *
 *     node scripts/testAuth.js
 *
 * Exit code 0 = all checks passed, 1 = at least one check failed.
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const http = require('http');
const app = require('../server');

// Dedicated port so this can run even while the dev server is up.
const PORT = process.env.TEST_PORT || 3999;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let server = null;

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
function request(method, path, { body, token, cookie, extraHeaders = {} } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;

        const headers = { Accept: 'application/json' };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (token) headers.Authorization = `Bearer ${token}`;

        if (cookie) headers.Cookie = cookie;
        Object.assign(headers, extraHeaders);
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
                resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/* -------------------------------------------------------------------------
 * The test suite
 * ---------------------------------------------------------------------- */
async function run() {
    let adminToken = null;

    /* ---------------------------------------------------------------- */
    section('1. Infrastructure');
    /* ---------------------------------------------------------------- */
    const health = await request('GET', '/api/health');
    check('GET /api/health returns 200', health.status === 200, `got ${health.status}`);
    check(
        'health payload reports success',
        health.body && health.body.status === 'success',
        health.raw
    );

    const notFound = await request('GET', '/api/definitely-not-a-route');
    check(
        'unknown route returns a 404 JSON envelope',
        notFound.status === 404 && notFound.body && notFound.body.status === 'error',
        `${notFound.status} ${notFound.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('2. Login - happy path');
    /* ---------------------------------------------------------------- */
    const login = await request('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'Admin@123' }
    });
    check('POST /api/auth/login returns 200', login.status === 200, `${login.status} ${login.raw}`);
    check(
        'response uses the shared { status, message, data } envelope',
        login.body && login.body.status === 'success' && login.body.message === 'Login successful.',
        login.raw
    );

    // The token and user live under `data` (see utils/helpers.js successResponse).
    const loginData = login.body && login.body.data;
    const setCookie = login.headers && login.headers['set-cookie'];
    const sessionCookie = Array.isArray(setCookie) && setCookie.length
        ? setCookie[0].split(';')[0]
        : null;
    check(
        'login sets an HttpOnly, SameSite cookie scoped to /api',
        Array.isArray(setCookie) &&
            setCookie.some((cookie) =>
                /HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie) && /Path=\/api/i.test(cookie)
            ),
        JSON.stringify(setCookie)
    );

    check(
        'response contains a JWT under data.token',
        loginData && typeof loginData.token === 'string' && loginData.token.length > 20,
        login.raw
    );
    check(
        'response contains the admin profile under data.user',
        loginData && loginData.user && loginData.user.username === 'admin',
        login.raw
    );
    check(
        'profile includes a role',
        loginData && loginData.user && typeof loginData.user.role === 'string',
        login.raw
    );
    check(
        'profile includes a numeric id',
        loginData && loginData.user && Number.isInteger(loginData.user.id),
        login.raw
    );
    check(
        'password hash is never returned to the client',
        login.body && JSON.stringify(login.body).indexOf('$2') === -1,
        'a bcrypt-looking hash was found in the response'
    );

    const jwtParts = loginData && loginData.token ? loginData.token.split('.') : [];
    check('token is a well-formed 3-part JWT', jwtParts.length === 3, `got ${jwtParts.length} parts`);

    adminToken = loginData && loginData.token;
    const cookieMe = await request('GET', '/api/auth/me', { cookie: sessionCookie });
    check(
        'cookie authenticates requests without a bearer token',
        cookieMe.status === 200,
        `${cookieMe.status} ${cookieMe.raw}`
    );

    const crossOriginWrite = await request('PATCH', '/api/auth/me', {
        cookie: sessionCookie,
        body: { full_name: 'Cross-origin change' },
        extraHeaders: { Origin: 'https://attacker.example' }
    });
    check(
        'cookie-authenticated cross-origin writes are rejected',
        crossOriginWrite.status === 403,
        `${crossOriginWrite.status} ${crossOriginWrite.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('3. Login - negative paths');
    /* ---------------------------------------------------------------- */
    const badPassword = await request('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'definitely-wrong' }
    });
    check('wrong password is rejected with 401', badPassword.status === 401, `${badPassword.status} ${badPassword.raw}`);

    const badUser = await request('POST', '/api/auth/login', {
        body: { username: 'no-such-user-xyz', password: 'whatever' }
    });
    check('unknown username is rejected with 401', badUser.status === 401, `${badUser.status} ${badUser.raw}`);

    const missingFields = await request('POST', '/api/auth/login', { body: {} });
    check('empty body is rejected with 400', missingFields.status === 400, `${missingFields.status} ${missingFields.raw}`);

    /* ---------------------------------------------------------------- */
    section('4. Token validation');
    /* ---------------------------------------------------------------- */
    const me = await request('GET', '/api/auth/me', { token: adminToken });
    check('GET /api/auth/me with a valid token returns 200', me.status === 200, `${me.status} ${me.raw}`);
    check(
        'GET /api/auth/me returns the authenticated user under data.user',
        me.body && me.body.data && me.body.data.user && me.body.data.user.username === 'admin',
        me.raw
    );
    check(
        'GET /api/auth/me never leaks the password hash',
        me.body && JSON.stringify(me.body).indexOf('$2') === -1,
        'a bcrypt-looking hash was found in the response'
    );

    const noToken = await request('GET', '/api/auth/me');
    check('GET /api/auth/me with no token returns 401', noToken.status === 401, `${noToken.status} ${noToken.raw}`);

    const badToken = await request('GET', '/api/auth/me', { token: 'not.a.real.jwt' });
    check('GET /api/auth/me with a malformed token returns 401', badToken.status === 401, `${badToken.status} ${badToken.raw}`);

    // A syntactically valid JWT signed with the wrong secret must be rejected.
    const forgedToken =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
        'eyJpZCI6MSwidXNlcm5hbWUiOiJhZG1pbiIsInJvbGUiOiJTeXN0ZW0gQWRtaW5pc3RyYXRvciJ9.' +
        'this-signature-is-not-valid';
    const forged = await request('GET', '/api/auth/me', { token: forgedToken });
    check(
        'GET /api/auth/me rejects a forged signature with 401',
        forged.status === 401,
        `${forged.status} ${forged.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('4b. RBAC enforcement');
    /* ---------------------------------------------------------------- */
    // /api/auth/users is restricted to System Administrator + HISO.
    const usersWithValidToken = await request('GET', '/api/auth/users', { token: adminToken });
    check(
        'GET /api/auth/users succeeds for the System Administrator',
        usersWithValidToken.status === 200,
        `${usersWithValidToken.status} ${usersWithValidToken.raw}`
    );
    check(
        'user list is returned under data',
        usersWithValidToken.body && usersWithValidToken.body.data !== undefined,
        usersWithValidToken.raw
    );

    const usersAnon = await request('GET', '/api/auth/users');
    check(
        'GET /api/auth/users without a token returns 401',
        usersAnon.status === 401,
        `${usersAnon.status} ${usersAnon.raw}`
    );

    /* ---------------------------------------------------------------- */
    section('5. Malformed input handling');
    /* ---------------------------------------------------------------- */
    const badJson = await new Promise((resolve, reject) => {
        const payload = '{"username": "admin", ';
        const req = http.request(
            `${BASE}/api/auth/login`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
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
    check('malformed JSON returns 400 (no 500 crash)', badJson.status === 400, `${badJson.status} ${badJson.raw}`);

    /* ---------------------------------------------------------------- */
    section('6. Audit middleware smoke check');
    /* ---------------------------------------------------------------- */
    // Every login attempt above was routed through auditMiddleware. A clean run
    // proves it did not throw. Content-level audit assertions belong in the
    // next module's test suite.
    check(
        'login flow completed without server-side exceptions',
        login.status === 200,
        'check the server console for stack traces'
    );
}

/* -------------------------------------------------------------------------
 * Bootstrap: start server, run suite, always clean up, exit explicitly.
 * ---------------------------------------------------------------------- */
server = app.listen(PORT, async () => {
    console.log('======================================================');
    console.log('  NBSZ Asset Management - Auth Slice Test Suite');
    console.log('======================================================');
    console.log(`Target: ${BASE}`);
    console.log(`Time:   ${new Date().toISOString()}`);

    let failure = null;
    try {
        await run();
    } catch (err) {
        failure = err;
        console.error('\nUnhandled error while running tests:');
        console.error(err && err.stack ? err.stack : err);
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
    setTimeout(() => process.exit(exitCode), 2000).unref();
});
