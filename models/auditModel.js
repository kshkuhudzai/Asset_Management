'use strict';

// models/auditModel.js
// Database access for the `audit_logs` table. Every material change in the
// system (login, user management, asset CRUD) is written here so the Auditor
// role can reconstruct who did what, when and from where.

const db = require('../config/db');
const { toJsonSafe } = require('../utils/helpers');

const AUDIT_COLUMNS = [
    'al.id',
    'al.user_id',
    'al.action',
    'al.table_name',
    'al.record_id',
    'al.old_values',
    'al.new_values',
    'al.ip_address',
    'al.created_at'
].join(',\n            ');

/**
 * Writes a single audit-log row.
 *
 * `old_values` / `new_values` are JSON-serialised here so callers can pass
 * plain model objects straight from the database.
 *
 * @param {object} entry
 * @param {number|null} entry.userId
 * @param {string} entry.action e.g. 'LOGIN', 'CREATE', 'UPDATE', 'DELETE'
 * @param {string} entry.tableName e.g. 'users', 'assets'
 * @param {number} entry.recordId Primary key of the affected record.
 * @param {object|null} [entry.oldValues]
 * @param {object|null} [entry.newValues]
 * @param {string|null} [entry.ipAddress]
 * @returns {Promise<number>} The new audit log id.
 */
async function createLog({
    userId = null,
    action,
    tableName,
    recordId,
    oldValues = null,
    newValues = null,
    ipAddress = null
}) {
    const [result] = await db.query(
        `INSERT INTO audit_logs
            (user_id, action, table_name, record_id, old_values, new_values, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            userId,
            action,
            tableName,
            // record_id is INT NOT NULL - use 0 for events with no numeric
            // target (e.g. a failed login for a non-existent account).
            Number.isFinite(Number(recordId)) ? Number(recordId) : 0,
            oldValues ? JSON.stringify(toJsonSafe(oldValues)) : null,
            newValues ? JSON.stringify(toJsonSafe(newValues)) : null,
            ipAddress
        ]
    );

    return result.insertId;
}

/**
 * Reads audit log rows with optional filters, joined to `users` so the Auditor
 * sees a human-readable actor name instead of a bare id.
 *
 * @param {object} [options]
 * @param {number} [options.userId] Only logs produced by this user.
 * @param {string} [options.action] Exact action match, e.g. 'LOGIN'.
 * @param {string} [options.tableName] Exact table match, e.g. 'assets'.
 * @param {number} [options.recordId] Only logs for one specific record.
 * @param {string} [options.dateFrom] Inclusive lower bound (YYYY-MM-DD).
 * @param {string} [options.dateTo] Inclusive upper bound (YYYY-MM-DD).
 * @param {number} [options.limit=100]
 * @param {number} [options.offset=0]
 * @returns {Promise<{logs: object[], total: number}>}
 */
async function findAll({
    userId,
    action,
    tableName,
    recordId,
    dateFrom,
    dateTo,
    limit = 100,
    offset = 0
} = {}) {
    const where = [];
    const params = [];

    if (userId !== undefined && userId !== null) {
        where.push('al.user_id = ?');
        params.push(userId);
    }
    if (action) {
        where.push('al.action = ?');
        params.push(action);
    }
    if (tableName) {
        where.push('al.table_name = ?');
        params.push(tableName);
    }
    if (recordId !== undefined && recordId !== null) {
        where.push('al.record_id = ?');
        params.push(recordId);
    }
    if (dateFrom) {
        where.push('al.created_at >= ?');
        params.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
        where.push('al.created_at <= ?');
        params.push(`${dateTo} 23:59:59`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await db.query(
        `SELECT
            ${AUDIT_COLUMNS},
            u.username AS actor_username,
            u.full_name AS actor_full_name,
            u.role AS actor_role
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         ${whereSql}
         ORDER BY al.created_at DESC, al.id DESC
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)]
    );

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total FROM audit_logs al ${whereSql}`,
        params
    );

    return { logs: rows, total: countRows[0].total };
}

/**
 * Fetches the full history for one specific record, oldest first, so a
 * change-timeline can be rendered.
 *
 * @param {string} tableName
 * @param {number|string} recordId
 * @returns {Promise<object[]>}
 */
async function findForRecord(tableName, recordId) {
    const [rows] = await db.query(
        `SELECT
            ${AUDIT_COLUMNS},
            u.username AS actor_username,
            u.full_name AS actor_full_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         WHERE al.table_name = ? AND al.record_id = ?
         ORDER BY al.created_at ASC, al.id ASC`,
        [tableName, recordId]
    );

    return rows;
}

/**
 * Convenience query for the dashboard: the most recent N audit entries.
 *
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
async function findRecent(limit = 10) {
    const [rows] = await db.query(
        `SELECT
            ${AUDIT_COLUMNS},
            u.username AS actor_username,
            u.full_name AS actor_full_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         ORDER BY al.created_at DESC, al.id DESC
         LIMIT ?`,
        [Number(limit)]
    );

    return rows;
}

module.exports = {
    AUDIT_COLUMNS,
    createLog,
    findAll,
    findForRecord,
    findRecent
};
