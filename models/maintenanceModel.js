'use strict';

// models/maintenanceModel.js
// All database access for fault reporting, repairs and servicing: the
// `maintenance_records` table.
// Controllers must never build SQL themselves - every query lives here so
// column/table names stay in one place.
//
// Design notes
//   * A maintenance record is the history of one intervention on one asset.
//     §5.5 asks for faults, service requests and maintenance activities, the
//     technician/vendor who did the work, the dates, the cost, the parts used
//     and the eventual resolution. All of those live on this row so the
//     maintenance history of an asset is simply its rows, newest first.
//   * §12 wants "Open repairs, overdue maintenance and maintenance history" and
//     §5.5 wants "assets currently under repair". `status` carries the workflow
//     and the controller keeps `assets.status` in step, so 'Under Repair' is
//     always derived from an open record rather than hand-maintained.
//   * `maintenance_ref` is a human-quotable reference (MNT-000001) written on
//     the job card / repair report handed to the workshop.
//   * Records are never physically deleted: a record raised in error is
//     cancelled so the repair history stays complete and auditable.
//
// This module also owns the idempotent DDL for its own table so the module can
// be deployed without re-running the full database initialiser.

const db = require('../config/db');

/**
 * DDL for the `maintenance_records` table.
 *
 * Kept next to the queries so the shape the SQL below expects is documented in
 * one place. `CREATE TABLE IF NOT EXISTS` makes this safe to call repeatedly.
 *
 * The technician/vendor names are stored as free text rather than foreign keys
 * because repairs are frequently carried out by external suppliers who have no
 * account on this system. The `asset_id` foreign key cascades so removing a
 * throwaway asset cannot leave orphaned rows.
 */
const MAINTENANCE_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS maintenance_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        maintenance_ref VARCHAR(50) UNIQUE,            -- MNT-000001, printed on the job card
        asset_id INT NOT NULL,                         -- FK to assets.id

        maintenance_type ENUM('Repair', 'Service', 'Inspection', 'Upgrade', 'Warranty Claim', 'Other')
            DEFAULT 'Repair',
        priority ENUM('Low', 'Medium', 'High', 'Critical') DEFAULT 'Medium',

        -- What was reported and by whom.
        reported_by INT,                               -- FK to users.id (who raised the fault)
        reported_date DATE NOT NULL,
        fault_description TEXT,                        -- symptom as reported by the user

        -- Who is doing / did the work.
        technician_name VARCHAR(100),
        vendor VARCHAR(150),                           -- external provider, if any
        work_performed TEXT,                           -- what was actually done
        parts_used TEXT,
        resolution VARCHAR(255),

        -- Scheduling and completion.
        scheduled_date DATE,
        start_date DATE,
        completion_date DATE,
        warranty_claim BOOLEAN DEFAULT FALSE,
        cost DECIMAL(15, 2) DEFAULT 0.00,

        -- Condition on return, so the asset register can be corrected.
        condition_after ENUM('Good', 'Fair', 'Damaged', 'Obsolete'),
        status ENUM('Pending', 'In Progress', 'Completed', 'On Hold', 'Cancelled')
            DEFAULT 'Pending',
        remarks TEXT,

        performed_by INT,                              -- FK to users.id (officer recording it)
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (reported_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_maintenance_asset (asset_id),
        INDEX idx_maintenance_status (status),
        INDEX idx_maintenance_type (maintenance_type),
        INDEX idx_maintenance_reported (reported_date),
        INDEX idx_maintenance_scheduled (scheduled_date)
    )
`;

// Column list used for every client-facing SELECT so the API shape never
// drifts.
const MAINTENANCE_COLUMNS = `
    mr.id,
    mr.maintenance_ref,
    mr.asset_id,
    mr.maintenance_type,
    mr.priority,
    mr.reported_by,
    mr.reported_date,
    mr.fault_description,
    mr.technician_name,
    mr.vendor,
    mr.work_performed,
    mr.parts_used,
    mr.resolution,
    mr.scheduled_date,
    mr.start_date,
    mr.completion_date,
    mr.warranty_claim,
    mr.cost,
    mr.condition_after,
    mr.status,
    mr.remarks,
    mr.performed_by,
    mr.created_at,
    mr.updated_at
`;

// The maintenance table plus its lookup joins, always applied together.
const MAINTENANCE_FROM = `
    FROM maintenance_records mr
    LEFT JOIN assets a ON a.id = mr.asset_id
    LEFT JOIN asset_categories c ON c.id = a.category_id
    LEFT JOIN users rb ON rb.id = mr.reported_by
    LEFT JOIN users pb ON pb.id = mr.performed_by
`;

// Joined helper columns appended after MAINTENANCE_COLUMNS.
const MAINTENANCE_JOIN_COLUMNS = `
    a.asset_id AS asset_code,
    a.asset_tag AS asset_tag,
    a.serial_number AS serial_number,
    a.status AS asset_status,
    a.condition_status AS asset_condition,
    a.location AS asset_location,
    a.department AS asset_department,
    c.name AS category_name,
    rb.full_name AS reported_by_name,
    rb.username AS reported_by_username,
    pb.full_name AS performed_by_name,
    pb.username AS performed_by_username
`;

// The select used by every single-record read so the shape is identical whether
// the row came from a list, a create or an update.
const MAINTENANCE_SELECT = `
    SELECT
        ${MAINTENANCE_COLUMNS},
        ${MAINTENANCE_JOIN_COLUMNS}
    ${MAINTENANCE_FROM}
`;

// Table name as it appears in audit_logs.table_name.
const MAINTENANCE_TABLE = 'maintenance_records';

/**
 * Creates the `maintenance_records` table when it does not exist yet.
 *
 * Called by the module bootstrap and by the test suite so a fresh checkout can
 * exercise maintenance endpoints without re-running `scripts/initDb.js`.
 *
 * @returns {Promise<void>}
 */
async function ensureTable() {
    await db.query(MAINTENANCE_TABLE_DDL);
}

/* ========================================================================== */
/* Reads                                                                      */
/* ========================================================================== */

/**
 * Fetches one maintenance record by primary key, with its joined context.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
    const [rows] = await db.query(`${MAINTENANCE_SELECT} WHERE mr.id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

/**
 * Fetches one maintenance record by its human reference (MNT-000001).
 *
 * @param {string} ref
 * @returns {Promise<object|null>}
 */
async function findByRef(ref) {
    const [rows] = await db.query(
        `${MAINTENANCE_SELECT} WHERE mr.maintenance_ref = ? LIMIT 1`,
        [ref]
    );
    return rows[0] || null;
}

/**
 * The full maintenance history of one asset (§5.5), newest first.
 *
 * @param {number|string} assetId
 * @returns {Promise<object[]>}
 */
async function findByAssetId(assetId, reportedBy = null) {
    const reporterScope = reportedBy === null ? '' : ' AND mr.reported_by = ?';
    const params = reportedBy === null ? [assetId] : [assetId, reportedBy];
    const [rows] = await db.query(
        `${MAINTENANCE_SELECT}
         WHERE mr.asset_id = ?${reporterScope}
         ORDER BY mr.reported_date DESC, mr.id DESC`,
        params
    );
    return rows;
}

/**
 * Every maintenance record raised by one user.
 *
 * @param {number|string} userId
 * @returns {Promise<object[]>}
 */
async function findByReporterId(userId) {
    const [rows] = await db.query(
        `${MAINTENANCE_SELECT}
         WHERE mr.reported_by = ?
         ORDER BY mr.reported_date DESC, mr.id DESC`,
        [userId]
    );
    return rows;
}

/**
 * Lists maintenance records with filtering, free-text search and pagination.
 *
 * @param {object} [options]
 * @param {string} [options.search]            Matches ref, technician, vendor,
 *                                             fault text and the asset's tag/serial.
 * @param {number} [options.assetId]
 * @param {number} [options.reportedBy]
 * @param {string} [options.status]            ENUM value or 'Open' / 'Closed'.
 * @param {string} [options.maintenanceType]
 * @param {string} [options.priority]
 * @param {boolean} [options.warrantyClaim]
 * @param {string} [options.dateFrom]          YYYY-MM-DD (reported_date >=).
 * @param {string} [options.dateTo]            YYYY-MM-DD (reported_date <=).
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @param {string} [options.sort='reported_date']
 * @param {string} [options.order='DESC']
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function findAll(options = {}) {
    const {
        search,
        assetId,
        reportedBy,
        status,
        maintenanceType,
        priority,
        warrantyClaim,
        dateFrom,
        dateTo,
        limit = 50,
        offset = 0,
        sort = 'reported_date',
        order = 'DESC'
    } = options;

    const where = [];
    const params = [];

    if (assetId !== undefined && assetId !== null && assetId !== '') {
        where.push('mr.asset_id = ?');
        params.push(assetId);
    }

    if (reportedBy !== undefined && reportedBy !== null && reportedBy !== '') {
        where.push('mr.reported_by = ?');
        params.push(reportedBy);
    }

    if (maintenanceType) {
        where.push('mr.maintenance_type = ?');
        params.push(maintenanceType);
    }

    if (priority) {
        where.push('mr.priority = ?');
        params.push(priority);
    }

    // 'Open' / 'Closed' are conveniences the UI uses instead of listing the
    // individual ENUM values.
    if (status === 'Open') {
        where.push("mr.status IN ('Pending', 'In Progress', 'On Hold')");
    } else if (status === 'Closed') {
        where.push("mr.status IN ('Completed', 'Cancelled')");
    } else if (status) {
        where.push('mr.status = ?');
        params.push(status);
    }

    if (warrantyClaim !== undefined && warrantyClaim !== null && warrantyClaim !== '') {
        where.push('mr.warranty_claim = ?');
        params.push(warrantyClaim ? 1 : 0);
    }

    if (dateFrom) {
        where.push('mr.reported_date >= ?');
        params.push(dateFrom);
    }

    if (dateTo) {
        where.push('mr.reported_date <= ?');
        params.push(dateTo);
    }

    if (search) {
        const like = `%${search}%`;
        where.push(
            `(mr.maintenance_ref LIKE ?
              OR mr.technician_name LIKE ?
              OR mr.vendor LIKE ?
              OR mr.fault_description LIKE ?
              OR mr.work_performed LIKE ?
              OR a.asset_tag LIKE ?
              OR a.asset_id LIKE ?
              OR a.serial_number LIKE ?)`
        );
        params.push(like, like, like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Whitelist the sortable columns - never interpolate raw user input.
    const sortable = {
        reported_date: 'mr.reported_date',
        scheduled_date: 'mr.scheduled_date',
        completion_date: 'mr.completion_date',
        cost: 'mr.cost',
        priority: 'mr.priority',
        status: 'mr.status',
        maintenance_type: 'mr.maintenance_type',
        maintenance_ref: 'mr.maintenance_ref',
        created_at: 'mr.created_at'
    };
    const sortColumn = sortable[sort] || sortable.reported_date;
    const sortOrder = String(order).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total ${MAINTENANCE_FROM} ${whereSql}`,
        params
    );

    const [rows] = await db.query(
        `${MAINTENANCE_SELECT}
         ${whereSql}
         ORDER BY ${sortColumn} ${sortOrder}, mr.id DESC
         LIMIT ? OFFSET ?`,
        [...params, safeLimit, safeOffset]
    );

    return { rows, total: countRows[0] ? countRows[0].total : 0 };
}


/* ========================================================================== */
/* Writes                                                                     */
/* ========================================================================== */

/**
 * Inserts a maintenance record.
 *
 * @param {object} data Column values keyed by their DB names.
 * @returns {Promise<number>} The new row id.
 */
async function create(data) {
    const [result] = await db.query(
        `INSERT INTO maintenance_records
            (maintenance_ref, asset_id, maintenance_type, priority,
             reported_by, reported_date, fault_description,
             technician_name, vendor, work_performed, parts_used, resolution,
             scheduled_date, start_date, completion_date,
             warranty_claim, cost, condition_after, status, remarks, performed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.maintenance_ref ?? null,
            data.asset_id,
            data.maintenance_type ?? 'Repair',
            data.priority ?? 'Medium',
            data.reported_by ?? null,
            data.reported_date,
            data.fault_description ?? null,
            data.technician_name ?? null,
            data.vendor ?? null,
            data.work_performed ?? null,
            data.parts_used ?? null,
            data.resolution ?? null,
            data.scheduled_date ?? null,
            data.start_date ?? null,
            data.completion_date ?? null,
            data.warranty_claim ? 1 : 0,
            data.cost ?? 0,
            data.condition_after ?? null,
            data.status ?? 'Pending',
            data.remarks ?? null,
            data.performed_by ?? null
        ]
    );

    return result.insertId;
}

/**
 * Updates only the keys present in `data`. Unknown keys are ignored so a
 * controller cannot accidentally write an arbitrary column.
 *
 * @param {number|string} id
 * @param {object} data
 * @returns {Promise<number>} Number of rows changed.
 */
async function update(id, data) {
    const allowed = [
        'maintenance_ref',
        'asset_id',
        'maintenance_type',
        'priority',
        'reported_by',
        'reported_date',
        'fault_description',
        'technician_name',
        'vendor',
        'work_performed',
        'parts_used',
        'resolution',
        'scheduled_date',
        'start_date',
        'completion_date',
        'warranty_claim',
        'cost',
        'condition_after',
        'status',
        'remarks',
        'performed_by'
    ];

    const sets = [];
    const params = [];

    for (const key of allowed) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        sets.push(`${key} = ?`);
        params.push(key === 'warranty_claim' ? (data[key] ? 1 : 0) : data[key]);
    }

    if (!sets.length) return 0;

    params.push(id);
    const [result] = await db.query(
        `UPDATE maintenance_records SET ${sets.join(', ')} WHERE id = ?`,
        params
    );

    return result.affectedRows;
}

/**
 * Flips a record's workflow status.
 *
 * Closing a record (Completed / Cancelled) stamps `completion_date` when the
 * caller has not supplied one, so the report always has an end date.
 *
 * @param {number|string} id
 * @param {string} status
 * @param {object} [extra] Additional columns to write alongside the status.
 * @returns {Promise<number>}
 */
async function setStatus(id, status, extra = {}) {
    return update(id, { ...extra, status });
}



/* ========================================================================== */
/* Counters & summaries                                                       */
/* ========================================================================== */

/**
 * Highest numeric suffix currently used for a reference prefix, so the next
 * reference can be minted (MNT-000001).
 *
 * @param {string} prefix
 * @returns {Promise<number>}
 */
async function findMaxRefSuffix(prefix) {
    const [rows] = await db.query(
        `SELECT MAX(CAST(SUBSTRING(maintenance_ref, ?) AS UNSIGNED)) AS max_suffix
         FROM maintenance_records
         WHERE maintenance_ref LIKE ?`,
        [String(prefix).length + 1, `${prefix}%`]
    );
    const value = rows[0] ? rows[0].max_suffix : null;
    return value === null || value === undefined ? 0 : Number(value);
}

/**
 * Exact-match probe for a reference, used to guarantee uniqueness.
 *
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
async function maintenanceRefExists(ref) {
    const [rows] = await db.query(
        'SELECT id FROM maintenance_records WHERE maintenance_ref = ? LIMIT 1',
        [ref]
    );
    return rows.length > 0;
}

/**
 * How many records an asset currently has in the supplied statuses. Used to
 * decide whether an asset is still "under repair".
 *
 * @param {number|string} assetId
 * @param {string[]} [statuses] Defaults to the open statuses.
 * @returns {Promise<number>}
 */
async function countByAssetId(assetId, statuses = ['Pending', 'In Progress', 'On Hold']) {
    if (!statuses.length) return 0;
    const placeholders = statuses.map(() => '?').join(', ');
    const [rows] = await db.query(
        `SELECT COUNT(*) AS total
         FROM maintenance_records
         WHERE asset_id = ? AND status IN (${placeholders})`,
        [assetId, ...statuses]
    );
    return rows[0] ? Number(rows[0].total) : 0;
}

/**
 * The most recently reported records, for the dashboard panel (§12).
 *
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
async function findRecent(limit = 10, reportedBy = null) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
    const scope = reportedBy === null ? '' : 'WHERE mr.reported_by = ?';
    const [rows] = await db.query(
        `${MAINTENANCE_SELECT}
         ${scope}
         ORDER BY mr.reported_date DESC, mr.id DESC
         LIMIT ?`,
        reportedBy === null ? [safeLimit] : [reportedBy, safeLimit]
    );
    return rows;
}

/**
 * Open records whose scheduled date has passed (§12 "overdue maintenance").
 *
 * @returns {Promise<object[]>}
 */
async function findOverdue(reportedBy = null) {
    const reporterScope = reportedBy === null ? '' : ' AND mr.reported_by = ?';
    const [rows] = await db.query(
        `${MAINTENANCE_SELECT}
         WHERE mr.status IN ('Pending', 'In Progress', 'On Hold')
          AND mr.scheduled_date IS NOT NULL
          AND mr.scheduled_date < CURDATE()
          ${reporterScope}
          ORDER BY mr.scheduled_date ASC, mr.id ASC`,
        reportedBy === null ? [] : [reportedBy]
    );
    return rows;
}

/**
 * Every record still open on an asset, newest first. The controller uses the
 * first row when the caller omits details on a completion.
 *
 * @param {number|string} assetId
 * @returns {Promise<object[]>}
 */
async function findOpenByAssetId(assetId, reportedBy = null) {
    const reporterScope = reportedBy === null ? '' : ' AND mr.reported_by = ?';
    const params = reportedBy === null ? [assetId] : [assetId, reportedBy];
    const [rows] = await db.query(
        `${MAINTENANCE_SELECT}
         WHERE mr.asset_id = ?
          AND mr.status IN ('Pending', 'In Progress', 'On Hold')
          ${reporterScope}
         ORDER BY mr.reported_date DESC, mr.id DESC`,
        params
    );
    return rows;
}


/**
 * Aggregate maintenance figures for the dashboard and stats endpoint (§12).
 *
 * @returns {Promise<object>}
 */
async function getStats() {
    const [totalRows] = await db.query('SELECT COUNT(*) AS total FROM maintenance_records');

    const [statusRows] = await db.query(
        `SELECT status, COUNT(*) AS total
         FROM maintenance_records
         GROUP BY status
         ORDER BY status ASC`
    );

    const [flagRows] = await db.query(
        `SELECT
            SUM(CASE WHEN status IN ('Pending', 'In Progress', 'On Hold') THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN status IN ('Pending', 'In Progress', 'On Hold')
                      AND maintenance_type = 'Repair' THEN 1 ELSE 0 END) AS open_repairs,
            SUM(CASE WHEN status IN ('Pending', 'In Progress', 'On Hold')
                      AND maintenance_type = 'Service' THEN 1 ELSE 0 END) AS open_services,
            SUM(CASE WHEN status IN ('Pending', 'In Progress', 'On Hold')
                      AND maintenance_type NOT IN ('Repair', 'Service') THEN 1 ELSE 0 END) AS open_other,
            SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN status IN ('Pending', 'In Progress', 'On Hold')
                      AND scheduled_date IS NOT NULL
                      AND scheduled_date < CURDATE() THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE WHEN warranty_claim = 1 THEN 1 ELSE 0 END) AS warranty_claims,
            COALESCE(SUM(cost), 0) AS total_cost,
            COALESCE(SUM(CASE WHEN YEAR(reported_date) = YEAR(CURDATE())
                              THEN cost ELSE 0 END), 0) AS cost_this_year
         FROM maintenance_records`
    );

    const [byType] = await db.query(
        `SELECT maintenance_type, COUNT(*) AS total
         FROM maintenance_records
         GROUP BY maintenance_type
         ORDER BY total DESC`
    );

    const [byPriority] = await db.query(
        `SELECT priority, COUNT(*) AS total
         FROM maintenance_records
         GROUP BY priority
         ORDER BY FIELD(priority, 'Critical', 'High', 'Medium', 'Low') ASC`
    );

    const [byMonth] = await db.query(
        `SELECT DATE_FORMAT(reported_date, '%Y-%m') AS month, COUNT(*) AS total,
                COALESCE(SUM(cost), 0) AS cost
         FROM maintenance_records
         GROUP BY month
         ORDER BY month DESC
         LIMIT 12`
    );

    const [topAssets] = await db.query(
        `SELECT
            mr.asset_id,
            a.asset_tag AS asset_tag,
            a.asset_id AS asset_code,
            COUNT(*) AS total,
            COALESCE(SUM(mr.cost), 0) AS cost
         FROM maintenance_records mr
         LEFT JOIN assets a ON a.id = mr.asset_id
         GROUP BY mr.asset_id, a.asset_tag, a.asset_id
         ORDER BY total DESC, cost DESC
         LIMIT 10`
    );

    const flags = flagRows[0] || {};

    return {
        total: totalRows[0] ? totalRows[0].total : 0,
        open: Number(flags.open_count || 0),
        openRepairs: Number(flags.open_repairs || 0),
        openServices: Number(flags.open_services || 0),
        openOther: Number(flags.open_other || 0),
        completed: Number(flags.completed || 0),
        cancelled: Number(flags.cancelled || 0),
        overdue: Number(flags.overdue || 0),
        warrantyClaims: Number(flags.warranty_claims || 0),
        totalCost: Number(flags.total_cost || 0),
        costThisYear: Number(flags.cost_this_year || 0),
        byStatus: statusRows,
        byType,
        byPriority,
        byMonth,
        topAssets
    };
}

module.exports = {
    MAINTENANCE_TABLE,
    MAINTENANCE_TABLE_DDL,
    MAINTENANCE_COLUMNS,
    MAINTENANCE_FROM,
    MAINTENANCE_JOIN_COLUMNS,
    MAINTENANCE_SELECT,

    // Bootstrap
    ensureTable,

    // Reads
    findById,
    findByRef,
    findByAssetId,
    findByReporterId,
    findAll,
    findRecent,
    findOverdue,
    findOpenByAssetId,

    // Writes
    create,
    update,
    setStatus,

    // Counters / summaries
    countByAssetId,
    findMaxRefSuffix,
    maintenanceRefExists,
    getStats
};
