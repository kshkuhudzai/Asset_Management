'use strict';

// middleware/auditMiddleware.js
// Audit logging helpers.
//
// Two ways to record activity:
//   1. `auditAction(...)` - factory used directly inside a controller when the
//      old/new values are only known there (e.g. an asset update).
//   2. `auditLog({...})`  - fire-and-forget helper for one-off events such as
//      LOGIN / LOGOUT / FAILED_LOGIN.
//
// Audit writes must never break the business operation, so every failure is
// logged to the console and swallowed.

const auditModel = require('../models/auditModel');
const { getClientIp } = require('../utils/helpers');

/**
 * Persists an audit entry, never throwing.
 *
 * @param {object} entry See auditModel.createLog for the shape.
 * @returns {Promise<number|null>} The inserted id, or null on failure.
 */
async function auditLog(entry) {
    try {
        return await auditModel.createLog(entry);
    } catch (err) {
        console.error('⚠️  Failed to write audit log:', err.message);
        return null;
    }
}

/**
 * Builds a middleware/controller helper that records an action once it has
 * happened. The caller supplies the values, so it can be used at any point in
 * a request handler.
 *
 * @param {object} options
 * @param {string} options.action e.g. 'CREATE', 'UPDATE', 'DELETE'
 * @param {string} [options.tableName] Defaults to the resource name.
 * @param {string} [options.resource] Route segment used to derive tableName.
 * @returns {(req: object, payload: object) => Promise<number|null>}
 */
function auditAction({ action, tableName, resource }) {
    return function record(req, payload = {}) {
        const resolvedTable =
            tableName ||
            resource ||
            (req.baseUrl ? req.baseUrl.replace(/^\/api\//, '').replace(/\/$/, '') : 'unknown');

        return auditLog({
            userId: req.user ? req.user.id : payload.userId ?? null,
            action,
            tableName: resolvedTable,
            recordId: payload.recordId ?? 0,
            oldValues: payload.oldValues ?? null,
            newValues: payload.newValues ?? null,
            ipAddress: getClientIp(req)
        });
    };
}

/**
 * Express middleware that records every mutating request as it completes.
 * Handy as a blanket safety net for routers whose handlers do not explicitly
 * log (asset, stock, transfer, warranty modules).
 *
 * Only POST / PUT / PATCH / DELETE are logged; GET requests are ignored.
 *
 * @param {object} [options]
 * @param {string} [options.tableName] Override the derived table name.
 * @returns {import('express').RequestHandler}
 */
function auditMiddleware(options = {}) {
    return function audit(req, res, next) {
        const method = req.method.toUpperCase();
        const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'];

        if (!mutating.includes(method)) return next();

        const actionByMethod = {
            POST: 'CREATE',
            PUT: 'UPDATE',
            PATCH: 'UPDATE',
            DELETE: 'DELETE'
        };

        // Capture the body before the handler runs (handlers may mutate it).
        const requestBody = req.body ? { ...req.body } : null;

        res.on('finish', () => {
            // Only log successful operations; failures are recorded explicitly
            // by the controller with a domain-specific action name.
            if (res.statusCode >= 400) return;

            const derivedTable =
                options.tableName ||
                req.baseUrl.replace(/^\/api\//, '').replace(/\/$/, '') ||
                'unknown';

            auditLog({
                userId: req.user ? req.user.id : null,
                action: actionByMethod[method],
                tableName: derivedTable,
                recordId: req.params ? req.params.id : 0,
                oldValues: null,
                newValues: requestBody,
                ipAddress: getClientIp(req)
            });
        });

        return next();
    };
}

module.exports = {
    auditLog,
    auditAction,
    auditMiddleware
};
