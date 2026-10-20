'use strict';

// models/userModel.js
// All database access for the `users` table. Controllers must never build SQL
// themselves - every query lives here so column/table names stay in one place.

const db = require('../config/db');
let schemaReady;

async function ensureSchema() {
    if (!schemaReady) {
        schemaReady = (async () => {
            const [columns] = await db.query(
                "SHOW COLUMNS FROM users LIKE 'must_change_password'"
            );
            if (!columns.length) {
                try {
                    await db.query(
                        'ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE AFTER is_active'
                    );
                } catch (error) {
                    if (error.code !== 'ER_DUP_FIELDNAME') throw error;
                }
            }
        })().catch((error) => {
            schemaReady = null;
            throw error;
        });
    }
    return schemaReady;
}

// Column list used for every client-facing SELECT so the API shape never drifts.
const USER_COLUMNS = `
    id,
    username,
    email,
    full_name,
    role,
    is_active,
    must_change_password,
    created_at,
    updated_at
`;

// Same list plus the password hash - only used by authentication flows.
const USER_COLUMNS_WITH_PASSWORD = `${USER_COLUMNS}, password_hash`;

/**
 * Finds a user by their numeric primary key.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>} User without password_hash, or null.
 */
async function findById(id) {
    await ensureSchema();
    const [rows] = await db.query(
        `SELECT ${USER_COLUMNS} FROM users WHERE id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

/**
 * Finds a user by id **including** the password hash (used by changePassword).
 *
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
async function findByIdWithPassword(id) {
    await ensureSchema();
    const [rows] = await db.query(
        `SELECT ${USER_COLUMNS_WITH_PASSWORD} FROM users WHERE id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

/**
 * Finds a user by username (case-insensitive). Used at login.
 *
 * @param {string} username
 * @returns {Promise<object|null>} User including password_hash.
 */
async function findByUsername(username) {
    await ensureSchema();
    const [rows] = await db.query(
        `SELECT ${USER_COLUMNS_WITH_PASSWORD}
         FROM users
         WHERE LOWER(username) = LOWER(?)
         LIMIT 1`,
        [username]
    );
    return rows[0] || null;
}

/**
 * Finds a user by email (case-insensitive). Used for duplicate checks.
 *
 * @param {string} email
 * @returns {Promise<object|null>} User including password_hash.
 */
async function findByEmail(email) {
    await ensureSchema();
    const [rows] = await db.query(
        `SELECT ${USER_COLUMNS_WITH_PASSWORD}
         FROM users
         WHERE LOWER(email) = LOWER(?)
         LIMIT 1`,
        [email]
    );
    return rows[0] || null;
}


/**
 * Lists users with optional search / role / status filters and pagination.
 *
 * @param {object} [options]
 * @param {string} [options.search] Free-text match on username, full_name, email.
 * @param {string} [options.role] Exact role match (must be a valid enum value).
 * @param {boolean} [options.isActive] Filter by active flag.
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @returns {Promise<{users: object[], total: number}>}
 */
async function findAll({ search, role, isActive, limit = 50, offset = 0 } = {}) {
    await ensureSchema();
    const where = [];
    const params = [];

    if (search) {
        where.push('(username LIKE ? OR full_name LIKE ? OR email LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like);
    }
    if (role) {
        where.push('role = ?');
        params.push(role);
    }
    if (typeof isActive === 'boolean') {
        where.push('is_active = ?');
        params.push(isActive ? 1 : 0);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await db.query(
        `SELECT ${USER_COLUMNS}
         FROM users
         ${whereSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)]
    );

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total FROM users ${whereSql}`,
        params
    );

    return { users: rows, total: countRows[0].total };
}

/**
 * Inserts a new user. The caller is responsible for hashing the password.
 *
 * @param {object} data
 * @param {string} data.username
 * @param {string} data.passwordHash
 * @param {string} data.email
 * @param {string} data.fullName
 * @param {string} data.role One of the users.role ENUM values.
 * @param {boolean} [data.isActive=true]
 * @returns {Promise<object>} The freshly created user (no password_hash).
 */
async function create({
    username,
    passwordHash,
    email,
    fullName,
    role,
    isActive = true,
    mustChangePassword = false
}) {
    await ensureSchema();
    const [result] = await db.query(
        `INSERT INTO users
            (username, password_hash, email, full_name, role, is_active, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            username,
            passwordHash,
            email,
            fullName,
            role,
            isActive ? 1 : 0,
            mustChangePassword ? 1 : 0
        ]
    );

    return findById(result.insertId);
}

/**
 * Updates the mutable profile fields of a user. Only keys present in `data`
 * are touched, so callers can send partial updates.
 *
 * @param {number|string} id
 * @param {object} data
 * @param {string} [data.username]
 * @param {string} [data.email]
 * @param {string} [data.fullName]
 * @param {string} [data.role]
 * @param {boolean} [data.isActive]
 * @returns {Promise<object|null>} The updated user, or null if nothing matched.
 */
async function update(id, data) {
    await ensureSchema();
    const sets = [];
    const params = [];

    if (data.username !== undefined) {
        sets.push('username = ?');
        params.push(data.username);
    }
    if (data.email !== undefined) {
        sets.push('email = ?');
        params.push(data.email);
    }
    if (data.fullName !== undefined) {
        sets.push('full_name = ?');
        params.push(data.fullName);
    }
    if (data.role !== undefined) {
        sets.push('role = ?');
        params.push(data.role);
    }
    if (data.isActive !== undefined) {
        sets.push('is_active = ?');
        params.push(data.isActive ? 1 : 0);
    }

    if (!sets.length) return findById(id);

    params.push(id);
    const [result] = await db.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = ?`,
        params
    );

    if (result.affectedRows === 0) return null;
    return findById(id);
}

/**
 * Replaces a user's password hash.
 *
 * @param {number|string} id
 * @param {string} passwordHash
 * @returns {Promise<boolean>} True when a row was updated.
 */
async function updatePassword(id, passwordHash, mustChangePassword = false) {
    await ensureSchema();
    const [result] = await db.query(
        'UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?',
        [passwordHash, mustChangePassword ? 1 : 0, id]
    );
    return result.affectedRows > 0;
}

/**
 * Soft-deletes a user by clearing `is_active`. Rows are never physically
 * removed so historical audit_logs and asset assignments stay intact.
 *
 * @param {number|string} id
 * @returns {Promise<boolean>} True when a row was updated.
 */
async function deactivate(id) {
    await ensureSchema();
    const [result] = await db.query(
        'UPDATE users SET is_active = 0 WHERE id = ?',
        [id]
    );
    return result.affectedRows > 0;
}

/**
 * Re-activates a previously soft-deleted user.
 *
 * @param {number|string} id
 * @returns {Promise<boolean>} True when a row was updated.
 */
async function activate(id) {
    await ensureSchema();
    const [result] = await db.query(
        'UPDATE users SET is_active = 1 WHERE id = ?',
        [id]
    );
    return result.affectedRows > 0;
}

/**
 * Counts active users holding System Administrator rights. Used to prevent
 * locking everyone out of the system.
 *
 * @param {number|string|null} [excludeId] Optional id to exclude from the count.
 * @returns {Promise<number>}
 */
async function countActiveAdmins(excludeId = null) {
    await ensureSchema();
    const params = [];
    let sql = `SELECT COUNT(*) AS total
               FROM users
               WHERE role = 'System Administrator' AND is_active = 1`;

    if (excludeId !== null && excludeId !== undefined) {
        sql += ' AND id <> ?';
        params.push(excludeId);
    }

    const [rows] = await db.query(sql, params);
    return rows[0].total;
}

module.exports = {
    USER_COLUMNS,
    ensureSchema,
    findById,
    findByIdWithPassword,
    findByUsername,
    findByEmail,
    findAll,
    create,
    update,
    updatePassword,
    deactivate,
    activate,
    countActiveAdmins
};
