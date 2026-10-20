'use strict';

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { hash } = require('bcryptjs');
const app = require('../server');
const { DOCUMENT_DIRECTORY } = require('../middleware/assetDocumentUpload');

const PORT = Number(process.env.ASSET_DOCUMENT_TEST_PORT || 3996);
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

function request(method, endpoint, { token, body, contentType } = {}) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body) {
            headers['Content-Type'] = contentType || 'application/json';
            headers['Content-Length'] = body.length;
        }
        const req = http.request(`${BASE}${endpoint}`, { method, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const buffer = Buffer.concat(chunks);
                let parsed = buffer;
                if ((res.headers['content-type'] || '').includes('application/json')) {
                    try {
                        parsed = JSON.parse(buffer.toString('utf8'));
                    } catch {
                        parsed = buffer.toString('utf8');
                    }
                }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function multipart(filename, bytes) {
    const boundary = `----asset-doc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);
    return { boundary, body };
}

async function createUser(username, role) {
    const password = `AssetDocs-${Date.now()}-${Math.random()}!`;
    const passwordHash = await hash(password, 10);
    const [created] = await db.query(
        `INSERT INTO users (username, password_hash, email, full_name, role, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [username, passwordHash, `${username}@nbsz.co.zw`, username, role]
    );
    userIds.push(created.insertId);
    const login = await request('POST', '/api/auth/login', {
        body: Buffer.from(JSON.stringify({ username, password }))
    });
    return { id: created.insertId, token: login.body?.data?.token };
}

async function cleanup() {
    if (!db) return;
    if (assetIds.length) {
        const [documents] = await db.query(
            'SELECT stored_name FROM asset_documents WHERE asset_id IN (?)',
            [assetIds]
        );
        for (const document of documents) {
            await fs.promises.unlink(path.join(DOCUMENT_DIRECTORY, document.stored_name))
                .catch((error) => {
                    if (error.code !== 'ENOENT') throw error;
                });
        }
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
    const documentModel = require('../models/assetDocumentModel');
    await documentModel.ensureTable();

    const stamp = Date.now().toString().slice(-8);
    const ict = await createUser(`asset_docs_ict_${stamp}`, 'ICT Officer');
    const auditor = await createUser(`asset_docs_auditor_${stamp}`, 'Auditor');
    const departmental = await createUser(`asset_docs_dept_${stamp}`, 'Departmental User');
    check('Document test users authenticate', Boolean(ict.token && auditor.token && departmental.token));

    const created = await request('POST', '/api/assets', {
        token: ict.token,
        body: Buffer.from(JSON.stringify({
            asset_tag: `DOC-${stamp}`,
            location: 'Document test location'
        }))
    });
    const assetId = created.body?.data?.asset?.id;
    if (assetId) assetIds.push(assetId);
    check('Document test asset created', created.status === 201 && Boolean(assetId), JSON.stringify(created.body));
    if (!assetId) return;

    const file = Buffer.from('%PDF-1.7\nDocument fixture\n');
    const upload = multipart('invoice.pdf', file);
    const response = await request('POST', `/api/assets/${assetId}/documents`, {
        token: ict.token,
        body: upload.body,
        contentType: `multipart/form-data; boundary=${upload.boundary}`
    });
    const documentId = response.body?.data?.document?.id;
    check('Authorized ICT user can upload a PDF',
        response.status === 201 && response.body?.data?.document?.original_name === 'invoice.pdf',
        JSON.stringify(response.body));

    const [stored] = await db.query(
        'SELECT stored_name FROM asset_documents WHERE id = ?',
        [documentId || 0]
    );
    const privateUrl = stored[0] ? `/uploads/asset-documents/${stored[0].stored_name}` : '/uploads/test.pdf';
    const publicFile = await request('GET', privateUrl);
    check('Uploaded documents are not accessible as public static files', publicFile.status === 404);

    const anonymous = await request('GET', `/api/assets/${assetId}/documents`);
    check('Document list requires authentication', anonymous.status === 401);

    const forbidden = await request('GET', `/api/assets/${assetId}/documents`, {
        token: departmental.token
    });
    check('Departmental users cannot access attached documents', forbidden.status === 403);

    const listed = await request('GET', `/api/assets/${assetId}/documents`, { token: auditor.token });
    check('Auditors can list asset documents',
        listed.status === 200 && listed.body?.data?.documents?.length === 1);

    const downloaded = await request('GET', `/api/assets/${assetId}/documents/${documentId}`, {
        token: auditor.token
    });
    check('Document download requires authorized access and is attachment-only',
        downloaded.status === 200 && downloaded.body.equals(file) &&
        downloaded.headers['content-disposition']?.includes('attachment') &&
        downloaded.headers['x-content-type-options'] === 'nosniff');

    const invalid = multipart('fake.pdf', Buffer.from('<html>not a pdf</html>'));
    const rejected = await request('POST', `/api/assets/${assetId}/documents`, {
        token: ict.token,
        body: invalid.body,
        contentType: `multipart/form-data; boundary=${invalid.boundary}`
    });
    check('File content is checked against the declared type', rejected.status === 400);

    const unsupported = multipart('invoice.html', Buffer.from('<html>not a document</html>'));
    const unsupportedType = await request('POST', `/api/assets/${assetId}/documents`, {
        token: ict.token,
        body: unsupported.body,
        contentType: `multipart/form-data; boundary=${unsupported.boundary}`
    });
    check('Unsupported document formats are rejected', unsupportedType.status === 400);

    const deleted = await request('DELETE', `/api/assets/${assetId}/documents/${documentId}`, {
        token: ict.token
    });
    check('Authorized user can remove a document', deleted.status === 200, JSON.stringify(deleted.body));
    const missing = await request('GET', `/api/assets/${assetId}/documents/${documentId}`, {
        token: auditor.token
    });
    check('Deleted documents cannot be downloaded', missing.status === 404);
}

server = app.listen(PORT, async () => {
    console.log(`\nAsset document tests on port ${PORT}`);
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
            console.log(`\nAsset document tests: ${passed}/${results.length} passed.`);
            process.exit(passed === results.length ? 0 : 1);
        });
        setTimeout(() => {
            const passed = results.filter(Boolean).length;
            process.exit(passed === results.length ? 0 : 1);
        }, 3000).unref();
    }
});
