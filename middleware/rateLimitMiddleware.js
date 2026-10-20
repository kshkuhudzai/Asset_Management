'use strict';

const rateLimit = require('express-rate-limit').rateLimit;
const { errorResponse } = require('../utils/helpers');

function readLimit(name, fallback) {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;

    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return limit;
}

const windowMs = readLimit('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000);

function createRateLimiter(name, fallback) {
    return rateLimit({
        windowMs,
        limit: readLimit(name, fallback),
        standardHeaders: true,
        legacyHeaders: false,
        handler(req, res) {
            res.status(429).json(errorResponse('Too many requests. Please try again later.'));
        }
    });
}

const apiRateLimit = rateLimit({
    windowMs,
    limit: readLimit('API_RATE_LIMIT_MAX', 600),
    standardHeaders: true,
    legacyHeaders: false,
    skip(req) {
        return req.path === '/health';
    },
    handler(req, res) {
        res.status(429).json(errorResponse('Too many requests. Please try again later.'));
    }
});
const loginRateLimit = rateLimit({
    windowMs,
    limit: readLimit('LOGIN_RATE_LIMIT_MAX', 10),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler(req, res) {
        res.status(429).json(errorResponse('Too many login attempts. Please try again later.'));
    }
});

module.exports = { apiRateLimit, loginRateLimit };
