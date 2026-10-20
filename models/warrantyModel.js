'use strict';

// models/warrantyModel.js
// All database access for warranty and contract monitoring: the `warranties`
// table plus the warranty columns already carried on the asset register.
// Controllers must never build SQL themselves - every query lives here so
// column/table names stay in one place.
//
// Design notes
//   * §6 (Minimum Asset Data) already asks the register to hold Warranty
//     Provider, Warranty Start Date, Warranty End Date and Warranty Reference,
//     and those four columns exist on `assets`. §5.6 additionally asks for
//     "support and maintenance contracts" to be monitored, which need their own
//     reference, type, value, supplier contact and notice period. A single
//     warranty row per asset cannot express that, so this table holds the
//     richer records while the register keeps its own columns.
//   * Consequently a warranty in this table is DERIVED from the asset register
//     when it does not yet have a row: `findAll` reads assets that carry a
//     warranty window and reports them alongside the explicitly stored rows.
//     Nothing already captured on the register becomes invisible.
//   * `warranty_ref` is a human-quotable reference (WAR-000001) printed on the
//     warranty certificate or contract schedule.
//   * §12 wants "warranties expiring within configurable periods", so the
//     expiry window is a parameter throughout rather than a hard-coded number.
//   * Records are never physically deleted: a warranty replaced by a newer
//     contract is cancelled so the coverage history stays auditable.
//

/**
 * DDL for the `warranties` table.
 *
 * Kept next to the queries so the shape the SQL below expects is documented in
 * one place. `CREATE TABLE IF NOT EXISTS` makes this safe to call repeatedly.
 *
 * The provider and supplier contact are free text rather than foreign keys
 * because warranties and support contracts are frequently sold by external
 * suppliers who have no account on this system. `asset_id` cascades so removing
 * a throwaway asset cannot leave orphaned rows, while a NULL `asset_id` is
 * allowed because a site-wide support contract need not name one asset - those
 * rows are identified by `contract_ref` instead.
 */
const WARRANTY_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS warranties (
        id INT AUTO_INCREMENT PRIMARY KEY,
        warranty_ref VARCHAR(50) UNIQUE,               -- WAR-000001
        asset_id INT NULL,                             -- FK to assets.id (NULL for site-wide contracts)

        warranty_type ENUM('Asset Warranty', 'Extended Warranty', 'Support Contract',
                           'Maintenance Contract', 'Service Level Agreement',
                           'Licence Support', 'Insurance', 'Other')
            DEFAULT 'Asset Warranty',
        contract_ref VARCHAR(100),                     -- supplier's own contract / policy number
        title VARCHAR(150),                            -- short description of what is covered

        -- Who provides the cover.
        provider VARCHAR(150),
        provider_contact VARCHAR(100),
        provider_email VARCHAR(100),
        provider_phone VARCHAR(50),

        -- When the cover runs.
        start_date DATE NOT NULL,
        expiry_date DATE NOT NULL,
        notice_period_days INT,                        -- days' notice needed to cancel / renew
        auto_renew BOOLEAN DEFAULT FALSE,

        -- Commercial terms.
        coverage_details TEXT,                         -- what the cover includes
        excluded_items TEXT,                           -- what it does not
        contract_value DECIMAL(15, 2) DEFAULT 0.00,
        currency VARCHAR(10) DEFAULT 'USD',
        payment_terms VARCHAR(100),

        -- Lifecycle.
        status ENUM('Active', 'Expiring Soon', 'Expired', 'Cancelled') DEFAULT 'Active',
        renewed_from INT,                              -- previous warranty id, when this extends one
        cancelled_date DATE,
        cancellation_reason VARCHAR(255),
        remarks TEXT,
        created_by INT,                                -- FK to users.id
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (renewed_from) REFERENCES warranties(id) ON DELETE SET NULL,
        INDEX idx_warranty_asset (asset_id),
        INDEX idx_warranty_status (status),
        INDEX idx_warranty_expiry (expiry_date),
        INDEX idx_warranty_type (warranty_type),
        INDEX idx_warranty_provider (provider)
    )
`;

// This module also owns the idempotent DDL for its own table so the module can
// be deployed without re-running the full database initialiser.

const db = require('../config/db');

// Column list used for every client-facing SELECT so the API shape never
// drifts.
const WARRANTY_COLUMNS = `
    w.id,
    w.warranty_ref,
    w.asset_id,
    w.warranty_type,
    w.contract_ref,
    w.title,
    w.provider,
    w.provider_contact,
    w.provider_email,
    w.provider_phone,
    w.start_date,
    w.expiry_date,
    w.notice_period_days,
    w.auto_renew,
    w.coverage_details,
    w.excluded_items,
    w.contract_value,
    w.currency,
    w.payment_terms,
    w.status,
    w.renewed_from,
    w.cancelled_date,
    w.cancellation_reason,
    w.remarks,
    w.created_by,
    w.created_at,
    w.updated_at
`;

// The warranty table plus its lookup joins, always applied together.
const WARRANTY_FROM = `
    FROM warranties w
    LEFT JOIN assets a ON a.id = w.asset_id
    LEFT JOIN asset_categories c ON c.id = a.category_id
    LEFT JOIN users cb ON cb.id = w.created_by
`;

// Joined helper columns appended after WARRANTY_COLUMNS.
const WARRANTY_JOIN_COLUMNS = `
    a.asset_id AS asset_code,
    a.asset_tag AS asset_tag,
    a.serial_number AS serial_number,
    a.status AS asset_status,
    a.condition_status AS asset_condition,
    a.location AS asset_location,
    a.department AS asset_department,
    c.name AS category_name,
    cb.full_name AS created_by_name,
    cb.username AS created_by_username,
    DATEDIFF(w.expiry_date, CURDATE()) AS days_remaining,
    CASE
        WHEN w.status = 'Cancelled' THEN 'Cancelled'
        WHEN w.expiry_date < CURDATE() THEN 'Expired'
        WHEN DATEDIFF(w.expiry_date, CURDATE()) <= 90 THEN 'Expiring Soon'
        ELSE 'Active'
    END AS coverage_state
`;

// The select used by every single-record read so the shape is identical whether
// the row came from a list, a create or an update.
const WARRANTY_SELECT = `
    SELECT
        ${WARRANTY_COLUMNS},
        ${WARRANTY_JOIN_COLUMNS}
    ${WARRANTY_FROM}
`;

// The asset register's own warranty columns, reported as derived warranties so
// coverage captured at registration (§6) is never invisible to this module.
const ASSET_WARRANTY_COLUMNS = `
    a.id AS asset_id,
    a.asset_id AS asset_code,
    a.asset_tag AS asset_tag,
    a.serial_number AS serial_number,
    a.warranty_provider AS provider,
    a.warranty_start AS start_date,
    a.warranty_end AS expiry_date,
    a.warranty_ref AS warranty_ref,
    a.status AS asset_status,
    a.condition_status AS asset_condition,
    a.location AS asset_location,
    a.department AS asset_department,
    c.name AS category_name
`;

// Read the register's warranty window, restricted to assets that actually have
// one so a missing start date does not flood the derived list.
const ASSET_WARRANTY_FROM = `
    FROM assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
`;

const ASSET_WARRANTY_SCOPE = "a.warranty_end IS NOT NULL AND a.status <> 'Disposed'";

// Table name as it appears in audit_logs.table_name.
const WARRANTY_TABLE = 'warranties';

function appendAssetIdScope(where, params, assetIds, column) {
    if (!Array.isArray(assetIds)) return;
    if (assetIds.length === 0) {
        where.push('1 = 0');
        return;
    }
    where.push(`${column} IN (${assetIds.map(() => '?').join(', ')})`);
    params.push(...assetIds);
}

/**
 * Creates the `warranties` table when it does not exist yet.
 *
 * Called by the module bootstrap and by the test suite so a fresh checkout can
 * exercise warranty endpoints without re-running `scripts/initDb.js`.
 *
 * @returns {Promise<void>}
 */
async function ensureTable() {
    await db.query(WARRANTY_TABLE_DDL);
}


/* ========================================================================== */
/* Reads                                                                      */
/* ========================================================================== */

/**
 * Fetches one warranty by primary key, with its joined context.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
    const [rows] = await db.query(`${WARRANTY_SELECT} WHERE w.id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

/**
 * Fetches one warranty by its human reference (WAR-000001).
 *
 * @param {string} ref
 * @returns {Promise<object|null>}
 */
async function findByRef(ref) {
    const [rows] = await db.query(`${WARRANTY_SELECT} WHERE w.warranty_ref = ? LIMIT 1`, [ref]);
    return rows[0] || null;
}

/**
 * Every warranty / contract recorded against one asset, newest expiry first.
 *
 * @param {number|string} assetId
 * @returns {Promise<object[]>}
 */
async function findByAssetId(assetId) {
    const [rows] = await db.query(
        `${WARRANTY_SELECT}
         WHERE w.asset_id = ?
         ORDER BY w.expiry_date DESC, w.id DESC`,
        [assetId]
    );
    return rows;
}

/**
 * The warranty rows explicitly stored for an asset, used to decide whether the
 * register's own warranty still needs a derived entry.
 *
 * @param {number|string} assetId
 * @returns {Promise<number>} How many stored rows the asset has.
 */
async function countByAssetId(assetId) {
    const [rows] = await db.query(
        'SELECT COUNT(*) AS total FROM warranties WHERE asset_id = ?',
        [assetId]
    );
    return rows[0] ? Number(rows[0].total) : 0;
}

/**
 * Resolves the primary key of an asset from any of its identifiers, so callers
 * may pass a numeric id, the generated asset code or the physical tag.
 *
 * @param {string|number} value
 * @returns {Promise<number|null>}
 */
async function resolveAssetPk(value) {
    const key = value === null || value === undefined ? '' : String(value).trim();
    if (!key) return null;

    const [rows] = await db.query(
        `SELECT id FROM assets
         WHERE (? REGEXP '^[0-9]+$' AND id = ?)
            OR asset_id = ?
            OR asset_tag = ?
         LIMIT 1`,
        [key, key, key, key]
    );

    return rows[0] ? rows[0].id : null;
}


/**
 * Builds the shared WHERE clause for the stored warranty rows.
 *
 * Every filter is optional; only the supplied ones are added. `expiringDays`
 * turns this into the §12 "warranties expiring within configurable periods"
 * query, and `status: 'Open'` means "not cancelled" so the default list view
 * hides history that has been deliberately retired.
 *
 * @param {object} [options]
 * @param {string} [options.search] Free-text match on reference, title,
 *        contract reference, provider, contact and the asset identifiers.
 * @param {string} [options.status] Exact ENUM match, or the pseudo-values
 *        'Open' (anything not cancelled).
 * @param {string} [options.warrantyType] Exact ENUM match.
 * @param {string} [options.provider] Partial match.
 * @param {number} [options.assetId] Numeric asset primary key.
 * @param {string} [options.dateFrom] start_date >= this YYYY-MM-DD.
 * @param {string} [options.dateTo] start_date <= this YYYY-MM-DD.
 * @param {number} [options.expiringDays] Expiry falls within this many days.
 * @param {boolean} [options.expiredOnly] Expiry is already in the past.
 * @returns {{where: string[], params: *[]}}
 */
function buildStoredWhere({
    search,
    status,
    warrantyType,
    provider,
    assetId,
    assetIds,
    dateFrom,
    dateTo,
    expiringDays,
    expiredOnly
} = {}) {
    const where = [];
    const params = [];

    if (status === 'Open') {
        where.push("w.status <> 'Cancelled'");
    } else if (status) {
        where.push('w.status = ?');
        params.push(status);
    }

    if (warrantyType) {
        where.push('w.warranty_type = ?');
        params.push(warrantyType);
    }

    if (provider) {
        where.push('w.provider LIKE ?');
        params.push(`%${provider}%`);
    }

    if (assetId !== undefined && assetId !== null && assetId !== '') {
        where.push('w.asset_id = ?');
        params.push(assetId);
    } else if (Array.isArray(assetIds)) {
        // A scoped caller (a Departmental User) may only see their own assets.
        // An empty list must match nothing rather than everything.
        if (!assetIds.length) {
            where.push('1 = 0');
        } else {
            where.push(`w.asset_id IN (${assetIds.map(() => '?').join(', ')})`);
            params.push(...assetIds);
        }
    }

    if (dateFrom) {
        where.push('w.start_date >= ?');
        params.push(dateFrom);
    }

    if (dateTo) {
        where.push('w.start_date <= ?');
        params.push(dateTo);
    }

    if (expiredOnly) {
        where.push("w.status <> 'Cancelled' AND w.expiry_date < CURDATE()");
    } else if (expiringDays !== undefined && expiringDays !== null && expiringDays !== '') {
        const days = Math.max(0, Math.min(Number(expiringDays) || 0, 3650));
        where.push("w.status <> 'Cancelled' AND w.expiry_date >= CURDATE() AND w.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)");
        params.push(days);
    }

    if (search) {
        const like = `%${search}%`;
        where.push(
            `(w.warranty_ref LIKE ?
              OR w.title LIKE ?
              OR w.contract_ref LIKE ?
              OR w.provider LIKE ?
              OR w.provider_contact LIKE ?
              OR w.coverage_details LIKE ?
              OR a.asset_tag LIKE ?
              OR a.asset_id LIKE ?
              OR a.serial_number LIKE ?)`
        );
        params.push(like, like, like, like, like, like, like, like, like);
    }

    return { where, params };
}

/**
 * Builds the WHERE clause for the register-derived warranties. Column names
 * differ from the stored table (`a.` prefix, `warranty_end` instead of
 * `expiry_date`) so the textual filters are translated here.
 *
 * @param {object} options Mirror of buildStoredWhere.
 * @returns {{where: string[], params: *[]}}
 */
function buildDerivedWhere({
    search,
    status,
    providers,
    dateFrom,
    dateTo,
    expiringDays,
    expiredOnly,
    assetId,
    assetIds,
    warrantyType
} = {}) {
    const where = [];
    const params = [];

    if (status && status !== 'Open') {
        if (status === 'Expired') {
            where.push('a.warranty_end < CURDATE()');
        } else if (status === 'Expiring Soon') {
            where.push('a.warranty_end >= CURDATE() AND DATEDIFF(a.warranty_end, CURDATE()) <= 90');
        } else if (status === 'Active') {
            where.push('a.warranty_end >= CURDATE() AND DATEDIFF(a.warranty_end, CURDATE()) > 90');
        } else {
            // 'Cancelled' has no meaning for a register-derived warranty, and an
            // exact-status match on a stored-only status yields nothing.
            where.push('1 = 0');
        }
    }

    // Only 'Asset Warranty' rows are derived from the register; a request for
    // contracts must not pull the register columns back in.
    if (warrantyType && warrantyType !== 'Asset Warranty') {
        where.push('1 = 0');
    }

    if (providers) {
        where.push('a.warranty_provider LIKE ?');
        params.push(`%${providers}%`);
    }

    if (assetId !== undefined && assetId !== null && assetId !== '') {
        where.push('a.id = ?');
        params.push(assetId);
    } else if (Array.isArray(assetIds)) {
        if (!assetIds.length) {
            where.push('1 = 0');
        } else {
            where.push(`a.id IN (${assetIds.map(() => '?').join(', ')})`);
            params.push(...assetIds);
        }
    }

    if (dateFrom) {
        where.push('a.warranty_start >= ?');
        params.push(dateFrom);
    }

    if (dateTo) {
        where.push('a.warranty_start <= ?');
        params.push(dateTo);
    }

    if (expiredOnly) {
        where.push('a.warranty_end < CURDATE()');
    } else if (expiringDays !== undefined && expiringDays !== null && expiringDays !== '') {
        const days = Math.max(0, Math.min(Number(expiringDays) || 0, 3650));
        where.push('a.warranty_end >= CURDATE() AND a.warranty_end <= DATE_ADD(CURDATE(), INTERVAL ? DAY)');
        params.push(days);
    }

    if (search) {
        const like = `%${search}%`;
        where.push(
            `(a.warranty_ref LIKE ?
              OR a.warranty_provider LIKE ?
              OR a.asset_tag LIKE ?
              OR a.asset_id LIKE ?
              OR a.serial_number LIKE ?)`
        );
        params.push(like, like, like, like, like);
    }

    return { where, params };
}



/**
 * Lists warranties with optional search / filter / sort and pagination.
 *
 * Two sources are merged so the module shows the whole coverage picture:
 *   1. rows explicitly recorded in `warranties` (contracts, extended cover), and
 *   2. assets whose register entry carries a warranty window (§6) but which
 *      have no stored row yet - reported with a synthetic id of
 *      `asset-<assetId>` and `source: 'asset_register'`.
 *
 * The merge is done in SQL with UNION ALL so pagination and totals stay correct
 * rather than being approximated in JavaScript.
 *
 * @param {object} [options] See buildStoredWhere plus the paging / sort keys.
 * @param {boolean} [options.includeDerived=true] Include register-derived rows.
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @param {string} [options.sort='expiry_date'] Whitelisted column.
 * @param {string} [options.order='asc'] 'asc' or 'desc'.
 * @returns {Promise<{rows: object[], total: number, derived: number}>}
 */
async function findAll({
    search,
    status,
    warrantyType,
    provider,
    assetId,
    assetIds,
    dateFrom,
    dateTo,
    expiringDays,
    expiredOnly,
    includeDerived = true,
    limit = 50,
    offset = 0,
    sort = 'expiry_date',
    order = 'asc'
} = {}) {
    const { where, params } = buildStoredWhere({
        search,
        status,
        warrantyType,
        provider,
        assetId,
        assetIds,
        dateFrom,
        dateTo,
        expiringDays,
        expiredOnly
    });

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Whitelist the sortable columns - never interpolate raw user input.
    const sortable = {
        expiry_date: 'expiry_date',
        start_date: 'start_date',
        warranty_ref: 'warranty_ref',
        provider: 'provider',
        status: 'status',
        warranty_type: 'warranty_type',
        contract_value: 'contract_value',
        created_at: 'created_at',
        days_remaining: 'days_remaining'
    };
    const sortColumn = sortable[sort] || sortable.expiry_date;
    const sortOrder = String(order).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const storedSql = `
        SELECT
            ${WARRANTY_COLUMNS},
            'stored' AS source,
            ${WARRANTY_JOIN_COLUMNS}
        ${WARRANTY_FROM}
        ${whereSql}
    `;

    if (!includeDerived) {
        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total ${WARRANTY_FROM} ${whereSql}`,
            params
        );

        const [rows] = await db.query(
            `${storedSql}
             ORDER BY ${sortColumn} ${sortOrder}, id DESC
             LIMIT ? OFFSET ?`,
            [...params, safeLimit, safeOffset]
        );

        return { rows, total: countRows[0] ? countRows[0].total : 0, derived: 0 };
    }


    // The derived branch reuses the same textual filters; only the columns whose
    // names differ between the two sources are translated.
    const derived = buildDerivedWhere({
        search,
        status,
        providers: provider,
        dateFrom,
        dateTo,
        expiringDays,
        expiredOnly,
        assetId,
        assetIds,
        warrantyType
    });

    const derivedSql = `
        SELECT
            CONCAT('asset-', a.id) AS id,
            a.warranty_ref AS warranty_ref,
            a.id AS asset_id,
            'Asset Warranty' AS warranty_type,
            NULL AS contract_ref,
            CONCAT('Register warranty - ', a.asset_tag) AS title,
            a.warranty_provider AS provider,
            NULL AS provider_contact,
            NULL AS provider_email,
            NULL AS provider_phone,
            a.warranty_start AS start_date,
            a.warranty_end AS expiry_date,
            NULL AS notice_period_days,
            0 AS auto_renew,
            NULL AS coverage_details,
            NULL AS excluded_items,
            0 AS contract_value,
            NULL AS currency,
            NULL AS payment_terms,
            CASE
                WHEN a.warranty_end < CURDATE() THEN 'Expired'
                WHEN DATEDIFF(a.warranty_end, CURDATE()) <= 90 THEN 'Expiring Soon'
                ELSE 'Active'
            END AS status,
            NULL AS renewed_from,
            NULL AS cancelled_date,
            NULL AS cancellation_reason,
            NULL AS remarks,
            NULL AS created_by,
            a.date_registered AS created_at,
            a.date_registered AS updated_at,
            'asset_register' AS source,
            a.asset_id AS asset_code,
            a.asset_tag AS asset_tag,
            a.serial_number AS serial_number,
            a.status AS asset_status,
            a.condition_status AS asset_condition,
            a.location AS asset_location,
            a.department AS asset_department,
            c.name AS category_name,
            NULL AS created_by_name,
            NULL AS created_by_username,
            DATEDIFF(a.warranty_end, CURDATE()) AS days_remaining,
            CASE
                WHEN a.warranty_end < CURDATE() THEN 'Expired'
                WHEN DATEDIFF(a.warranty_end, CURDATE()) <= 90 THEN 'Expiring Soon'
                ELSE 'Active'
            END AS coverage_state
        ${ASSET_WARRANTY_FROM}
        WHERE ${ASSET_WARRANTY_SCOPE}
          ${derived.where.length ? `AND ${derived.where.join(' AND ')}` : ''}
          AND NOT EXISTS (
              SELECT 1 FROM warranties w2
              WHERE w2.asset_id = a.id
                AND w2.warranty_type = 'Asset Warranty'
                AND w2.status <> 'Cancelled'
          )
    `;

    const combined = `
        SELECT * FROM (
            ${storedSql}
            UNION ALL
            ${derivedSql}
        ) AS coverage
    `;

    const combinedParams = [...params, ...derived.params];

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total FROM (${combined}) AS counted`,
        combinedParams
    );

    const [rows] = await db.query(
        `${combined}
         ORDER BY ${sortColumn} ${sortOrder}, id DESC
         LIMIT ? OFFSET ?`,
        [...combinedParams, safeLimit, safeOffset]
    );

    return {
        rows,
        total: countRows[0] ? countRows[0].total : 0,
        derived: rows.filter((row) => row.source === 'asset_register').length
    };
}


/**
 * Stored warranties (and register-derived ones) due to expire within N days,
 * excluding anything already expired or cancelled - the §5.6 "upcoming-expiry
 * alert" list.
 *
 * The `withinDays` window is required, never assumed, so the caller owns the
 * "configurable period" from §12 rather than inheriting a magic number.
 *
 * @param {number} withinDays How many days ahead to look.
 * @param {object} [options]
 * @param {boolean} [options.includeDerived=true]
 * @param {number} [options.limit=100]
 * @returns {Promise<object[]>}
 */
async function findExpiring(withinDays = 90, { includeDerived = true, limit = 100, assetIds } = {}) {
    const days = Math.max(0, Math.min(Number(withinDays) || 0, 3650));
    const where = [
        "w.status <> 'Cancelled'",
        'w.expiry_date >= CURDATE()',
        'w.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)'
    ];
    const params = [days];
    appendAssetIdScope(where, params, assetIds, 'w.asset_id');

    const [rows] = await db.query(
        `${WARRANTY_SELECT}
         WHERE ${where.join(' AND ')}
         ORDER BY w.expiry_date ASC, w.id ASC
         LIMIT ?`,
        [...params, Math.max(1, Math.min(Number(limit) || 100, 500))]
    );

    return rows;
}

/**
 * Register-derived warranties due to expire within N days. Kept separate from
 * findExpiring() so the controller can merge both without the stored rows
 * dictating the limit.
 *
 * @param {number} withinDays
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
async function findExpiringOnAssets(withinDays = 90, limit = 100, assetIds) {
    const days = Math.max(0, Math.min(Number(withinDays) || 0, 3650));
    const where = [
        ASSET_WARRANTY_SCOPE,
        'a.warranty_end >= CURDATE()',
        'a.warranty_end <= DATE_ADD(CURDATE(), INTERVAL ? DAY)'
    ];
    const params = [days];
    appendAssetIdScope(where, params, assetIds, 'a.id');
    where.push(`NOT EXISTS (
        SELECT 1 FROM warranties w2
        WHERE w2.asset_id = a.id
          AND w2.warranty_type = 'Asset Warranty'
          AND w2.status <> 'Cancelled'
    )`);

    const [rows] = await db.query(
        `SELECT
            CONCAT('asset-', a.id) AS id,
            a.warranty_ref AS warranty_ref,
            a.id AS asset_id,
            'Asset Warranty' AS warranty_type,
            CONCAT('Register warranty - ', a.asset_tag) AS title,
            a.warranty_provider AS provider,
            a.warranty_start AS start_date,
            a.warranty_end AS expiry_date,
            'asset_register' AS source,
            DATEDIFF(a.warranty_end, CURDATE()) AS days_remaining,
            ${ASSET_WARRANTY_COLUMNS}
         ${ASSET_WARRANTY_FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY a.warranty_end ASC, a.id ASC
         LIMIT ?`,
        [...params, Math.max(1, Math.min(Number(limit) || 100, 500))]
    );

    return rows;
}

/**
 * Coverage that has already lapsed but was never closed off - the backlog an
 * administrator needs to action.
 *
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
async function findExpired(limit = 100, assetIds) {
    const where = ["w.status <> 'Cancelled'", 'w.expiry_date < CURDATE()'];
    const params = [];
    appendAssetIdScope(where, params, assetIds, 'w.asset_id');
    const [rows] = await db.query(
        `${WARRANTY_SELECT}
         WHERE ${where.join(' AND ')}
         ORDER BY w.expiry_date DESC, w.id DESC
         LIMIT ?`,
        [...params, Math.max(1, Math.min(Number(limit) || 100, 500))]
    );
    return rows;
}

/**
 * The most recently recorded warranties, for the dashboard panel.
 *
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
async function findRecent(limit = 10, assetIds) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 100));
    const where = [];
    const params = [];
    appendAssetIdScope(where, params, assetIds, 'w.asset_id');
    const [rows] = await db.query(
        `${WARRANTY_SELECT}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY w.created_at DESC, w.id DESC
         LIMIT ?`,
        [...params, safeLimit]
    );
    return rows;
}

/**
 * Support and maintenance contracts (§5.6) - the stored rows whose type is a
 * contract rather than a per-asset warranty.
 *
 * @param {object} [options]
 * @param {boolean} [options.activeOnly=true] Only cover still running today.
 * @returns {Promise<object[]>}
 */
async function findContracts({ activeOnly = true, assetIds } = {}) {
    const where = [
        "w.warranty_type IN ('Support Contract', 'Maintenance Contract', 'Service Level Agreement', 'Licence Support')"
    ];

    if (activeOnly) {
        where.push("w.status <> 'Cancelled' AND w.expiry_date >= CURDATE()");
    }
    const params = [];
    appendAssetIdScope(where, params, assetIds, 'w.asset_id');

    const [rows] = await db.query(
        `${WARRANTY_SELECT}
         WHERE ${where.join(' AND ')}
         ORDER BY w.expiry_date ASC, w.id ASC`,
        params
    );
    return rows;
}

/**
 * Every warranty currently in force (not expired, not cancelled).
 *
 * @returns {Promise<object[]>}
 */
async function findActive() {
    const [rows] = await db.query(
        `${WARRANTY_SELECT}
         WHERE w.status <> 'Cancelled'
           AND w.expiry_date >= CURDATE()
         ORDER BY w.expiry_date ASC, w.id ASC`
    );
    return rows;
}



/* ========================================================================== */
/* Writes                                                                     */
/* ========================================================================== */

// Columns a caller may write, kept in one place so `create` and `update` cannot
// drift apart.
const WRITABLE_COLUMNS = [
    'warranty_ref',
    'asset_id',
    'warranty_type',
    'contract_ref',
    'title',
    'provider',
    'provider_contact',
    'provider_email',
    'provider_phone',
    'start_date',
    'expiry_date',
    'notice_period_days',
    'auto_renew',
    'coverage_details',
    'excluded_items',
    'contract_value',
    'currency',
    'payment_terms',
    'status',
    'renewed_from',
    'cancelled_date',
    'cancellation_reason',
    'remarks',
    'created_by'
];

// Columns stored as booleans so the driver receives 0/1 rather than a JS value
// MySQL may reject.
const BOOLEAN_COLUMNS = ['auto_renew'];

/**
 * Inserts a warranty / contract record.
 *
 * @param {object} data Column values keyed by their DB names.
 * @returns {Promise<number>} The new row id.
 */
async function create(data) {
    const columns = [];
    const placeholders = [];
    const params = [];

    for (const key of WRITABLE_COLUMNS) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        columns.push(key);
        placeholders.push('?');
        params.push(BOOLEAN_COLUMNS.includes(key) ? (data[key] ? 1 : 0) : data[key]);
    }

    const [result] = await db.query(
        `INSERT INTO warranties (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})`,
        params
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
    const sets = [];
    const params = [];

    for (const key of WRITABLE_COLUMNS) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        sets.push(`${key} = ?`);
        params.push(BOOLEAN_COLUMNS.includes(key) ? (data[key] ? 1 : 0) : data[key]);
    }

    if (!sets.length) return 0;

    params.push(id);
    const [result] = await db.query(
        `UPDATE warranties SET ${sets.join(', ')} WHERE id = ?`,
        params
    );

    return result.affectedRows;
}

/**
 * Flips a record's lifecycle status.
 *
 * Cancelling stamps `cancelled_date` when the caller has not supplied one, so
 * the coverage history always has an end date.
 *
 * @param {number|string} id
 * @param {string} status
 * @param {object} [extra] Additional columns to write alongside the status.
 * @returns {Promise<number>}
 */
async function setStatus(id, status, extra = {}) {
    const columns = { ...extra, status };

    if (status === 'Cancelled' && !columns.cancelled_date) {
        columns.cancelled_date = new Date().toISOString().slice(0, 10);
    }

    return update(id, columns);
}



/* ========================================================================== */
/* Counters & summaries                                                       */
/* ========================================================================== */

/**
 * Highest numeric suffix currently used for a reference prefix, so the next
 * reference can be minted (WAR-000001).
 *
 * @param {string} prefix
 * @returns {Promise<number>}
 */
async function findMaxRefSuffix(prefix) {
    const [rows] = await db.query(
        `SELECT MAX(CAST(SUBSTRING(warranty_ref, ?) AS UNSIGNED)) AS max_suffix
         FROM warranties
         WHERE warranty_ref LIKE ?`,
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
async function warrantyRefExists(ref) {
    const [rows] = await db.query(
        'SELECT id FROM warranties WHERE warranty_ref = ? LIMIT 1',
        [ref]
    );
    return rows.length > 0;
}

/**
 * Aggregate warranty figures for the dashboard and the stats endpoint (§12).
 *
 * `expiringSoon` uses a 90-day default so the number matches the badge the UI
 * shows; the dedicated /expiring endpoint takes the window as a parameter.
 *
 * @param {number} [expiringDays=90]
 * @returns {Promise<object>}
 */
async function getStats(expiringDays = 90) {
    const days = Math.max(0, Math.min(Number(expiringDays) || 0, 3650));

    const [totalRows] = await db.query('SELECT COUNT(*) AS total FROM warranties');

    const [statusRows] = await db.query(
        `SELECT status, COUNT(*) AS total
         FROM warranties
         GROUP BY status
         ORDER BY status ASC`
    );

    const [typeRows] = await db.query(
        `SELECT warranty_type, COUNT(*) AS total
         FROM warranties
         GROUP BY warranty_type
         ORDER BY total DESC`
    );

    const [providerRows] = await db.query(
        `SELECT provider, COUNT(*) AS total, COALESCE(SUM(contract_value), 0) AS value
         FROM warranties
         WHERE provider IS NOT NULL AND provider <> ''
         GROUP BY provider
         ORDER BY total DESC, provider ASC
         LIMIT 10`
    );

    const [flagRows] = await db.query(
        `SELECT
            SUM(CASE WHEN status <> 'Cancelled' AND expiry_date >= CURDATE() THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status <> 'Cancelled'
                      AND expiry_date >= CURDATE()
                      AND DATEDIFF(expiry_date, CURDATE()) <= ? THEN 1 ELSE 0 END) AS expiring_soon,
            SUM(CASE WHEN status <> 'Cancelled' AND expiry_date < CURDATE() THEN 1 ELSE 0 END) AS expired,
            SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN auto_renew = 1 AND status <> 'Cancelled' THEN 1 ELSE 0 END) AS auto_renew,
            SUM(CASE WHEN status <> 'Cancelled'
                      AND notice_period_days IS NOT NULL
                      AND DATEDIFF(expiry_date, CURDATE()) <= notice_period_days
                      AND expiry_date >= CURDATE() THEN 1 ELSE 0 END) AS notice_due,
            COALESCE(SUM(contract_value), 0) AS total_value,
            COALESCE(SUM(CASE WHEN status <> 'Cancelled' AND expiry_date >= CURDATE()
                              THEN contract_value ELSE 0 END), 0) AS active_value
         FROM warranties`,
        [days]
    );

    // Register warranties the module has not been told about yet, so the figures
    // include coverage captured at asset registration (§6).
    const [derivedRows] = await db.query(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN a.warranty_end < CURDATE() THEN 1 ELSE 0 END) AS expired,
            SUM(CASE WHEN a.warranty_end >= CURDATE()
                      AND DATEDIFF(a.warranty_end, CURDATE()) <= ? THEN 1 ELSE 0 END) AS expiring_soon,
            SUM(CASE WHEN a.warranty_end >= CURDATE() THEN 1 ELSE 0 END) AS active
         ${ASSET_WARRANTY_FROM}
         WHERE ${ASSET_WARRANTY_SCOPE}
           AND NOT EXISTS (
               SELECT 1 FROM warranties w2
               WHERE w2.asset_id = a.id
                 AND w2.warranty_type = 'Asset Warranty'
                 AND w2.status <> 'Cancelled'
           )`,
        [days]
    );

    const flags = flagRows[0] || {};
    const derived = derivedRows[0] || {};

    return {
        total: totalRows[0] ? totalRows[0].total : 0,
        active: Number(flags.active || 0),
        expiringSoon: Number(flags.expiring_soon || 0),
        expired: Number(flags.expired || 0),
        cancelled: Number(flags.cancelled || 0),
        autoRenew: Number(flags.auto_renew || 0),
        noticeDue: Number(flags.notice_due || 0),
        totalValue: Number(flags.total_value || 0),
        activeValue: Number(flags.active_value || 0),
        expiringDays: days,
        derivedFromRegister: Number(derived.total || 0),
        derivedExpiringSoon: Number(derived.expiring_soon || 0),
        derivedExpired: Number(derived.expired || 0),
        derivedActive: Number(derived.active || 0),
        byStatus: statusRows,
        byType: typeRows,
        byProvider: providerRows
    };
}


module.exports = {
    WARRANTY_TABLE,
    WARRANTY_TABLE_DDL,
    WARRANTY_COLUMNS,
    WARRANTY_FROM,
    WARRANTY_JOIN_COLUMNS,
    WARRANTY_SELECT,
    ASSET_WARRANTY_COLUMNS,
    ASSET_WARRANTY_FROM,
    ASSET_WARRANTY_SCOPE,
    WRITABLE_COLUMNS,

    // Bootstrap
    ensureTable,

    // Reads
    findById,
    findByRef,
    findByAssetId,
    findAll,
    findExpiring,
    findExpiringOnAssets,
    findExpired,
    findRecent,
    findContracts,
    findActive,

    // Writes
    create,
    update,
    setStatus,

    // Counters / summaries
    countByAssetId,
    resolveAssetPk,
    findMaxRefSuffix,
    warrantyRefExists,
    getStats
};
