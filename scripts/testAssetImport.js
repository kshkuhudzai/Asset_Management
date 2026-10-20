'use strict';

require('dotenv').config();

const http = require('http');
const mysql = require('mysql2/promise');
const { hash } = require('bcryptjs');
const app = require('../server');

const PORT = Number(process.env.ASSET_IMPORT_TEST_PORT || 3997);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const userIds = [];
const assetIds = [];
let server;
let db;

function check(name, passed, detail) {
    results.push(Boolean(passed));
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${!passed && detail ? `: ${detail}` : ''}`);
}

function request(method, path, { body, token, contentType = 'application/json' } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null
            : contentType === 'application/json' ? JSON.stringify(body) : body;
        const headers = { Accept: 'application/json' };
        if (payload !== null) {
            headers['Content-Type'] = contentType;
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (token) headers.Authorization = `Bearer ${token}`;

        const req = http.request(`${BASE}${path}`, { method, headers }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = raw ? JSON.parse(raw) : null;
                } catch {
                    parsed = raw;
                }
                resolve({ status: res.statusCode, body: parsed, raw });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

async function createUser(username, role) {
    const password = `AssetImport-${Date.now()}-${Math.random()}!`;
    const passwordHash = await hash(password, 10);
    const [created] = await db.query(
        `INSERT INTO users (username, password_hash, email, full_name, role, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [username, passwordHash, `${username}@nbsz.co.zw`, username, role]
    );
    userIds.push(created.insertId);
    const login = await request('POST', '/api/auth/login', {
        body: { username, password }
    });
    return { id: created.insertId, token: login.body?.data?.token };
}

async function cleanup() {
    if (!db) return;
    if (assetIds.length) {
        await db.query('DELETE FROM audit_logs WHERE table_name = ? AND record_id IN (?)', [
            'assets', assetIds
        ]);
        await db.query('DELETE FROM assets WHERE id IN (?)', [assetIds]);
    }
    if (userIds.length) {
        await db.query('DELETE FROM audit_logs WHERE user_id IN (?)', [userIds]);
        await db.query('DELETE FROM users WHERE id IN (?)', [userIds]);
    }
    await db.end();
}

async function run() {
    db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    const stamp = Date.now().toString().slice(-8);
    const ict = await createUser(`asset_import_ict_${stamp}`, 'ICT Officer');
    const departmental = await createUser(`asset_import_dept_${stamp}`, 'Departmental User');
    check('Import test accounts authenticate', Boolean(ict.token && departmental.token));

    const denied = await request('POST', '/api/assets/import', {
        token: departmental.token,
        body: 'asset_tag\nDENIED',
        contentType: 'text/csv'
    });
    check('Only asset writers can import CSV', denied.status === 403, denied.raw);

    const badCsv = await request('POST', '/api/assets/import', {
        token: ict.token,
        body: 'asset_tag,location\n"unterminated,ICT',
        contentType: 'text/csv'
    });
    check('Malformed CSV is rejected before import', badCsv.status === 400, badCsv.raw);

    const duplicateHeader = await request('POST', '/api/assets/import', {
        token: ict.token,
        body: 'asset_tag,asset_tag\nONE,TWO',
        contentType: 'text/csv'
    });
    check('Duplicate CSV column names are rejected', duplicateHeader.status === 400, duplicateHeader.raw);

    const tag = `IMPORT-${stamp}`;
    const csv = [
        'asset_tag,serial_number,location,department',
        `${tag},IMPORT-SN-${stamp},"Head Office, Block A",ICT`,
        `,IMPORT-MISSING-${stamp},ICT,ICT`,
        `${tag},IMPORT-DUP-${stamp},ICT,ICT`
    ].join('\r\n');
    const imported = await request('POST', '/api/assets/import', {
        token: ict.token,
        body: csv,
        contentType: 'text/csv'
    });
    const report = imported.body?.data;
    check('Valid and invalid rows produce a migration report',
        imported.status === 200 && report?.total === 3 &&
        report?.imported === 1 && report?.rejected === 2, imported.raw);

    const createdTag = report?.rows?.find((row) => row.status === 'Imported')?.asset_tag;
    if (createdTag) {
        const [assets] = await db.query(
            'SELECT id, location FROM assets WHERE asset_tag = ?',
            [createdTag]
        );
        assets.forEach((asset) => assetIds.push(asset.id));
        check('Quoted CSV values are imported intact',
            assets.length === 1 && assets[0].location === 'Head Office, Block A');
    } else {
        check('Quoted CSV values are imported intact', false);
    }

    const unsupported = await request('POST', '/api/assets/import', {
        token: ict.token,
        body: 'asset_tag,unknown_column\nX,Y',
        contentType: 'text/csv'
    });
    check('Unknown CSV columns are rejected', unsupported.status === 400, unsupported.raw);
}

server = app.listen(PORT, async () => {
    console.log(`\nAsset CSV import tests on port ${PORT}`);
    try {
        await run();
    } catch (error) {
        console.error(error);
        results.push(false);
    } finally {
        try {
            await cleanup();
        } catch (error) {
            console.error('Cleanup failed:', error.message);
            results.push(false);
        }
        server.close(() => {
            const passed = results.filter(Boolean).length;
            console.log(`\nAsset CSV import tests: ${passed}/${results.length} passed.`);
            process.exit(passed === results.length ? 0 : 1);
        });
        setTimeout(() => {
            const passed = results.filter(Boolean).length;
            process.exit(passed === results.length ? 0 : 1);
        }, 3000).unref();
    }
});
