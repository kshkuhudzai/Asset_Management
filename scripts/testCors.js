'use strict';

process.env.CORS_ORIGINS = 'https://portal.nbsz.co.zw, https://reports.nbsz.co.zw';
require('dotenv').config();

const http = require('http');
const app = require('../server');

const PORT = Number(process.env.CORS_TEST_PORT || 3995);
const results = [];

function check(name, passed, detail) {
    results.push(Boolean(passed));
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${!passed && detail ? `: ${detail}` : ''}`);
}

function request(origin) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (origin) headers.Origin = origin;
        const req = http.request(`http://127.0.0.1:${PORT}/api/health`, { headers }, (res) => {
            res.resume();
            res.on('end', () => resolve({
                status: res.statusCode,
                allowOrigin: res.headers['access-control-allow-origin']
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

const server = app.listen(PORT, async () => {
    try {
        const allowed = await request('https://portal.nbsz.co.zw');
        check('Configured origin receives CORS access',
            allowed.status === 200 && allowed.allowOrigin === 'https://portal.nbsz.co.zw');

        const secondAllowed = await request('https://reports.nbsz.co.zw');
        check('Second configured origin receives CORS access',
            secondAllowed.status === 200 && secondAllowed.allowOrigin === 'https://reports.nbsz.co.zw');

        const denied = await request('https://untrusted.example');
        check('Unconfigured origin is not granted CORS access',
            denied.status === 200 && !denied.allowOrigin);

        const sameOrigin = await request(null);
        check('Same-origin and non-browser requests continue to work', sameOrigin.status === 200);
    } catch (error) {
        console.error(error);
        results.push(false);
    } finally {
        server.close(() => {
            const passed = results.filter(Boolean).length;
            console.log(`\nCORS tests: ${passed}/${results.length} passed.`);
            process.exit(passed === results.length ? 0 : 1);
        });
    }
});
