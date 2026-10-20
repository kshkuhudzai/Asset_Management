'use strict';

process.env.API_RATE_LIMIT_MAX = '4';
process.env.LOGIN_RATE_LIMIT_MAX = '2';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.TRUST_PROXY_HOPS = '0';

require('dotenv').config();

const http = require('http');
const app = require('../server');

const port = Number(process.env.SECURITY_TEST_PORT || 3996);
const base = `http://127.0.0.1:${port}`;
const results = [];

function check(name, passed, detail) {
    results.push(Boolean(passed));
    console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${!passed && detail ? `: ${detail}` : ''}`);
}

function request(path, { method = 'POST', body, forwardedFor } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (payload) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor;

        const req = http.request(`${base}${path}`, { method, headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

const server = app.listen(port, async () => {
    try {
        const firstLogin = await request('/api/auth/login', { body: {} });
        check(
            'security headers are present on API responses',
            firstLogin.headers['x-content-type-options'] === 'nosniff' &&
                firstLogin.headers['x-frame-options'] === 'DENY' &&
                !!firstLogin.headers['content-security-policy'] &&
                !firstLogin.headers['x-powered-by']
        );

        const secondLogin = await request('/api/auth/login', {
            body: {},
            forwardedFor: '198.51.100.10'
        });
        const limitedLogin = await request('/api/auth/login', {
            body: {},
            forwardedFor: '198.51.100.11'
        });
        check('failed login attempts are rate limited by the trusted client IP',
            secondLogin.statusCode === 400 && limitedLogin.statusCode === 429);

        const allowedApiRequest = await request('/api/health', {
            method: 'GET',
            forwardedFor: '198.51.100.12'
        });
        const limitedApiRequest = await request('/api/health', {
            method: 'GET',
            forwardedFor: '198.51.100.13'
        });
        const authenticatedApiRequest = await request('/api/auth/me', {
            method: 'GET',
            forwardedFor: '198.51.100.12'
        });
        const limitedAuthenticatedApiRequest = await request('/api/auth/me', {
            method: 'GET',
            forwardedFor: '198.51.100.13'
        });
        check(
            'health checks remain available while regular API requests are limited',
            allowedApiRequest.statusCode === 200 &&
                limitedApiRequest.statusCode === 200 &&
                authenticatedApiRequest.statusCode === 401 &&
                limitedAuthenticatedApiRequest.statusCode === 429
        );
    } catch (error) {
        console.error(error);
        results.push(false);
    } finally {
        server.close(() => {
            const passed = results.filter(Boolean).length;
            console.log(`\nSecurity middleware tests: ${passed}/${results.length} passed.`);
            process.exit(passed === results.length ? 0 : 1);
        });
    }
});
