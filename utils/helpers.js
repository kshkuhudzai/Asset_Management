'use strict';

// utils/helpers.js
// Shared utility helpers used across controllers, middleware and models.

/**
 * Formats a Date (or date-like value) into the `YYYY-MM-DD HH:mm:ss` shape
 * MySQL expects for DATETIME / TIMESTAMP columns.
 *
 * @param {Date|string|number} [date=new Date()] The date to format.
 * @returns {string|null} Formatted timestamp string, or null if invalid.
 */
function formatDateTime(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;

    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
}

/**
 * Reads Express's proxy-aware client address without trusting forwarded headers
 * unless the application has explicitly configured trusted proxy hops.
 * The `audit_logs.ip_address` column is VARCHAR(45) so IPv6 fits.
 *
 * @param {import('express').Request} req
 * @returns {string|null} The client IP, or null when it cannot be determined.
 */
function getClientIp(req) {
    if (!req) return null;

    const ip =
        req.ip ||
        (req.socket && req.socket.remoteAddress) ||
        (req.connection && req.connection.remoteAddress) ||
        null;

    return ip ? String(ip).replace('::ffff:', '').substring(0, 45) : null;
}

/**
 * Converts a MySQL result-row value into a plain JSON-safe value so audit log
 * snapshots stay readable (Date objects and Buffers do not survive stringify
 * cleanly in a JSON column).
 *
 * @param {*} value
 * @returns {*} A JSON-serialisable value.
 */
function toJsonSafe(value) {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) return formatDateTime(value);
    if (Buffer.isBuffer(value)) return value.toString('utf8');
    if (Array.isArray(value)) return value.map(toJsonSafe);
    if (typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) out[key] = toJsonSafe(value[key]);
        return out;
    }
    return value;
}

/**
 * Strips sensitive fields (password hashes, tokens) from a user object before
 * it is returned to the client or written to the audit log. Accepts a single
 * object or an array of objects.
 *
 * @param {object|object[]|null} user
 * @returns {object|object[]|null}
 */
function sanitizeUser(user) {
    if (!user) return user;
    if (Array.isArray(user)) return user.map(sanitizeUser);

    const clean = { ...user };
    delete clean.password_hash;
    delete clean.password;
    delete clean.reset_token;
    delete clean.reset_token_expires;
    if (clean.must_change_password !== undefined) {
        clean.must_change_password = Boolean(clean.must_change_password);
    }
    return clean;
}

/**
 * Trims a value and returns it as a string; non-strings are converted.
 * Useful for normalising `req.body` input before validation.
 *
 * @param {*} value
 * @returns {string} The trimmed string (empty string when value is nullish).
 */
function normalizeString(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

/**
 * Validates an email address using a conservative RFC-ish pattern.
 *
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
    if (typeof email !== 'string') return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * Builds a consistent API success envelope.
 *
 * @param {string} message
 * @param {*} [data]
 * @returns {{status: string, message: string, data?: *}}
 */
function successResponse(message, data) {
    const payload = { status: 'success', message };
    if (data !== undefined) payload.data = data;
    return payload;
}

/**
 * Builds a consistent API error envelope.
 *
 * @param {string} message
 * @param {Array<{field: string, message: string}>} [errors]
 * @returns {{status: string, message: string, errors?: object[]}}
 */
function errorResponse(message, errors) {
    const payload = { status: 'error', message };
    if (errors && errors.length) payload.errors = errors;
    return payload;
}

/**
 * Wraps an async Express route handler so rejected promises are forwarded to
 * the global error handler. Express 5 does this natively but wrapping keeps
 * behaviour identical if a handler is ever mounted on an Express 4 app.
 *
 * @param {Function} fn Async (req, res, next) => Promise
 * @returns {Function} Express-compatible middleware.
 */
function asyncHandler(fn) {
    return function wrapped(req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = {
    formatDateTime,
    getClientIp,
    toJsonSafe,
    sanitizeUser,
    normalizeString,
    isValidEmail,
    successResponse,
    errorResponse,
    asyncHandler
};
