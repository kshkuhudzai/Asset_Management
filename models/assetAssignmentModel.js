'use strict';

// models/assetAssignmentModel.js
// All database access for asset assignment and custody: the `asset_assignments`
// table. Controllers must never build SQL themselves - every query lives here
// so column/table names stay in one place.
//
// Design notes
//   * Custody history is never overwritten. Each assignment is a row; when an
//     asset changes custodian the current row is closed (`released_at` set)
//     and a brand-new row is opened. This satisfies the business rule
//     "Transfers must not erase previous ownership or location history" and
//     the requirement to "retain previous assignment history when an asset
//     changes custodian".
//   * An asset has at most one OPEN assignment. `released_at IS NULL` marks
//     the row as current; `findActiveByAssetId` relies on that.
//   * Acknowledged receipt (`acknowledged_at` / `acknowledged_by`) is recorded
//     in place because it is a confirmation of the SAME assignment, not a new
//     custody event.
//   * Rows are never physically deleted; `released_at` / `released_by` carry
//     the date and the user who closed the custody.
//
// This module also owns the idempotent DDL for its own table so the module can
// be deployed without re-running the full database initialiser.

const db = require('../config/db');

/**
 * DDL for the `asset_assignments` table.
 *
 * Kept next to the queries so the shape the SQL below expects is documented in
 * one place. `CREATE TABLE IF NOT EXISTS` makes this safe to call repeatedly.
 */
const ASSIGNMENT_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS asset_assignments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        asset_id INT NOT NULL,                        -- FK to assets.id
        assigned_user_id INT,                         -- Custodian (FK to users.id)
        assigned_to_name VARCHAR(100),                -- Printed on the acknowledgement form
        department VARCHAR(100),
        location VARCHAR(100),
        responsible_officer VARCHAR(100),
        assignment_date DATE NOT NULL,
        expected_return_date DATE,
        purpose VARCHAR(255),
        remarks TEXT,
        status ENUM('Active', 'Returned', 'Transferred', 'Cancelled') DEFAULT 'Active',
        acknowledged_at DATETIME,
        acknowledged_by INT,                          -- FK to users.id (who confirmed receipt)
        acknowledged_remarks VARCHAR(255),
        released_at DATETIME,
        released_by INT,                              -- FK to users.id (who closed the row)
        release_reason VARCHAR(255),
        assigned_by INT,                              -- FK to users.id (who created the row)
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (acknowledged_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (released_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_assignment_asset (asset_id),
        INDEX idx_assignment_user (assigned_user_id),
        INDEX idx_assignment_status (status),
        INDEX idx_assignment_date (assignment_date)
    )
`;

// Column list used for every client-facing SELECT so the API shape never
// drifts. Joined columns are prefixed so the joins can select human-readable
// asset / custodian / officer names alongside the raw ids.
const ASSIGNMENT_COLUMNS = `
    aa.id,
    aa.asset_id,
    aa.assigned_user_id,
    aa.assigned_to_name,
    aa.department,
    aa.location,
    aa.responsible_officer,
    aa.assignment_date,
    aa.expected_return_date,
    aa.purpose,
    aa.remarks,
    aa.status,
    aa.acknowledged_at,
    aa.acknowledged_by,
    aa.acknowledged_remarks,
    aa.released_at,
    aa.released_by,
    aa.release_reason,
    aa.assigned_by,
    aa.created_at,
    aa.updated_at
`;

// The assignment table plus its lookup joins, always applied together.
const ASSIGNMENT_FROM = `
    FROM asset_assignments aa
    LEFT JOIN assets a ON a.id = aa.asset_id
    LEFT JOIN users u ON u.id = aa.assigned_user_id
    LEFT JOIN users ab ON ab.id = aa.assigned_by
    LEFT JOIN users rl ON rl.id = aa.released_by
    LEFT JOIN users ak ON ak.id = aa.acknowledged_by
`;

// Joined helper columns appended after ASSIGNMENT_COLUMNS.
const ASSIGNMENT_JOIN_COLUMNS = `
    a.asset_id AS asset_code,
    a.asset_tag AS asset_tag,
    a.serial_number AS serial_number,
    a.status AS asset_status,
    a.condition_status AS asset_condition,
    c.name AS category_name,
    u.username AS assigned_username,
    u.full_name AS assigned_full_name,
    ab.full_name AS assigned_by_name,
    rl.full_name AS released_by_name,
    ak.full_name AS acknowledged_by_name
`;

// The select used by every single-assignment read so the shape is identical
// whether the row came from a list, a create or an update.
const ASSIGNMENT_SELECT = `
    SELECT
        ${ASSIGNMENT_COLUMNS},
        ${ASSIGNMENT_JOIN_COLUMNS}
    ${ASSIGNMENT_FROM}
    LEFT JOIN asset_categories c ON c.id = a.category_id
`;

// Table name as it appears in audit_logs.table_name.
const ASSIGNMENT_TABLE = 'asset_assignments';

/**
 * Creates the `asset_assignments` table when it does not exist yet.
 *
 * Called by the module bootstrap and by the test suite so a fresh checkout can
 * exercise assignment endpoints without re-running `scripts/initDb.js`.
 *
 * @returns {Promise<void>}
 */
async function ensureTable() {
    await db.query(ASSIGNMENT_TABLE_DDL);
}

/* ========================================================================== */
/* Reads                                                                      */
/* ========================================================================== */

/**
 * Finds a single assignment by its numeric primary key, including the joined
 * asset, custodian and officer details.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>} The assignment, or null when not found.
 */
async function findById(id) {
    const [rows] = await db.query(`${ASSIGNMENT_SELECT} WHERE aa.id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

/**
 * Finds the currently-open assignment for an asset (`released_at IS NULL`).
 *
 * @param {number|string} assetId
 * @returns {Promise<object|null>}
 */
async function findActiveByAssetId(assetId) {
    const [rows] = await db.query(
        `${ASSIGNMENT_SELECT}
         WHERE aa.asset_id = ? AND aa.released_at IS NULL
         ORDER BY aa.id DESC
         LIMIT 1`,
        [assetId]
    );
    return rows[0] || null;
}

/**
 * Lists every assignment ever recorded for an asset, newest first. This is the
 * custody history required by the business rules.
 *
 * @param {number|string} assetId
 * @returns {Promise<object[]>}
 */
async function findHistoryByAssetId(assetId) {
    const [rows] = await db.query(
        `${ASSIGNMENT_SELECT}
         WHERE aa.asset_id = ?
         ORDER BY aa.assignment_date DESC, aa.id DESC`,
        [assetId]
    );
    return rows;
}

/**
 * Lists assignments for a custodian.
 *
 * @param {number|string} userId
 * @param {object} [options]
 * @param {boolean} [options.activeOnly=false] Only currently-held assets.
 * @returns {Promise<object[]>}
 */
async function findByUserId(userId, { activeOnly = false } = {}) {
    const where = ['aa.assigned_user_id = ?'];
    const params = [userId];

    if (activeOnly) {
        where.push('aa.released_at IS NULL');
    }

    const [rows] = await db.query(
        `${ASSIGNMENT_SELECT}
         WHERE ${where.join(' AND ')}
         ORDER BY aa.assignment_date DESC, aa.id DESC`,
        params
    );
    return rows;
}

/**
 * Lists assignments with optional search / filter / sort and pagination.
 *
 * Every filter is optional; only the supplied ones are added to the WHERE
 * clause.
 *
 * @param {object} [options]
 * @param {string} [options.search] Free-text match on asset code/tag/serial,
 *        custodian name and responsible officer.
 * @param {number} [options.assetId]
 * @param {number} [options.assignedUserId]
 * @param {string} [options.status] Exact ENUM match.
 * @param {boolean} [options.activeOnly] Only rows with released_at IS NULL.
 * @param {string} [options.department] Partial match.
 * @param {string} [options.location] Partial match.
 * @param {boolean} [options.pendingAcknowledgement] Active but not confirmed.
 * @param {string} [options.dateFrom] Inclusive lower bound (YYYY-MM-DD).
 * @param {string} [options.dateTo] Inclusive upper bound (YYYY-MM-DD).
 * @param {string} [options.sortBy='assignment_date'] Whitelisted column.
 * @param {string} [options.sortDir='desc'] 'asc' or 'desc'.
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @returns {Promise<{assignments: object[], total: number}>}
 */
async function findAll({
    search,
    assetId,
    assignedUserId,
    status,
    activeOnly = false,
    department,
    location,
    pendingAcknowledgement = false,
    dateFrom,
    dateTo,
    sortBy = 'assignment_date',
    sortDir = 'desc',
    limit = 50,
    offset = 0
} = {}) {
    const where = [];
    const params = [];

    if (search) {
        where.push(
            `(a.asset_id LIKE ? OR a.asset_tag LIKE ? OR a.serial_number LIKE ?
              OR aa.assigned_to_name LIKE ? OR aa.responsible_officer LIKE ?
              OR aa.department LIKE ? OR aa.location LIKE ?)`
        );
        const like = `%${search}%`;
        params.push(like, like, like, like, like, like, like);
    }
    if (assetId !== undefined && assetId !== null) {
        where.push('aa.asset_id = ?');
        params.push(assetId);
    }
    if (assignedUserId !== undefined && assignedUserId !== null) {
        where.push('aa.assigned_user_id = ?');
        params.push(assignedUserId);
    }
    if (status) {
        where.push('aa.status = ?');
        params.push(status);
    }
    if (activeOnly) {
        where.push('aa.released_at IS NULL');
    }
    if (department) {
        where.push('aa.department LIKE ?');
        params.push(`%${department}%`);
    }
    if (location) {
        where.push('aa.location LIKE ?');
        params.push(`%${location}%`);
    }
    if (pendingAcknowledgement) {
        where.push('aa.acknowledged_at IS NULL AND aa.released_at IS NULL');
    }
    if (dateFrom) {
        where.push('aa.assignment_date >= ?');
        params.push(dateFrom);
    }
    if (dateTo) {
        where.push('aa.assignment_date <= ?');
        params.push(dateTo);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Whitelist sort columns - never interpolate raw user input into SQL.
    const sortableColumns = {
        assignment_date: 'aa.assignment_date',
        expected_return_date: 'aa.expected_return_date',
        status: 'aa.status',
        department: 'aa.department',
        location: 'aa.location',
        created_at: 'aa.created_at',
        asset_code: 'a.asset_id',
        assigned_to_name: 'aa.assigned_to_name'
    };
    const orderColumn = sortableColumns[sortBy] || sortableColumns.assignment_date;
    const orderDirection = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const [rows] = await db.query(
        `SELECT
            ${ASSIGNMENT_COLUMNS},
            ${ASSIGNMENT_JOIN_COLUMNS}
         ${ASSIGNMENT_FROM}
         LEFT JOIN asset_categories c ON c.id = a.category_id
         ${whereSql}
         ORDER BY ${orderColumn} ${orderDirection}, aa.id ${orderDirection}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)]
    );

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total ${ASSIGNMENT_FROM} ${whereSql}`,
        params
    );

    return { assignments: rows, total: countRows[0].total };
}

/* ========================================================================== */
/* Writes                                                                     */
/* ========================================================================== */

/**
 * Maps a controller-supplied payload object onto the writable assignment
 * columns. Only keys present in the payload are included, so the same builder
 * serves both INSERT and UPDATE.
 *
 * Column names are hard-coded here (never derived from user input) which keeps
 * the statements injection-proof.
 *
 * @param {object} data camelCase payload from the controller.
 * @param {boolean} forInsert When true, always emit every insertable column so
 *        the statement has a fixed arity.
 * @returns {{columns: string[], values: Array, assignments: string[]}}
 */
function buildColumnMapping(data, forInsert) {
    // [payloadKey, columnName]
    const mapping = [
        ['assetId', 'asset_id'],
        ['assignedUserId', 'assigned_user_id'],
        ['assignedToName', 'assigned_to_name'],
        ['department', 'department'],
        ['location', 'location'],
        ['responsibleOfficer', 'responsible_officer'],
        ['assignmentDate', 'assignment_date'],
        ['expectedReturnDate', 'expected_return_date'],
        ['purpose', 'purpose'],
        ['remarks', 'remarks'],
        ['status', 'status'],
        ['acknowledgedAt', 'acknowledged_at'],
        ['acknowledgedBy', 'acknowledged_by'],
        ['acknowledgedRemarks', 'acknowledged_remarks'],
        ['releasedAt', 'released_at'],
        ['releasedBy', 'released_by'],
        ['releaseReason', 'release_reason'],
        ['assignedBy', 'assigned_by']
    ];

    const columns = [];
    const values = [];
    const assignments = [];

    for (const [key, column] of mapping) {
        const provided = Object.prototype.hasOwnProperty.call(data, key);

        if (forInsert) {
            columns.push(column);
            values.push(provided ? data[key] : null);
        } else if (provided) {
            assignments.push(`${column} = ?`);
            values.push(data[key]);
        }
    }

    return { columns, values, assignments };
}

/**
 * Inserts a new assignment row.
 *
 * @param {object} data camelCase payload (see buildColumnMapping).
 * @returns {Promise<object>} The freshly-created assignment with joins applied.
 */
async function create(data) {
    const { columns, values } = buildColumnMapping(data, true);

    const [result] = await db.query(
        `INSERT INTO asset_assignments (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        values
    );

    return findById(result.insertId);
}

/**
 * Updates an assignment with a partial payload. Columns absent from `data`
 * keep their current values.
 *
 * @param {number|string} id
 * @param {object} data camelCase payload.
 * @returns {Promise<object|null>} The updated assignment, or null if unmatched.
 */
async function update(id, data) {
    const { assignments, values } = buildColumnMapping(data, false);

    if (!assignments.length) return findById(id);

    values.push(id);
    const [result] = await db.query(
        `UPDATE asset_assignments SET ${assignments.join(', ')} WHERE id = ?`,
        values
    );

    if (result.affectedRows === 0) return null;
    return findById(id);
}

/**
 * Closes an open assignment: stamps `released_at`, `released_by`,
 * `release_reason` and flips the status. The row is retained permanently so
 * custody history survives.
 *
 * The `released_at IS NULL` guard makes this idempotent-safe: a second call on
 * an already-closed row matches nothing and returns null.
 *
 * @param {number|string} id
 * @param {object} data
 * @param {string} data.releasedAt MySQL DATETIME string.
 * @param {number|null} [data.releasedBy]
 * @param {string|null} [data.releaseReason]
 * @param {string} [data.status='Returned']
 * @returns {Promise<object|null>} The closed assignment, or null if unmatched.
 */
async function release(id, { releasedAt, releasedBy = null, releaseReason = null, status = 'Returned' }) {
    const [result] = await db.query(
        `UPDATE asset_assignments
         SET released_at = ?, released_by = ?, release_reason = ?, status = ?
         WHERE id = ? AND released_at IS NULL`,
        [releasedAt, releasedBy, releaseReason, status, id]
    );

    if (result.affectedRows === 0) return null;
    return findById(id);
}

/**
 * Records the custodian's acknowledgement of receipt for an assignment.
 *
 * @param {number|string} id
 * @param {object} data
 * @param {string} data.acknowledgedAt MySQL DATETIME string.
 * @param {number|null} [data.acknowledgedBy]
 * @param {string|null} [data.acknowledgedRemarks]
 * @returns {Promise<object|null>} The updated assignment, or null if unmatched.
 */
async function acknowledge(id, { acknowledgedAt, acknowledgedBy = null, acknowledgedRemarks = null }) {
    const [result] = await db.query(
        `UPDATE asset_assignments
         SET acknowledged_at = ?, acknowledged_by = ?, acknowledged_remarks = ?
         WHERE id = ?`,
        [acknowledgedAt, acknowledgedBy, acknowledgedRemarks, id]
    );

    if (result.affectedRows === 0) return null;
    return findById(id);
}

/* ========================================================================== */
/* Counters and summaries                                                     */
/* ========================================================================== */

/**
 * Counts the open assignments held by one custodian. Used by the controller to
 * report custodian load and to guard custody changes.
 *
 * @param {number|string} userId
 * @returns {Promise<number>}
 */
async function countActiveForUser(userId) {
    const [rows] = await db.query(
        `SELECT COUNT(*) AS total
         FROM asset_assignments
         WHERE assigned_user_id = ? AND released_at IS NULL`,
        [userId]
    );
    return rows[0].total;
}

/**
 * Counts how many assignments reference an asset (open or historical).
 *
 * @param {number|string} assetId
 * @returns {Promise<number>}
 */
async function countByAssetId(assetId) {
    const [rows] = await db.query(
        'SELECT COUNT(*) AS total FROM asset_assignments WHERE asset_id = ?',
        [assetId]
    );
    return rows[0].total;
}

/**
 * Aggregate counts used by the assignment summary tiles.
 *
 * @param {object} [options]
 * @param {number} [options.assignedUserId] Restrict to one custodian.
 * @returns {Promise<{total: number, active: number, returned: number,
 *                    pending_acknowledgement: number, overdue: number,
 *                    byStatus: object[], byDepartment: object[],
 *                    byLocation: object[]}>}
 */
async function getStats({ assignedUserId = null } = {}) {
    const where = [];
    const params = [];

    if (assignedUserId !== null && assignedUserId !== undefined) {
        where.push('assigned_user_id = ?');
        params.push(assignedUserId);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const andSql = where.length ? `AND ${where.join(' AND ')}` : '';

    const [totalRows] = await db.query(
        `SELECT COUNT(*) AS total FROM asset_assignments ${whereSql}`,
        params
    );

    const [statusRows] = await db.query(
        `SELECT status, COUNT(*) AS total
         FROM asset_assignments
         ${whereSql}
         GROUP BY status
         ORDER BY status ASC`,
        params
    );

    const [openRows] = await db.query(
        `SELECT
            SUM(CASE WHEN released_at IS NULL THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN released_at IS NOT NULL THEN 1 ELSE 0 END) AS returned,
            SUM(CASE WHEN released_at IS NULL AND acknowledged_at IS NULL THEN 1 ELSE 0 END)
                AS pending_acknowledgement,
            SUM(CASE WHEN released_at IS NULL
                      AND expected_return_date IS NOT NULL
                      AND expected_return_date < CURDATE() THEN 1 ELSE 0 END) AS overdue
         FROM asset_assignments
         ${whereSql}`,
        params
    );

    const [byDepartment] = await db.query(
        `SELECT
            COALESCE(NULLIF(department, ''), 'Unspecified') AS department,
            COUNT(*) AS total
         FROM asset_assignments
         ${whereSql}
         GROUP BY department
         ORDER BY total DESC`,
        params
    );

    const [byLocation] = await db.query(
        `SELECT
            COALESCE(NULLIF(location, ''), 'Unspecified') AS location,
            COUNT(*) AS total
         FROM asset_assignments
         WHERE 1 = 1 ${andSql}
         GROUP BY location
         ORDER BY total DESC`,
        params
    );

    const open = openRows[0] || {};

    return {
        total: totalRows[0].total,
        active: Number(open.active || 0),
        returned: Number(open.returned || 0),
        pending_acknowledgement: Number(open.pending_acknowledgement || 0),
        overdue: Number(open.overdue || 0),
        byStatus: statusRows,
        byDepartment,
        byLocation
    };
}

module.exports = {
    ASSIGNMENT_TABLE,
    ASSIGNMENT_TABLE_DDL,
    ASSIGNMENT_COLUMNS,
    ASSIGNMENT_JOIN_COLUMNS,
    ASSIGNMENT_SELECT,

    // Bootstrap
    ensureTable,

    // Reads
    findById,
    findActiveByAssetId,
    findHistoryByAssetId,
    findByUserId,
    findAll,

    // Writes
    create,
    update,
    release,
    acknowledge,

    // Counters / summaries
    countActiveForUser,
    countByAssetId,
    getStats
};
