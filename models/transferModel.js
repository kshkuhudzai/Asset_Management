'use strict';

// models/transferModel.js
// All database access for asset movement: the `transfers` table.
// Controllers must never build SQL themselves - every query lives here so
// column/table names stay in one place.
//
// Design notes
//   * A transfer is an immutable historical event, not a mutable state. Each
//     row snapshots BOTH sides of the movement (`from_*` and `to_*`) so the
//     record stays accurate even if a custodian later leaves or a location is
//     renamed. This satisfies the business rule "Transfers must not erase
//     previous ownership or location history" and acceptance criterion 4,
//     "Assets can be assigned and transferred without loss of history".
//   * Rows are never physically deleted. A mistaken transfer is corrected by
//     cancelling or reversing the row's status, so the movement trail the
//     Auditor relies on stays intact.
//   * `transfer_ref` is a human-quotable reference (TRF-000001) printed on the
//     transfer form and used to look a movement up from paper records.
//   * The `asset_assignments` table records WHO currently holds an asset; this
//     table records HOW it got there. The controller writes to both so the two
//     views never disagree.
//
// This module also owns the idempotent DDL for its own table so the module can
// be deployed without re-running the full database initialiser.

/**
 * DDL for the `transfers` table.
 *
 * Kept next to the queries so the shape the SQL below expects is documented in
 * one place. `CREATE TABLE IF NOT EXISTS` makes this safe to call repeatedly.
 *
 * The `from_*` / `to_*` pairs are deliberately denormalised snapshots: they
 * remain the permanent record of the movement even after the referenced user,
 * department or location changes. The user foreign keys are therefore ON DELETE
 * SET NULL rather than CASCADE - losing a user account must never delete
 * movement history.
 */
const TRANSFER_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS transfers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        transfer_ref VARCHAR(50) UNIQUE,               -- TRF-000001, printed on the form
        asset_id INT NOT NULL,                         -- FK to assets.id
        assignment_id INT,                             -- FK to asset_assignments.id opened by this transfer

        -- Where the asset came from (snapshot).
        from_user_id INT,                              -- FK to users.id
        from_custodian_name VARCHAR(100),
        from_department VARCHAR(100),
        from_location VARCHAR(100),
        from_condition ENUM('Good', 'Fair', 'Damaged', 'Obsolete'),

        -- Where the asset went (snapshot).
        to_user_id INT,                                -- FK to users.id
        to_custodian_name VARCHAR(100),
        to_department VARCHAR(100),
        to_location VARCHAR(100),
        to_condition ENUM('Good', 'Fair', 'Damaged', 'Obsolete'),

        transfer_type ENUM('User', 'Department', 'Location', 'Stock', 'Other') DEFAULT 'User',
        transfer_date DATE NOT NULL,
        reason VARCHAR(255),
        remarks TEXT,

        -- Who authorised / initiated the movement.
        initiated_by INT,                              -- FK to users.id (officer recording it)
        approved_by INT,                               -- FK to users.id (authorising officer)
        responsible_officer VARCHAR(100),

        status ENUM('Completed', 'Pending', 'Cancelled', 'Reversed') DEFAULT 'Completed',
        receiving_party_name VARCHAR(100),             -- Signature block: who took delivery
        receiving_party_acknowledged_at DATETIME,
        receiving_party_acknowledged_by INT,           -- FK to users.id

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (assignment_id) REFERENCES asset_assignments(id) ON DELETE SET NULL,
        FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (initiated_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (receiving_party_acknowledged_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_transfer_asset (asset_id),
        INDEX idx_transfer_from_user (from_user_id),
        INDEX idx_transfer_to_user (to_user_id),
        INDEX idx_transfer_date (transfer_date),
        INDEX idx_transfer_status (status)
    )
`;


const db = require('../config/db');


// Column list used for every client-facing SELECT so the API shape never
// drifts. Joined columns are prefixed so the joins can select human-readable
// asset / custodian / officer names alongside the raw ids.
const TRANSFER_COLUMNS = `
    t.id,
    t.transfer_ref,
    t.asset_id,
    t.assignment_id,
    t.from_user_id,
    t.from_custodian_name,
    t.from_department,
    t.from_location,
    t.from_condition,
    t.to_user_id,
    t.to_custodian_name,
    t.to_department,
    t.to_location,
    t.to_condition,
    t.transfer_type,
    t.transfer_date,
    t.reason,
    t.remarks,
    t.initiated_by,
    t.approved_by,
    t.responsible_officer,
    t.status,
    t.receiving_party_name,
    t.receiving_party_acknowledged_at,
    t.receiving_party_acknowledged_by,
    t.created_at,
    t.updated_at
`;

// The transfer table plus its lookup joins, always applied together.
const TRANSFER_FROM = `
    FROM transfers t
    LEFT JOIN assets a ON a.id = t.asset_id
    LEFT JOIN users fu ON fu.id = t.from_user_id
    LEFT JOIN users tu ON tu.id = t.to_user_id
    LEFT JOIN users ib ON ib.id = t.initiated_by
    LEFT JOIN users ap ON ap.id = t.approved_by
    LEFT JOIN users rp ON rp.id = t.receiving_party_acknowledged_by
`;

// Joined helper columns appended after TRANSFER_COLUMNS.
const TRANSFER_JOIN_COLUMNS = `
    a.asset_id AS asset_code,
    a.asset_tag AS asset_tag,
    a.serial_number AS serial_number,
    a.status AS asset_status,
    a.condition_status AS asset_condition,
    c.name AS category_name,
    fu.full_name AS from_user_name,
    tu.full_name AS to_user_name,
    tu.username AS to_username,
    ib.full_name AS initiated_by_name,
    ap.full_name AS approved_by_name,
    rp.full_name AS receiving_party_acknowledged_by_name
`;

// The select used by every single-transfer read so the shape is identical
// whether the row came from a list, a create or an update.
const TRANSFER_SELECT = `
    SELECT
        ${TRANSFER_COLUMNS},
        ${TRANSFER_JOIN_COLUMNS}
    ${TRANSFER_FROM}
    LEFT JOIN asset_categories c ON c.id = a.category_id
`;

// Table name as it appears in audit_logs.table_name.
const TRANSFER_TABLE = 'transfers';

/**
 * Creates the `transfers` table when it does not exist yet.
 *
 * Called by the module bootstrap and by the test suite so a fresh checkout can
 * exercise transfer endpoints without re-running `scripts/initDb.js`.
 *
 * @returns {Promise<void>}
 */
async function ensureTable() {
    await db.query(TRANSFER_TABLE_DDL);
}

/* ========================================================================== */
/* Reads                                                                      */
/* ========================================================================== */

/**
 * Finds a single transfer by its numeric primary key, including the joined
 * asset, custodian and officer details.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>} The transfer, or null when not found.
 */
async function findById(id) {
    const [rows] = await db.query(`${TRANSFER_SELECT} WHERE t.id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

/**
 * Finds a transfer by its human-quotable reference (TRF-000001).
 *
 * @param {string} transferRef
 * @returns {Promise<object|null>}
 */
async function findByRef(transferRef) {
    const [rows] = await db.query(`${TRANSFER_SELECT} WHERE t.transfer_ref = ? LIMIT 1`, [
        transferRef
    ]);
    return rows[0] || null;
}


/**
 * Lists every transfer ever recorded for an asset, newest first. This is the
 * permanent movement history required by the business rules.
 *
 * @param {number|string} assetId
 * @returns {Promise<object[]>}
 */
async function findHistoryByAssetId(assetId, userId = null) {
    const userScope = userId === null ? '' : ' AND (t.from_user_id = ? OR t.to_user_id = ?)';
    const params = userId === null ? [assetId] : [assetId, userId, userId];
    const [rows] = await db.query(
        `${TRANSFER_SELECT}
         WHERE t.asset_id = ?${userScope}
         ORDER BY t.transfer_date DESC, t.id DESC`,
        params
    );
    return rows;
}

/**
 * Lists transfers received by, or sent from, a custodian.
 *
 * `direction` selects which side of the movement to match: 'in' (assets the
 * custodian received), 'out' (assets they handed over) or 'both'.
 *
 * @param {number|string} userId
 * @param {object} [options]
 * @param {'in'|'out'|'both'} [options.direction='both']
 * @returns {Promise<object[]>}
 */
async function findByUserId(userId, { direction = 'both' } = {}) {
    let where = '(t.to_user_id = ? OR t.from_user_id = ?)';
    const params = [userId, userId];

    if (direction === 'in') {
        where = 't.to_user_id = ?';
        params.length = 0;
        params.push(userId);
    } else if (direction === 'out') {
        where = 't.from_user_id = ?';
        params.length = 0;
        params.push(userId);
    }

    const [rows] = await db.query(
        `${TRANSFER_SELECT}
         WHERE ${where}
         ORDER BY t.transfer_date DESC, t.id DESC`,
        params
    );
    return rows;
}

/**
 * Lists transfers with optional search / filter / sort and pagination.
 *
 * Every filter is optional; only the supplied ones are added to the WHERE
 * clause.
 *
 * @param {object} [options]
 * @param {string} [options.search] Free-text match on reference, asset
 *        code/tag/serial and custodian names.
 * @param {number} [options.assetId]
 * @param {number} [options.fromUserId]
 * @param {number} [options.toUserId]
 * @param {string} [options.transferType] Exact ENUM match.
 * @param {string} [options.status] Exact ENUM match.
 * @param {string} [options.department] Partial match on either side.
 * @param {string} [options.location] Partial match on either side.
 * @param {string} [options.dateFrom] Inclusive lower bound (YYYY-MM-DD).
 * @param {string} [options.dateTo] Inclusive upper bound (YYYY-MM-DD).
 * @param {string} [options.sortBy='transfer_date'] Whitelisted column.
 * @param {string} [options.sortDir='desc'] 'asc' or 'desc'.
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @returns {Promise<{transfers: object[], total: number}>}
 */
async function findAll({
    search,
    assetId,
    userId,
    fromUserId,
    toUserId,
    transferType,
    status,
    department,
    location,
    dateFrom,
    dateTo,
    sortBy = 'transfer_date',
    sortDir = 'desc',
    limit = 50,
    offset = 0
} = {}) {
    const where = [];
    const params = [];

    if (search) {
        where.push(
            `(t.transfer_ref LIKE ? OR a.asset_id LIKE ? OR a.asset_tag LIKE ?
              OR a.serial_number LIKE ? OR t.from_custodian_name LIKE ?
              OR t.to_custodian_name LIKE ? OR t.receiving_party_name LIKE ?)`
        );
        const like = `%${search}%`;
        params.push(like, like, like, like, like, like, like);
    }
    if (assetId !== undefined && assetId !== null) {
        where.push('t.asset_id = ?');
        params.push(assetId);
    }
    if (userId !== undefined && userId !== null) {
        where.push('(t.from_user_id = ? OR t.to_user_id = ?)');
        params.push(userId, userId);
    }
    if (fromUserId !== undefined && fromUserId !== null) {
        where.push('t.from_user_id = ?');
        params.push(fromUserId);
    }
    if (toUserId !== undefined && toUserId !== null) {
        where.push('t.to_user_id = ?');
        params.push(toUserId);
    }
    if (transferType) {
        where.push('t.transfer_type = ?');
        params.push(transferType);
    }
    if (status) {
        where.push('t.status = ?');
        params.push(status);
    }
    if (department) {
        where.push('(t.from_department LIKE ? OR t.to_department LIKE ?)');
        params.push(`%${department}%`, `%${department}%`);
    }
    if (location) {
        where.push('(t.from_location LIKE ? OR t.to_location LIKE ?)');
        params.push(`%${location}%`, `%${location}%`);
    }
    if (dateFrom) {
        where.push('t.transfer_date >= ?');
        params.push(dateFrom);
    }
    if (dateTo) {
        where.push('t.transfer_date <= ?');
        params.push(dateTo);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Whitelist sort columns - never interpolate raw user input into SQL.
    const sortableColumns = {
        transfer_date: 't.transfer_date',
        created_at: 't.created_at',
        transfer_ref: 't.transfer_ref',
        status: 't.status',
        transfer_type: 't.transfer_type',
        from_department: 't.from_department',
        to_department: 't.to_department',
        from_location: 't.from_location',
        to_location: 't.to_location',
        asset_code: 'a.asset_id',
        to_custodian_name: 't.to_custodian_name'
    };
    const orderColumn = sortableColumns[sortBy] || sortableColumns.transfer_date;
    const orderDirection = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const [rows] = await db.query(
        `SELECT
            ${TRANSFER_COLUMNS},
            ${TRANSFER_JOIN_COLUMNS}
         ${TRANSFER_FROM}
         LEFT JOIN asset_categories c ON c.id = a.category_id
         ${whereSql}
         ORDER BY ${orderColumn} ${orderDirection}, t.id ${orderDirection}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)]
    );

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total ${TRANSFER_FROM} ${whereSql}`,
        params
    );

    return { transfers: rows, total: countRows[0].total };
}


/* ========================================================================== */
/* Writes                                                                     */
/* ========================================================================== */

/**
 * Maps a controller-supplied payload object onto the writable transfer
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
        ['transferRef', 'transfer_ref'],
        ['assetId', 'asset_id'],
        ['assignmentId', 'assignment_id'],
        ['fromUserId', 'from_user_id'],
        ['fromCustodianName', 'from_custodian_name'],
        ['fromDepartment', 'from_department'],
        ['fromLocation', 'from_location'],
        ['fromCondition', 'from_condition'],
        ['toUserId', 'to_user_id'],
        ['toCustodianName', 'to_custodian_name'],
        ['toDepartment', 'to_department'],
        ['toLocation', 'to_location'],
        ['toCondition', 'to_condition'],
        ['transferType', 'transfer_type'],
        ['transferDate', 'transfer_date'],
        ['reason', 'reason'],
        ['remarks', 'remarks'],
        ['initiatedBy', 'initiated_by'],
        ['approvedBy', 'approved_by'],
        ['responsibleOfficer', 'responsible_officer'],
        ['status', 'status'],
        ['receivingPartyName', 'receiving_party_name'],
        ['receivingPartyAcknowledgedAt', 'receiving_party_acknowledged_at'],
        ['receivingPartyAcknowledgedBy', 'receiving_party_acknowledged_by']
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
 * Inserts a new transfer row.
 *
 * @param {object} data camelCase payload (see buildColumnMapping).
 * @returns {Promise<object>} The freshly-created transfer with joins applied.
 */
async function create(data) {
    const { columns, values } = buildColumnMapping(data, true);

    const [result] = await db.query(
        `INSERT INTO transfers (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        values
    );

    return findById(result.insertId);
}

/**
 * Updates a transfer with a partial payload. Columns absent from `data` keep
 * their current values.
 *
 * @param {number|string} id
 * @param {object} data camelCase payload.
 * @returns {Promise<object|null>} The updated transfer, or null if unmatched.
 */
async function update(id, data) {
    const { assignments, values } = buildColumnMapping(data, false);

    if (!assignments.length) return findById(id);

    values.push(id);
    const [result] = await db.query(
        `UPDATE transfers SET ${assignments.join(', ')} WHERE id = ?`,
        values
    );

    if (result.affectedRows === 0) return null;
    return findById(id);
}

/**
 * Records the receiving party's confirmation of delivery (the signature block
 * on the printed transfer form).
 *
 * @param {number|string} id
 * @param {object} data
 * @param {string} data.acknowledgedAt MySQL DATETIME string.
 * @param {number|null} [data.acknowledgedBy]
 * @param {string|null} [data.receivingPartyName]
 * @returns {Promise<object|null>} The updated transfer, or null if unmatched.
 */
async function acknowledgeReceipt(
    id,
    { acknowledgedAt, acknowledgedBy = null, receivingPartyName = null }
) {
    const [result] = await db.query(
        `UPDATE transfers
         SET receiving_party_acknowledged_at = ?,
             receiving_party_acknowledged_by = ?,
             receiving_party_name = COALESCE(?, receiving_party_name)
         WHERE id = ?`,
        [acknowledgedAt, acknowledgedBy, receivingPartyName, id]
    );

    if (result.affectedRows === 0) return null;
    return findById(id);
}

/**
 * Flips a transfer's status without touching any other column. Used to cancel
 * or reverse a movement. The row itself is retained permanently so the
 * movement trail stays intact.
 *
 * @param {number|string} id
 * @param {string} status One of the `transfers.status` ENUM values.
 * @returns {Promise<object|null>}
 */
async function setStatus(id, status) {
    const [result] = await db.query('UPDATE transfers SET status = ? WHERE id = ?', [status, id]);

    if (result.affectedRows === 0) return null;
    return findById(id);
}

async function approvePending(id, approvedBy) {
    const connection = await db.getConnection();
    let committed = false;

    try {
        await connection.beginTransaction();

        const [transferRows] = await connection.query(
            `SELECT id, transfer_ref, asset_id, from_user_id, from_department,
                    from_location, to_user_id, to_custodian_name, to_department,
                    to_location, to_condition, transfer_type, transfer_date,
                    reason, remarks, responsible_officer, initiated_by, status
             FROM transfers
             WHERE id = ?
             FOR UPDATE`,
            [id]
        );
        const transfer = transferRows[0];

        if (
            !transfer ||
            transfer.status !== 'Pending' ||
            transfer.initiated_by !== null &&
                Number(transfer.initiated_by) === Number(approvedBy)
        ) {
            await connection.rollback();
            return null;
        }

        const [assetRows] = await connection.query(
            `SELECT id, assigned_user_id, department, location, condition_status
             FROM assets
             WHERE id = ?
             FOR UPDATE`,
            [transfer.asset_id]
        );
        const asset = assetRows[0];
        if (!asset) {
            await connection.rollback();
            return null;
        }

        const [assignmentRows] = await connection.query(
            `SELECT id, assigned_user_id, assigned_to_name, department, location,
                    responsible_officer, purpose, remarks
             FROM asset_assignments
             WHERE asset_id = ? AND released_at IS NULL
             ORDER BY id DESC
             LIMIT 1
             FOR UPDATE`,
            [transfer.asset_id]
        );
        const currentAssignment = assignmentRows[0] || null;
        const liveUserId = currentAssignment
            ? currentAssignment.assigned_user_id
            : asset.assigned_user_id;
        const liveDepartment =
            (currentAssignment && currentAssignment.department) || asset.department || null;
        const liveLocation =
            (currentAssignment && currentAssignment.location) || asset.location || null;

        if (
            (liveUserId !== null && liveUserId !== undefined ? Number(liveUserId) : null) !==
                (transfer.from_user_id !== null && transfer.from_user_id !== undefined
                    ? Number(transfer.from_user_id)
                    : null) ||
            liveDepartment !== (transfer.from_department || null) ||
            liveLocation !== (transfer.from_location || null)
        ) {
            await connection.rollback();
            return null;
        }

        let assignmentId = currentAssignment ? currentAssignment.id : null;
        if (currentAssignment && transfer.to_user_id) {
            const [released] = await connection.query(
                `UPDATE asset_assignments
                 SET released_at = CURRENT_TIMESTAMP,
                     released_by = ?,
                     release_reason = ?,
                     status = 'Transferred'
                 WHERE id = ? AND released_at IS NULL`,
                [
                    approvedBy,
                    transfer.reason || `Transferred (${transfer.transfer_ref})`,
                    currentAssignment.id
                ]
            );
            if (released.affectedRows !== 1) {
                await connection.rollback();
                return null;
            }
        }

        if (transfer.to_user_id || !currentAssignment) {
            const [assignmentResult] = await connection.query(
                `INSERT INTO asset_assignments
                    (asset_id, assigned_user_id, assigned_to_name, department, location,
                     responsible_officer, assignment_date, purpose, remarks, status, assigned_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ?)`,
                [
                    transfer.asset_id,
                    transfer.to_user_id,
                    transfer.to_custodian_name,
                    transfer.to_department,
                    transfer.to_location,
                    transfer.responsible_officer ||
                        (currentAssignment && currentAssignment.responsible_officer) ||
                        null,
                    transfer.transfer_date,
                    (currentAssignment && currentAssignment.purpose) || 'Transferred',
                    transfer.remarks,
                    approvedBy
                ]
            );
            assignmentId = assignmentResult.insertId;
        } else if (currentAssignment) {
            await connection.query(
                `UPDATE asset_assignments
                 SET department = ?, location = ?, remarks = ?
                 WHERE id = ? AND released_at IS NULL`,
                [
                    transfer.to_department,
                    transfer.to_location,
                    transfer.remarks || currentAssignment.remarks,
                    currentAssignment.id
                ]
            );
        }

        const assetUpdates = [];
        const assetValues = [];
        if (transfer.to_user_id !== null) {
            assetUpdates.push('assigned_user_id = ?');
            assetValues.push(transfer.to_user_id);
        }
        if (transfer.to_department !== null) {
            assetUpdates.push('department = ?');
            assetValues.push(transfer.to_department);
        }
        if (transfer.to_location !== null) {
            assetUpdates.push('location = ?');
            assetValues.push(transfer.to_location);
        }
        if (transfer.to_condition !== null) {
            assetUpdates.push('condition_status = ?');
            assetValues.push(transfer.to_condition);
        }
        if (transfer.to_user_id) {
            assetUpdates.push("status = 'In Use'");
        } else if (['Stock', 'Location', 'Department'].includes(transfer.transfer_type)) {
            assetUpdates.push("status = 'In Stock'");
        }
        if (assetUpdates.length) {
            assetValues.push(transfer.asset_id);
            await connection.query(
                `UPDATE assets SET ${assetUpdates.join(', ')} WHERE id = ?`,
                assetValues
            );
        }

        await connection.query(
            `UPDATE transfers
             SET status = 'Completed', approved_by = ?, assignment_id = ?
             WHERE id = ? AND status = 'Pending'`,
            [approvedBy, assignmentId, id]
        );

        await connection.commit();
        committed = true;
    } catch (error) {
        if (!committed) await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    return findById(id);
}


/* ========================================================================== */
/* Counters and summaries                                                     */
/* ========================================================================== */

/**
 * Counts the transfers recorded against one asset. Used to report how often an
 * asset has moved.
 *
 * @param {number|string} assetId
 * @returns {Promise<number>}
 */
async function countByAssetId(assetId) {
    const [rows] = await db.query(
        `SELECT COUNT(*) AS total
         FROM transfers
         WHERE asset_id = ?`,
        [assetId]
    );
    return rows[0].total;
}

/**
 * Finds the highest existing numeric suffix on `transfer_ref` for a prefix, so
 * the controller can mint the next reference without a race-prone COUNT(*).
 *
 * @param {string} [prefix='TRF-'] The reference prefix.
 * @returns {Promise<number>} The highest suffix found (0 when none exist).
 */
async function findMaxRefSuffix(prefix = 'TRF-') {
    const [rows] = await db.query(
        `SELECT MAX(CAST(SUBSTRING(transfer_ref, ?) AS UNSIGNED)) AS max_suffix
         FROM transfers
         WHERE transfer_ref LIKE ?`,
        [prefix.length + 1, `${prefix}%`]
    );

    const value = rows[0] ? rows[0].max_suffix : null;
    return value === null || value === undefined ? 0 : Number(value);
}

/**
 * True when the supplied transfer reference is already in use.
 *
 * @param {string} transferRef
 * @returns {Promise<boolean>}
 */
async function transferRefExists(transferRef) {
    const [rows] = await db.query(
        'SELECT id FROM transfers WHERE transfer_ref = ? LIMIT 1',
        [transferRef]
    );
    return rows.length > 0;
}

/**
 * Aggregate counts used by the transfer summary tiles.
 *
 * @param {object} [options]
 * @param {number} [options.userId] Restrict to movements a custodian was part of.
 * @returns {Promise<{total: number, completed: number, pending: number,
 *                    cancelled: number, reversed: number,
 *                    unacknowledged: number, byStatus: object[],
 *                    byType: object[], byMonth: object[],
 *                    byDestination: object[]}>}
 */
async function getStats({ userId = null } = {}) {
    const where = [];
    const params = [];

    if (userId !== null && userId !== undefined) {
        where.push('(to_user_id = ? OR from_user_id = ?)');
        params.push(userId, userId);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [totalRows] = await db.query(
        `SELECT COUNT(*) AS total FROM transfers ${whereSql}`,
        params
    );

    const [statusRows] = await db.query(
        `SELECT status, COUNT(*) AS total
         FROM transfers
         ${whereSql}
         GROUP BY status
         ORDER BY status ASC`,
        params
    );

    const [flagRows] = await db.query(
        `SELECT
            SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN status = 'Reversed' THEN 1 ELSE 0 END) AS reversed,
            SUM(CASE WHEN status = 'Completed'
                      AND receiving_party_acknowledged_at IS NULL THEN 1 ELSE 0 END)
                AS unacknowledged
         FROM transfers
         ${whereSql}`,
        params
    );

    const [byType] = await db.query(
        `SELECT transfer_type, COUNT(*) AS total
         FROM transfers
         ${whereSql}
         GROUP BY transfer_type
         ORDER BY total DESC`,
        params
    );

    const [byMonth] = await db.query(
        `SELECT DATE_FORMAT(transfer_date, '%Y-%m') AS month, COUNT(*) AS total
         FROM transfers
         ${whereSql}
         GROUP BY month
         ORDER BY month DESC
         LIMIT 12`,
        params
    );

    const [byDestination] = await db.query(
        `SELECT
            COALESCE(NULLIF(to_department, ''), 'Unspecified') AS department,
            COUNT(*) AS total
         FROM transfers
         ${whereSql}
         GROUP BY department
         ORDER BY total DESC`,
        params
    );

    const flags = flagRows[0] || {};

    return {
        total: totalRows[0].total,
        completed: Number(flags.completed || 0),
        pending: Number(flags.pending || 0),
        cancelled: Number(flags.cancelled || 0),
        reversed: Number(flags.reversed || 0),
        unacknowledged: Number(flags.unacknowledged || 0),
        byStatus: statusRows,
        byType,
        byMonth,
        byDestination
    };
}

module.exports = {
    TRANSFER_TABLE,
    TRANSFER_TABLE_DDL,
    TRANSFER_COLUMNS,
    TRANSFER_JOIN_COLUMNS,
    TRANSFER_SELECT,

    // Bootstrap
    ensureTable,

    // Reads
    findById,
    findByRef,
    findHistoryByAssetId,
    findByUserId,
    findAll,

    // Writes
    create,
    update,
    acknowledgeReceipt,
    setStatus,
    approvePending,

    // Counters / summaries
    countByAssetId,
    findMaxRefSuffix,
    transferRefExists,
    getStats
};
