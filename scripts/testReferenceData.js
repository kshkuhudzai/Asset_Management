'use strict';

require('dotenv').config();

const http = require('http');
const crypto = require('crypto');
const db = require('../config/db');
const app = require('../server');

const PORT = Number(process.env.REFERENCE_TEST_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;
const suffix = crypto.randomBytes(5).toString('hex');
const departmentName = `Reference Test ${suffix}`;
const locationName = `Location Test ${suffix}`;
const results = [];
let server;
let adminToken;

function check(name, condition, detail) {
    results.push({ name, passed: Boolean(condition) });
    console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${name}${!condition && detail ? ` -> ${detail}` : ''}`);
}

function request(method, path, options = {}) {
    return new Promise((resolve, reject) => {
        const payload = options.body ? JSON.stringify(options.body) : null;
        const headers = { Accept: 'application/json' };
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (options.token) headers.Authorization = `Bearer ${options.token}`;
        const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let body = null;
                try { body = text ? JSON.parse(text) : null; } catch (error) { body = text; }
                resolve({ status: res.statusCode, body, text });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function run() {
    server = app.listen(PORT);
    const login = await request('POST', '/api/auth/login', {
        body: { username: 'admin', password: 'Admin@123' }
    });
    adminToken = login.body && login.body.data && login.body.data.token;
    check('administrator test login succeeds', login.status === 200 && Boolean(adminToken), login.text);
    if (!adminToken) return;

    const noAuth = await request('GET', '/api/reference-data');
    check('reference data requires an authenticated session', noAuth.status === 401, noAuth.text);

    const invalidType = await request('POST', '/api/reference-data/__proto__', {
        token: adminToken,
        body: { name: departmentName }
    });
    check('unknown reference type is rejected', invalidType.status === 404, invalidType.text);

    const invalidName = await request('POST', '/api/reference-data/departments', {
        token: adminToken,
        body: { name: '   ' }
    });
    check('blank reference names are rejected', invalidName.status === 400, invalidName.text);

    const createDepartment = await request('POST', '/api/reference-data/departments', {
        token: adminToken,
        body: { name: departmentName }
    });
    const departmentId = createDepartment.body && createDepartment.body.data && createDepartment.body.data.id;
    check('administrator can add a department', createDepartment.status === 201 && departmentId, createDepartment.text);

    const duplicateDepartment = await request('POST', '/api/reference-data/departments', {
        token: adminToken,
        body: { name: departmentName }
    });
    check('duplicate department names are rejected', duplicateDepartment.status === 409, duplicateDepartment.text);

    const createLocation = await request('POST', '/api/reference-data/locations', {
        token: adminToken,
        body: { name: locationName }
    });
    const locationId = createLocation.body && createLocation.body.data && createLocation.body.data.id;
    check('administrator can add a location', createLocation.status === 201 && locationId, createLocation.text);

    const deactivate = await request('PATCH', `/api/reference-data/departments/${departmentId}/status`, {
        token: adminToken,
        body: { is_active: false }
    });
    check('department can be deactivated without deletion', deactivate.status === 200, deactivate.text);

    const listInactive = await request('GET', '/api/reference-data', { token: adminToken });
    const listedDepartment = listInactive.body && listInactive.body.data &&
        listInactive.body.data.departments.find((item) => item.id === departmentId);
    check('inactive values remain visible to administrators', Boolean(listedDepartment && !listedDepartment.is_active), listInactive.text);

    const reactivate = await request('PATCH', `/api/reference-data/departments/${departmentId}/status`, {
        token: adminToken,
        body: { is_active: true }
    });
    check('department can be reactivated', reactivate.status === 200, reactivate.text);

    const badStatus = await request('PATCH', `/api/reference-data/locations/${locationId}/status`, {
        token: adminToken,
        body: { is_active: 'false' }
    });
    check('status changes require a boolean', badStatus.status === 400, badStatus.text);
}

run().catch((error) => {
    console.error(error);
    results.push({ name: 'test runner completes', passed: false });
}).finally(async () => {
    try {
        await db.query('DELETE FROM departments WHERE name = ?', [departmentName]);
        await db.query('DELETE FROM locations WHERE name = ?', [locationName]);
    } catch (error) {
        console.error('Could not clean up reference data fixtures:', error.message);
        results.push({ name: 'test fixtures cleaned up', passed: false });
    }
    const failed = results.filter((item) => !item.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    const exitCode = failed.length ? 1 : 0;
    if (server) server.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 3000).unref();
});
