'use strict';

// models/stockModel.js
// All database access for ICT Stock / Store (§5.7): the `stock_items` catalogue
// and the append-only `stock_movements` ledger.
// Controllers must never build SQL themselves - every query lives here so
// column/table names stay in one place.
//
// Design notes
//   * §5.7 asks to "track assets held in ICT stores or spare stock" and to
//     "record receipt, issue and return of stock". The asset register already
//     answers the first half: an asset sitting in stores is simply a row whose
//     `status` is 'In Stock' (§6 lifecycle). Duplicating that into a second
//     table would let the two disagree, so BALANCES ARE DERIVED from `assets`
//     and the register remains the single source of truth for what is on hand.
//   * What the register cannot express is the store's own catalogue data -
//     which store and bin an item lives in, minimum/maximum reorder levels, the
//     unit of measure and unit cost, and a separate internal part code. Those
//     live in `stock_items`, one row per asset (UNIQUE asset_id) plus optional
//     rows for consumable lines that have no serialised asset behind them.
//   * Every receipt, issue, return or write-off is appended to
//     `stock_movements` with the signed quantity and the resulting balance, so
//     §5.7's "movement history" is a plain ordered read rather than a
//     reconstruction. Rows are never updated or deleted; a mistake is corrected
//     by appending a compensating 'Adjustment', which keeps the ledger
//     tamper-evident for audit (§11).
//   * Register-derived items are reported with a synthetic id of
//     `asset-<assetId>` and `source: 'asset_register'`, matching the warranty
//     module's convention, so nothing captured at asset registration is hidden.
//

/**
 * DDL for the `stock_items` catalogue.
 *
 * `asset_id` is UNIQUE with ON DELETE CASCADE: a serialised spare has exactly
 * one store card, and deleting a throwaway asset cannot leave an orphaned card.
 * It is nullable because a consumable line (thermal paste, patch leads) is
 * tracked as a quantity and may never exist as an individual asset.
 */
const STOCK_ITEM_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS stock_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_ref VARCHAR(50) UNIQUE,                   -- STK-000001, printed on the store card
        asset_id INT NULL UNIQUE,                      -- FK to assets.id (NULL for consumables)

        -- Catalogue details.
        item_name VARCHAR(150) NOT NULL,               -- what the store calls it
        part_code VARCHAR(100),                        -- supplier's own code
        category VARCHAR(100),                         -- Hardware / Consumables / Spares ...
        unit_of_measure VARCHAR(30) DEFAULT 'Unit',    -- Unit, Metre, Box, Licence ...

        -- Where it is held.
        store_location VARCHAR(100),                   -- e.g. 'ICT Store - Head Office'
        bin_location VARCHAR(50),                      -- shelf / bin reference
        department VARCHAR(100),                       -- owning department

        -- Reorder control (§5.7 stock balances).
        quantity_on_hand INT NOT NULL DEFAULT 0,       -- used for consumables
        minimum_level INT DEFAULT 0,                   -- reorder threshold
        maximum_level INT,                             -- target after replenishment

        unit_cost DECIMAL(15, 2) DEFAULT 0.00,
        currency VARCHAR(10) DEFAULT 'USD',
        supplier VARCHAR(150),
        supplier_contact VARCHAR(100),

        status ENUM('Active', 'Inactive', 'Discontinued') DEFAULT 'Active',
        remarks TEXT,

        created_by INT,                                -- FK to users.id
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_stock_item_asset (asset_id),
        INDEX idx_stock_item_store (store_location),
        INDEX idx_stock_item_status (status),
        INDEX idx_stock_item_category (category)
    )
`;

/**
 * DDL for the append-only movement ledger.
 *
 * `quantity` is signed (positive into the store, negative out of it) so a
 * stock balance is a simple SUM and the direction of a row is never ambiguous.
 * `balance_after` snapshots the running balance at the time of the movement so
 * a historical statement can be printed without re-summing the ledger.
 *
 * The referenced columns are `ON DELETE SET NULL` rather than CASCADE: a
 * movement is a permanent record of what happened, so losing the asset or the
 * assignment it referred to must not erase the history.
 */
const STOCK_MOVEMENT_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS stock_movements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        movement_ref VARCHAR(50) UNIQUE,               -- MOV-000001
        stock_item_id INT NULL,                        -- FK to stock_items.id
        asset_id INT NULL,                             -- FK to assets.id

        movement_type ENUM('Receipt', 'Issue', 'Return', 'Adjustment',
                           'Transfer', 'Write Off', 'Stock Take')
            NOT NULL DEFAULT 'Receipt',
        quantity INT NOT NULL,                         -- signed: +in / -out
        balance_after INT,                             -- running balance

        movement_date DATE NOT NULL,
        reference VARCHAR(100),                        -- supplier invoice / issue slip no.
        reason VARCHAR(255),

        -- Who the stock came from or went to.
        counterparty VARCHAR(150),                     -- supplier, or receiving person
        to_user_id INT,                                -- FK to users.id (issuing to a custodian)
        to_user_name VARCHAR(100),
        to_department VARCHAR(100),
        to_location VARCHAR(100),

        assignment_id INT,                             -- FK to asset_assignments.id, when issued
        transfer_id INT,                               -- FK to transfers.id, when moved

        condition_status ENUM('Good', 'Fair', 'Damaged', 'Obsolete'),  -- condition on return
        unit_cost DECIMAL(15, 2) DEFAULT 0.00,         -- cost captured at the time of movement
        total_cost DECIMAL(15, 2) DEFAULT 0.00,        -- quantity * unit_cost

        remarks TEXT,
        recorded_by INT,                               -- FK to users.id (officer recording it)
        approved_by INT,                               -- FK to users.id (authorising officer)

        reversed_by INT,                               -- FK to stock_movements.id (compensating row)
        reversed_movement_id INT,                      -- FK to stock_movements.id (what this reverses)

        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE SET NULL,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
        FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (recorded_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_movement_item (stock_item_id),
        INDEX idx_movement_asset (asset_id),
        INDEX idx_movement_type (movement_type),
        INDEX idx_movement_date (movement_date),
        INDEX idx_movement_ref (movement_ref)
    )
`;

const db = require('../config/db');

/* ========================================================================== */
/* Column lists & FROM fragments                                              */
/* ========================================================================== */

// Column list used for every client-facing stock-item SELECT so the API shape
// never drifts.
const STOCK_ITEM_COLUMNS = `
    si.id,
    si.item_ref,
    si.asset_id,
    si.item_name,
    si.part_code,
    si.category,
    si.unit_of_measure,
    si.store_location,
    si.bin_location,
    si.department,
    si.quantity_on_hand,
    si.minimum_level,
    si.maximum_level,
    si.unit_cost,
    si.currency,
    si.supplier,
    si.supplier_contact,
    si.status,
    si.remarks,
    si.created_by,
    si.created_at,
    si.updated_at
`;

// The stock-item table plus its lookup joins, always applied together.
const STOCK_ITEM_FROM = `
    FROM stock_items si
    LEFT JOIN assets a ON a.id = si.asset_id
    LEFT JOIN asset_categories c ON c.id = a.category_id
    LEFT JOIN users cb ON cb.id = si.created_by
`;

// Joined helper columns describing the serialised asset behind a store card.
const STOCK_ITEM_JOIN_COLUMNS = `
    a.asset_id AS asset_code,
    a.asset_tag AS asset_tag,
    a.serial_number AS serial_number,
    a.manufacturer AS manufacturer,
    a.model AS model,
    a.status AS asset_status,
    a.condition_status AS asset_condition,
    a.location AS asset_location,
    a.department AS asset_department,
    c.name AS category_name,
    cb.full_name AS created_by_name,
    cb.username AS created_by_username,
    GREATEST(si.quantity_on_hand - COALESCE(si.minimum_level, 0), 0) AS quantity_above_minimum
`;

// The CASE expression that derives a store card's state. Kept separate because
// it is reused by the single-record read and the list.
const STOCK_STATE_SQL = `
    CASE
        WHEN si.status <> 'Active' THEN si.status
        WHEN COALESCE(si.minimum_level, 0) > 0 AND si.quantity_on_hand <= si.minimum_level THEN 'Low Stock'
        WHEN COALESCE(si.maximum_level, 0) > 0 AND si.quantity_on_hand > si.maximum_level THEN 'Overstocked'
        ELSE 'In Stock'
    END
`;

// The movement roll-up, aggregated once per read rather than re-queried.
const MOVEMENT_ROLLUP_JOIN = `
    LEFT JOIN (
        SELECT stock_item_id,
               COUNT(*) AS movement_count,
               MAX(movement_date) AS last_movement_date,
               SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) AS quantity_received,
               SUM(CASE WHEN quantity < 0 THEN -quantity ELSE 0 END) AS quantity_issued
        FROM stock_movements
        GROUP BY stock_item_id
    ) mv ON mv.stock_item_id = si.id
`;

// The select used by every single-record read so the shape is identical whether
// the row came from a list, a create or an update.
const STOCK_ITEM_SELECT = `
    SELECT
        ${STOCK_ITEM_COLUMNS},
        ${STOCK_ITEM_JOIN_COLUMNS},
        COALESCE(mv.movement_count, 0) AS movement_count,
        mv.last_movement_date,
        COALESCE(mv.quantity_received, 0) AS quantity_received,
        COALESCE(mv.quantity_issued, 0) AS quantity_issued,
        ${STOCK_STATE_SQL} AS stock_state
    ${STOCK_ITEM_FROM}
    ${MOVEMENT_ROLLUP_JOIN}
`;

// Column list used for every client-facing movement SELECT.
const MOVEMENT_COLUMNS = `
    sm.id,
    sm.movement_ref,
    sm.stock_item_id,
    sm.asset_id,
    sm.movement_type,
    sm.quantity,
    sm.balance_after,
    sm.movement_date,
    sm.reference,
    sm.reason,
    sm.counterparty,
    sm.to_user_id,
    sm.to_user_name,
    sm.to_department,
    sm.to_location,
    sm.assignment_id,
    sm.transfer_id,
    sm.condition_status,
    sm.unit_cost,
    sm.total_cost,
    sm.remarks,
    sm.recorded_by,
    sm.approved_by,
    sm.reversed_by,
    sm.reversed_movement_id,
    sm.created_at
`;

const MOVEMENT_FROM = `
    FROM stock_movements sm
    LEFT JOIN stock_items si ON si.id = sm.stock_item_id
    LEFT JOIN assets a ON a.id = sm.asset_id
    LEFT JOIN users ru ON ru.id = sm.recorded_by
    LEFT JOIN users au ON au.id = sm.approved_by
`;

const MOVEMENT_JOIN_COLUMNS = `
    si.item_ref AS item_ref,
    si.item_name AS item_name,
    si.unit_of_measure AS unit_of_measure,
    si.store_location AS store_location,
    si.bin_location AS bin_location,
    a.asset_id AS asset_code,
    a.asset_tag AS asset_tag,
    a.serial_number AS serial_number,
    ru.full_name AS recorded_by_name,
    ru.username AS recorded_by_username,
    au.full_name AS approved_by_name,
    au.username AS approved_by_username
`;

const MOVEMENT_SELECT = `
    SELECT
        ${MOVEMENT_COLUMNS},
        ${MOVEMENT_JOIN_COLUMNS}
    ${MOVEMENT_FROM}
`;

// The register owns the record of what is physically in stores (§5.7). Only
// assets the store module has not been told about yet are reported from here,
// so an item never appears twice.
const ASSET_STOCK_FROM = `
    FROM assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
`;

// What "held in stores" means for the register: the §6 lifecycle status, and
// never a disposed asset.
const ASSET_STOCK_SCOPE = "a.status = 'In Stock'";

// Table names as they appear in audit_logs.table_name.
const STOCK_ITEM_TABLE = 'stock_items';
const STOCK_MOVEMENT_TABLE = 'stock_movements';

/* ========================================================================== */
/* Bootstrap                                                                  */
/* ========================================================================== */

/**
 * Creates the stock tables when they do not exist yet.
 *
 * Called by the module bootstrap and by the test suite so a fresh checkout can
 * exercise stock endpoints without re-running `scripts/initDb.js`.
 *
 * @returns {Promise<void>}
 */
async function ensureTable() {
    await db.query(STOCK_ITEM_TABLE_DDL);
    await db.query(STOCK_MOVEMENT_TABLE_DDL);
}

/* ========================================================================== */
/* Reads - store cards                                                        */
/* ========================================================================== */

/**
 * Fetches one store card by primary key, with its joined context.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
async function findById(id) {
    const [rows] = await db.query(`${STOCK_ITEM_SELECT} WHERE si.id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

/**
 * Fetches one store card by its human reference (STK-000001).
 *
 * @param {string} ref
 * @returns {Promise<object|null>}
 */
async function findByRef(ref) {
    const [rows] = await db.query(`${STOCK_ITEM_SELECT} WHERE si.item_ref = ? LIMIT 1`, [ref]);
    return rows[0] || null;
}

/**
 * The store card for a serialised asset, if one exists.
 *
 * @param {number|string} assetId Numeric assets.id primary key.
 * @returns {Promise<object|null>}
 */
async function findByAssetId(assetId) {
    const [rows] = await db.query(`${STOCK_ITEM_SELECT} WHERE si.asset_id = ? LIMIT 1`, [assetId]);
    return rows[0] || null;
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
 * The store card for an asset identified by any of its public identifiers.
 *
 * @param {string|number} key Numeric id, asset code (NBSZ-ICT-000001) or tag.
 * @returns {Promise<object|null>}
 */
async function findByAssetKey(key) {
    const pk = await resolveAssetPk(key);
    return pk === null ? null : findByAssetId(pk);
}

/**
 * Exact-match probe for an item reference, used to guarantee uniqueness.
 *
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
async function itemRefExists(ref) {
    const [rows] = await db.query(
        'SELECT id FROM stock_items WHERE item_ref = ? LIMIT 1',
        [ref]
    );
    return rows.length > 0;
}

/**
 * Highest numeric suffix currently used for a reference prefix, so the next
 * reference can be minted (STK-000001 / MOV-000001).
 *
 * @param {string} table Either stock_items or stock_movements.
 * @param {string} column The reference column on that table.
 * @param {string} prefix
 * @returns {Promise<number>}
 */
async function findMaxRefSuffix(table, column, prefix) {
    // The table and column are chosen from a fixed internal list, never from
    // user input, so the interpolation here cannot be influenced by a caller.
    const allowed = [
        { table: 'stock_items', column: 'item_ref' },
        { table: 'stock_movements', column: 'movement_ref' }
    ];
    const match = allowed.find((entry) => entry.table === table && entry.column === column);
    if (!match) throw new Error('findMaxRefSuffix: unsupported table/column pair.');

    const [rows] = await db.query(
        `SELECT MAX(CAST(SUBSTRING(${match.column}, ?) AS UNSIGNED)) AS max_suffix
         FROM ${match.table}
         WHERE ${match.column} LIKE ?`,
        [String(prefix).length + 1, `${prefix}%`]
    );
    const value = rows[0] ? rows[0].max_suffix : null;
    return value === null || value === undefined ? 0 : Number(value);
}

/**
 * Builds the shared WHERE clause for the stored stock items.
 *
 * Every filter is optional; only the supplied ones are added. `lowStockOnly`
 * turns this into the §5.7 replenishment query.
 *
 * @param {object} [options]
 * @param {string} [options.search] Free-text match on reference, item name, part
 *        code, store/bin and the linked asset's identifiers.
 * @param {string} [options.status] Exact ENUM match on si.status.
 * @param {string} [options.category] Partial match.
 * @param {string} [options.storeLocation] Partial match on the store.
 * @param {boolean} [options.lowStockOnly] Only rows at or below minimum level.
 * @param {number|string} [options.assetId] Numeric assets.id primary key.
 * @param {number[]} [options.assetIds] Restrict to these assets.id values.
 * @returns {{where: string[], params: *[]}}
 */
function buildItemWhere({
    search,
    status,
    category,
    storeLocation,
    lowStockOnly,
    assetId,
    assetIds
} = {}) {
    const where = [];
    const params = [];

    if (status) {
        where.push('si.status = ?');
        params.push(status);
    }

    if (category) {
        where.push('si.category LIKE ?');
        params.push(`%${category}%`);
    }

    if (storeLocation) {
        where.push('si.store_location LIKE ?');
        params.push(`%${storeLocation}%`);
    }

    if (lowStockOnly) {
        where.push(
            "si.status = 'Active' AND COALESCE(si.minimum_level, 0) > 0 AND si.quantity_on_hand <= si.minimum_level"
        );
    }

    if (assetId !== undefined && assetId !== null && assetId !== '') {
        where.push('si.asset_id = ?');
        params.push(assetId);
    } else if (Array.isArray(assetIds)) {
        // A scoped caller (a Departmental User) may only see their own store
        // items. An empty list must match nothing rather than everything.
        if (!assetIds.length) {
            where.push('1 = 0');
        } else {
            where.push(`si.asset_id IN (${assetIds.map(() => '?').join(', ')})`);
            params.push(...assetIds);
        }
    }

    if (search) {
        const like = `%${search}%`;
        where.push(
            `(si.item_ref LIKE ?
              OR si.item_name LIKE ?
              OR si.part_code LIKE ?
              OR si.category LIKE ?
              OR si.store_location LIKE ?
              OR si.bin_location LIKE ?
              OR si.supplier LIKE ?
              OR a.asset_tag LIKE ?
              OR a.asset_id LIKE ?
              OR a.serial_number LIKE ?)`
        );
        params.push(like, like, like, like, like, like, like, like, like, like);
    }

    return { where, params };
}

/**
 * Builds the WHERE clause for the register-derived store items. Column names
 * differ from the stored table (`a.` prefix) so the textual filters are
 * translated here.
 *
 * @param {object} options Mirror of buildItemWhere.
 * @returns {{where: string[], params: *[]}}
 */
function buildDerivedWhere({
    search,
    status,
    category,
    storeLocation,
    lowStockOnly,
    assetId,
    assetIds
} = {}) {
    const where = [];
    const params = [];

    // A register asset has no store-catalogue status of its own. Anything other
    // than the default 'Active' view therefore excludes it, and a replenishment
    // request has no meaning for a serialised asset.
    if (status && status !== 'Active') where.push('1 = 0');
    if (lowStockOnly) where.push('1 = 0');

    if (category) {
        where.push('c.name LIKE ?');
        params.push(`%${category}%`);
    }

    if (storeLocation) {
        where.push('a.location LIKE ?');
        params.push(`%${storeLocation}%`);
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

    if (search) {
        const like = `%${search}%`;
        where.push(
            `(a.asset_tag LIKE ?
              OR a.asset_id LIKE ?
              OR a.serial_number LIKE ?
              OR a.manufacturer LIKE ?
              OR a.model LIKE ?
              OR a.location LIKE ?
              OR c.name LIKE ?)`
        );
        params.push(like, like, like, like, like, like, like);
    }

    return { where, params };
}

/**
 * Lists stock items with optional search / filter / sort and pagination.
 *
 * Two sources are merged so the store shows the whole picture:
 *   1. rows explicitly recorded in `stock_items` (the store catalogue), and
 *   2. assets the register reports as 'In Stock' that have no store card yet -
 *      reported with a synthetic id of `asset-<assetId>` and
 *      `source: 'asset_register'`.
 *
 * The merge is done in SQL with UNION ALL so pagination and totals stay correct
 * rather than being approximated in JavaScript.
 *
 * @param {object} [options] See buildItemWhere plus the paging / sort keys.
 * @param {boolean} [options.includeDerived=true] Include register-derived rows.
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @param {string} [options.sort='item_ref'] Whitelisted column.
 * @param {string} [options.order='asc'] 'asc' or 'desc'.
 * @returns {Promise<{rows: object[], total: number, derived: number}>}
 */
async function findAll({
    search,
    status,
    category,
    storeLocation,
    lowStockOnly,
    assetId,
    assetIds,
    includeDerived = true,
    limit = 50,
    offset = 0,
    sort = 'item_ref',
    order = 'asc'
} = {}) {
    const { where, params } = buildItemWhere({
        search,
        status,
        category,
        storeLocation,
        lowStockOnly,
        assetId,
        assetIds
    });

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Whitelist the sortable columns - never interpolate raw user input.
    const sortable = {
        item_ref: 'item_ref',
        item_name: 'item_name',
        category: 'category',
        store_location: 'store_location',
        quantity_on_hand: 'quantity_on_hand',
        minimum_level: 'minimum_level',
        unit_cost: 'unit_cost',
        status: 'status',
        created_at: 'created_at',
        stock_state: 'stock_state'
    };
    const sortColumn = sortable[sort] || sortable.item_ref;
    const sortOrder = String(order).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const storedSql = `
        SELECT
            CAST(si.id AS CHAR) AS id,
            si.item_ref,
            si.asset_id,
            si.item_name,
            si.part_code,
            si.category,
            si.unit_of_measure,
            si.store_location,
            si.bin_location,
            si.department,
            si.quantity_on_hand,
            si.minimum_level,
            si.maximum_level,
            si.unit_cost,
            si.currency,
            si.supplier,
            si.supplier_contact,
            si.status,
            si.remarks,
            si.created_by,
            si.created_at,
            si.updated_at,
            'stored' AS source,
            ${STOCK_ITEM_JOIN_COLUMNS},
            COALESCE(mv.movement_count, 0) AS movement_count,
            mv.last_movement_date,
            COALESCE(mv.quantity_received, 0) AS quantity_received,
            COALESCE(mv.quantity_issued, 0) AS quantity_issued,
            ${STOCK_STATE_SQL} AS stock_state
        ${STOCK_ITEM_FROM}
        ${MOVEMENT_ROLLUP_JOIN}
        ${whereSql}
    `;

    if (!includeDerived) {
        const [countRows] = await db.query(
            `SELECT COUNT(*) AS total ${STOCK_ITEM_FROM} ${whereSql}`,
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
        category,
        storeLocation,
        lowStockOnly,
        assetId,
        assetIds
    });

    const derivedSql = `
        SELECT
            CONCAT('asset-', a.id) AS id,
            NULL AS item_ref,
            a.id AS asset_id,
            TRIM(CONCAT(COALESCE(a.manufacturer, ''), ' ', COALESCE(a.model, ''))) AS item_name,
            NULL AS part_code,
            COALESCE(c.name, 'Uncategorised') AS category,
            'Unit' AS unit_of_measure,
            a.location AS store_location,
            NULL AS bin_location,
            a.department AS department,
            1 AS quantity_on_hand,
            0 AS minimum_level,
            NULL AS maximum_level,
            COALESCE(a.purchase_cost, 0) AS unit_cost,
            'USD' AS currency,
            a.supplier AS supplier,
            NULL AS supplier_contact,
            'Active' AS status,
            NULL AS remarks,
            NULL AS created_by,
            a.date_registered AS created_at,
            a.date_registered AS updated_at,
            'asset_register' AS source,
            a.asset_id AS asset_code,
            a.asset_tag AS asset_tag,
            a.serial_number AS serial_number,
            a.manufacturer AS manufacturer,
            a.model AS model,
            a.status AS asset_status,
            a.condition_status AS asset_condition,
            a.location AS asset_location,
            a.department AS asset_department,
            c.name AS category_name,
            NULL AS created_by_name,
            NULL AS created_by_username,
            1 AS quantity_above_minimum,
            0 AS movement_count,
            NULL AS last_movement_date,
            0 AS quantity_received,
            0 AS quantity_issued,
            'In Stock' AS stock_state
        ${ASSET_STOCK_FROM}
        WHERE ${ASSET_STOCK_SCOPE}
          ${derived.where.length ? `AND ${derived.where.join(' AND ')}` : ''}
          AND NOT EXISTS (
              SELECT 1 FROM stock_items si2 WHERE si2.asset_id = a.id
          )
    `;

    const combined = `
        SELECT * FROM (
            ${storedSql}
            UNION ALL
            ${derivedSql}
        ) AS stock
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

    const [derivedCountRows] = await db.query(
        `SELECT COUNT(*) AS total FROM (${derivedSql}) AS derived_counted`,
        derived.params
    );

    return {
        rows,
        total: countRows[0] ? countRows[0].total : 0,
        derived: derivedCountRows[0] ? derivedCountRows[0].total : 0
    };
}

/* ========================================================================== */
/* Reads - balances & movements                                               */
/* ========================================================================== */

/**
 * §5.7 "stock balances": what is on hand right now, grouped the three ways the
 * store actually reports on it - by store, by category and by state.
 *
 * @returns {Promise<object>}
 */
async function getBalances() {
    const [totalsRows] = await db.query(
        `SELECT
            COUNT(*) AS line_items,
            COALESCE(SUM(si.quantity_on_hand), 0) AS units_on_hand,
            COALESCE(SUM(si.quantity_on_hand * si.unit_cost), 0) AS stock_value,
            SUM(CASE WHEN si.status = 'Active' THEN 1 ELSE 0 END) AS active_items,
            SUM(CASE WHEN si.status = 'Inactive' THEN 1 ELSE 0 END) AS inactive_items,
            SUM(CASE WHEN si.status = 'Discontinued' THEN 1 ELSE 0 END) AS discontinued_items,
            SUM(CASE WHEN si.status = 'Active'
                      AND COALESCE(si.minimum_level, 0) > 0
                      AND si.quantity_on_hand <= si.minimum_level THEN 1 ELSE 0 END) AS low_stock_items,
            SUM(CASE WHEN si.asset_id IS NOT NULL THEN 1 ELSE 0 END) AS serialised_items,
            SUM(CASE WHEN si.asset_id IS NULL THEN 1 ELSE 0 END) AS consumable_items,
            SUM(CASE WHEN si.minimum_level IS NOT NULL THEN 1 ELSE 0 END) AS reorder_controlled
         FROM stock_items si`
    );

    const [byStore] = await db.query(
        `SELECT si.store_location, COUNT(*) AS total, COALESCE(SUM(si.quantity_on_hand), 0) AS units,
                COALESCE(SUM(si.quantity_on_hand * si.unit_cost), 0) AS value
         FROM stock_items si
         GROUP BY si.store_location
         ORDER BY si.store_location ASC`
    );

    const [byCategory] = await db.query(
        `SELECT si.category, COUNT(*) AS total, COALESCE(SUM(si.quantity_on_hand), 0) AS units,
                COALESCE(SUM(si.quantity_on_hand * si.unit_cost), 0) AS value
         FROM stock_items si
         GROUP BY si.category
         ORDER BY si.category ASC`
    );

    const [byState] = await db.query(
        `SELECT
            ${STOCK_STATE_SQL} AS stock_state,
            COUNT(*) AS total,
            COALESCE(SUM(si.quantity_on_hand), 0) AS units
         FROM stock_items si
         GROUP BY stock_state
         ORDER BY stock_state ASC`
    );

    // The register's own holding, so the balance sheet covers spare assets the
    // store module has not catalogued yet.
    const [derivedRows] = await db.query(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(COALESCE(a.purchase_cost, 0)), 0) AS value
         ${ASSET_STOCK_FROM}
         WHERE ${ASSET_STOCK_SCOPE}
           AND NOT EXISTS (SELECT 1 FROM stock_items si2 WHERE si2.asset_id = a.id)`
    );

    const totals = totalsRows[0] || {};
    const derived = derivedRows[0] || {};

    return {
        lineItems: Number(totals.line_items || 0),
        unitsOnHand: Number(totals.units_on_hand || 0),
        stockValue: Number(totals.stock_value || 0),
        activeItems: Number(totals.active_items || 0),
        inactiveItems: Number(totals.inactive_items || 0),
        discontinuedItems: Number(totals.discontinued_items || 0),
        lowStockItems: Number(totals.low_stock_items || 0),
        serialisedItems: Number(totals.serialised_items || 0),
        consumableItems: Number(totals.consumable_items || 0),
        reorderControlled: Number(totals.reorder_controlled || 0),
        derivedFromRegister: Number(derived.total || 0),
        derivedValue: Number(derived.value || 0),
        byStore,
        byCategory,
        byState
    };
}

/**
 * Store cards at or below their minimum level - the §5.7 replenishment list.
 *
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
async function findLowStock(limit = 100, assetIds) {
    const where = [
        "si.status = 'Active'",
        'COALESCE(si.minimum_level, 0) > 0',
        'si.quantity_on_hand <= si.minimum_level'
    ];
    const params = [];
    if (Array.isArray(assetIds)) {
        if (assetIds.length === 0) {
            where.push('1 = 0');
        } else {
            where.push(`si.asset_id IN (${assetIds.map(() => '?').join(', ')})`);
            params.push(...assetIds);
        }
    }
    const [rows] = await db.query(
        `${STOCK_ITEM_SELECT}
         WHERE ${where.join(' AND ')}
         ORDER BY (si.quantity_on_hand - si.minimum_level) ASC, si.item_name ASC
         LIMIT ?`,
        [...params, Math.max(1, Math.min(Number(limit) || 100, 200))]
    );
    return rows;
}

/**
 * The most recently recorded movements, for the dashboard panel.
 *
 * @param {number} [limit=10]
 * @returns {Promise<object[]>}
 */
async function findRecentMovements(limit = 10) {
    const [rows] = await db.query(
        `${MOVEMENT_SELECT}
         ORDER BY sm.created_at DESC, sm.id DESC
         LIMIT ?`,
        [Math.max(1, Math.min(Number(limit) || 10, 100))]
    );
    return rows;
}

/**
 * §5.7 "movement history": the ledger, optionally narrowed by item, asset, type
 * or date range.
 *
 * @param {object} [options]
 * @param {number|string} [options.stockItemId]
 * @param {number|string} [options.assetId]
 * @param {string} [options.movementType] Exact ENUM match.
 * @param {string} [options.dateFrom] movement_date >= this YYYY-MM-DD.
 * @param {string} [options.dateTo] movement_date <= this YYYY-MM-DD.
 * @param {string} [options.search] Free-text match on reference, reason, party
 *        and the item/asset identifiers.
 * @param {number} [options.limit=100]
 * @param {number} [options.offset=0]
 * @param {string} [options.order='desc'] 'asc' or 'desc' by movement date.
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function findMovements({
    stockItemId,
    assetId,
    assetIds,
    movementType,
    dateFrom,
    dateTo,
    search,
    limit = 100,
    offset = 0,
    order = 'desc'
} = {}) {
    const where = [];
    const params = [];

    if (stockItemId !== undefined && stockItemId !== null && stockItemId !== '') {
        where.push('sm.stock_item_id = ?');
        params.push(stockItemId);
    }

    if (assetId !== undefined && assetId !== null && assetId !== '') {
        where.push('sm.asset_id = ?');
        params.push(assetId);
    }
    if (Array.isArray(assetIds)) {
        if (assetIds.length === 0) {
            where.push('1 = 0');
        } else {
            where.push(`sm.asset_id IN (${assetIds.map(() => '?').join(', ')})`);
            params.push(...assetIds);
        }
    }

    if (movementType) {
        where.push('sm.movement_type = ?');
        params.push(movementType);
    }

    if (dateFrom) {
        where.push('sm.movement_date >= ?');
        params.push(dateFrom);
    }

    if (dateTo) {
        where.push('sm.movement_date <= ?');
        params.push(dateTo);
    }

    if (search) {
        const like = `%${search}%`;
        where.push(
            `(sm.movement_ref LIKE ?
              OR sm.reference LIKE ?
              OR sm.reason LIKE ?
              OR sm.counterparty LIKE ?
              OR sm.to_user_name LIKE ?
              OR si.item_ref LIKE ?
              OR si.item_name LIKE ?
              OR a.asset_tag LIKE ?
              OR a.asset_id LIKE ?)`
        );
        params.push(like, like, like, like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const direction = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
    const safeOffset = Math.max(0, Number(offset) || 0);

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total ${MOVEMENT_FROM} ${whereSql}`,
        params
    );

    const [rows] = await db.query(
        `${MOVEMENT_SELECT}
         ${whereSql}
         ORDER BY sm.movement_date ${direction}, sm.id ${direction}
         LIMIT ? OFFSET ?`,
        [...params, safeLimit, safeOffset]
    );

    return { rows, total: countRows[0] ? countRows[0].total : 0 };
}

/**
 * Fetches one movement by primary key, with its joined context.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
async function findMovementById(id) {
    const [rows] = await db.query(`${MOVEMENT_SELECT} WHERE sm.id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

/**
 * The movement history of a single store card, newest first.
 *
 * @param {number|string} stockItemId
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
async function findMovementsByItem(stockItemId, limit = 100) {
    const { rows } = await findMovements({
        stockItemId,
        limit,
        order: 'desc'
    });
    return rows;
}

/**
 * The movement history of a single asset, newest first, regardless of whether
 * it has a store card yet.
 *
 * @param {number|string} assetId Numeric assets.id primary key.
 * @param {number} [limit=100]
 * @returns {Promise<object[]>}
 */
async function findMovementsByAsset(assetId, limit = 100) {
    const { rows } = await findMovements({
        assetId,
        limit,
        order: 'desc'
    });
    return rows;
}

/**
 * How many movements have already been recorded against a store card, used to
 * decide whether a card can still be removed outright.
 *
 * @param {number|string} stockItemId
 * @returns {Promise<number>}
 */
async function countMovementsByItem(stockItemId) {
    const [rows] = await db.query(
        'SELECT COUNT(*) AS total FROM stock_movements WHERE stock_item_id = ?',
        [stockItemId]
    );
    return rows[0] ? Number(rows[0].total) : 0;
}

/* ========================================================================== */
/* Writes - store cards                                                       */
/* ========================================================================== */

// Columns a caller may write, kept in one place so `create` and `update` cannot
// drift apart. `quantity_on_hand` is deliberately absent: a balance only ever
// moves through a ledger entry so the two can never disagree.
const WRITABLE_COLUMNS = [
    'item_ref',
    'asset_id',
    'item_name',
    'part_code',
    'category',
    'unit_of_measure',
    'store_location',
    'bin_location',
    'department',
    'minimum_level',
    'maximum_level',
    'unit_cost',
    'currency',
    'supplier',
    'supplier_contact',
    'status',
    'remarks',
    'created_by'
];

// Columns stored as booleans so the driver receives 0/1 rather than a JS value
// MySQL may reject.
const BOOLEAN_COLUMNS = [];

// Columns a caller may write on a movement row.
const MOVEMENT_WRITABLE_COLUMNS = [
    'movement_ref',
    'stock_item_id',
    'asset_id',
    'movement_type',
    'quantity',
    'balance_after',
    'movement_date',
    'reference',
    'reason',
    'counterparty',
    'to_user_id',
    'to_user_name',
    'to_department',
    'to_location',
    'assignment_id',
    'transfer_id',
    'condition_status',
    'unit_cost',
    'total_cost',
    'remarks',
    'recorded_by',
    'approved_by',
    'reversed_by',
    'reversed_movement_id'
];

/**
 * Inserts a store card.
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

    // The opening quantity is the only place `quantity_on_hand` is set outside a
    // movement, so it is written explicitly here rather than via the whitelist.
    if (Object.prototype.hasOwnProperty.call(data, 'quantity_on_hand')) {
        columns.push('quantity_on_hand');
        placeholders.push('?');
        params.push(Number(data.quantity_on_hand) || 0);
    }

    const [result] = await db.query(
        `INSERT INTO stock_items (${columns.join(', ')})
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
        `UPDATE stock_items SET ${sets.join(', ')} WHERE id = ?`,
        params
    );

    return result.affectedRows;
}

/**
 * Removes a store card. Only ever called by the test/setup path - the API keeps
 * cards and deactivates them instead, because a card carries history.
 *
 * @param {number|string} id
 * @returns {Promise<number>} Number of rows removed.
 */
async function remove(id) {
    const [result] = await db.query('DELETE FROM stock_items WHERE id = ?', [id]);
    return result.affectedRows;
}

/* ========================================================================== */
/* Writes - the movement ledger                                               */
/* ========================================================================== */

/**
 * Records a stock movement and updates the affected store card's balance in a
 * single transaction.
 *
 * §5.7 requires receipt, issue and return to be recorded, and §11 requires every
 * material change to be auditable and consistent. Hence:
 *   * the ledger row and the balance update commit together or not at all, so a
 *     crash can never leave the two disagreeing;
 *   * `balance_after` is computed inside the transaction from the locked row;
 *   * the movement is never a delete - a correction is a compensating row.
 *
 * A movement with no `stock_item_id` is allowed (a register asset may be issued
 * from stores before it has a store card), in which case only the ledger row is
 * written and the balance is reported as null.
 *
 * @param {object} data Column values keyed by their DB names. `quantity` is
 *        signed and is required.
 * @returns {Promise<{id: number, balance: number|null, movement_ref: string}>}
 */
async function recordMovement(data) {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        let balanceAfter = null;

        if (data.stock_item_id !== undefined && data.stock_item_id !== null && data.stock_item_id !== '') {
            // SELECT ... FOR UPDATE serialises concurrent movements on the same
            // card so two issue slips cannot both read the same opening balance.
            const [itemRows] = await connection.query(
                'SELECT id, quantity_on_hand FROM stock_items WHERE id = ? FOR UPDATE',
                [data.stock_item_id]
            );

            if (!itemRows.length) {
                const error = new Error('The stock item no longer exists.');
                error.status = 404;
                throw error;
            }

            balanceAfter = (Number(itemRows[0].quantity_on_hand) || 0) + (Number(data.quantity) || 0);
            if (balanceAfter < 0) {
                const error = new Error('The stock balance cannot go negative.');
                error.status = 409;
                throw error;
            }
        }

        const columns = [];
        const placeholders = [];
        const params = [];

        const payload = { ...data, balance_after: balanceAfter };

        for (const key of MOVEMENT_WRITABLE_COLUMNS) {
            if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
            columns.push(key);
            placeholders.push('?');
            params.push(payload[key]);
        }

        const [result] = await connection.query(
            `INSERT INTO stock_movements (${columns.join(', ')})
             VALUES (${placeholders.join(', ')})`,
            params
        );

        if (balanceAfter !== null) {
            await connection.query(
                'UPDATE stock_items SET quantity_on_hand = ? WHERE id = ?',
                [balanceAfter, data.stock_item_id]
            );
        }

        await connection.commit();

        return {
            id: result.insertId,
            balance: balanceAfter,
            movement_ref: data.movement_ref || null
        };
    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            /* the connection is already unusable - the original error matters */
        }
        throw err;
    } finally {
        connection.release();
    }
}

/**
 * Reverses a recorded movement by appending a compensating entry rather than
 * editing or deleting the original, so the ledger stays tamper-evident.
 *
 * `reversed_by` on the original points at the compensating row and
 * `reversed_movement_id` on the compensating row points back, giving a complete
 * audit pair in both directions.
 *
 * @param {number|string} movementId The movement being reversed.
 * @param {object} reversal Column values for the compensating row (already
 *        validated by the controller).
 * @returns {Promise<{id: number, balance: number|null, original: object}>}
 */
async function reverseMovement(movementId, reversal = {}) {
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        const [originalRows] = await connection.query(
            'SELECT * FROM stock_movements WHERE id = ? FOR UPDATE',
            [movementId]
        );

        if (!originalRows.length) {
            const error = new Error('The movement to reverse no longer exists.');
            error.status = 404;
            throw error;
        }

        const original = originalRows[0];

        // The compensating row carries the opposite sign: issuing stock and then
        // cancelling the issue is a receipt back into the store.
        const signedQuantity = -Number(original.quantity || 0);
        const targetItemId = reversal.stock_item_id !== undefined
            ? reversal.stock_item_id
            : original.stock_item_id;

        let balanceAfter = null;

        if (targetItemId !== undefined && targetItemId !== null && targetItemId !== '') {
            const [itemRows] = await connection.query(
                'SELECT id, quantity_on_hand FROM stock_items WHERE id = ? FOR UPDATE',
                [targetItemId]
            );

            if (!itemRows.length) {
                const error = new Error('The stock item no longer exists.');
                error.status = 404;
                throw error;
            }

            balanceAfter = (Number(itemRows[0].quantity_on_hand) || 0) + signedQuantity;
        }

        const entry = {
            movement_ref: reversal.movement_ref || null,
            stock_item_id: targetItemId === '' ? null : targetItemId,
            asset_id: reversal.asset_id !== undefined ? reversal.asset_id : original.asset_id,
            movement_type: reversal.movement_type || 'Adjustment',
            quantity: signedQuantity,
            balance_after: balanceAfter,
            movement_date: reversal.movement_date,
            reference: reversal.reference !== undefined ? reversal.reference : original.movement_ref,
            reason: reversal.reason || `Reversal of ${original.movement_ref || `movement #${original.id}`}`,
            counterparty: reversal.counterparty !== undefined ? reversal.counterparty : original.counterparty,
            to_user_id: reversal.to_user_id !== undefined ? reversal.to_user_id : null,
            to_user_name: reversal.to_user_name !== undefined ? reversal.to_user_name : null,
            to_department: reversal.to_department !== undefined ? reversal.to_department : null,
            to_location: reversal.to_location !== undefined ? reversal.to_location : null,
            condition_status: reversal.condition_status !== undefined ? reversal.condition_status : null,
            unit_cost: reversal.unit_cost !== undefined ? reversal.unit_cost : original.unit_cost,
            total_cost: reversal.total_cost !== undefined ? reversal.total_cost : null,
            remarks: reversal.remarks !== undefined ? reversal.remarks : null,
            recorded_by: reversal.recorded_by || null,
            approved_by: reversal.approved_by || null,
            reversed_movement_id: original.id
        };

        const columns = [];
        const placeholders = [];
        const params = [];

        for (const key of MOVEMENT_WRITABLE_COLUMNS) {
            if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
            columns.push(key);
            placeholders.push('?');
            params.push(entry[key]);
        }

        const [result] = await connection.query(
            `INSERT INTO stock_movements (${columns.join(', ')})
             VALUES (${placeholders.join(', ')})`,
            params
        );

        // Stamp the original so a reader can see it has been superseded without
        // walking the whole ledger.
        await connection.query(
            'UPDATE stock_movements SET reversed_by = ? WHERE id = ?',
            [result.insertId, movementId]
        );

        if (balanceAfter !== null) {
            await connection.query(
                'UPDATE stock_items SET quantity_on_hand = ? WHERE id = ?',
                [balanceAfter, targetItemId]
            );
        }

        await connection.commit();

        return { id: result.insertId, balance: balanceAfter, original };
    } catch (err) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            /* the connection is already unusable - the original error matters */
        }
        throw err;
    } finally {
        connection.release();
    }
}

/* ========================================================================== */
/* Counters & summaries                                                       */
/* ========================================================================== */

/**
 * Aggregate stock figures for the dashboard and the stats endpoint (§12).
 *
 * `lowStock` is computed exactly the way `findLowStock` filters, so the tile and
 * the replenishment list can never disagree.
 *
 * @returns {Promise<object>}
 */
async function getStats() {
    const [itemRows] = await db.query(
        `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN si.status = 'Active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN si.status = 'Inactive' THEN 1 ELSE 0 END) AS inactive,
            SUM(CASE WHEN si.status = 'Discontinued' THEN 1 ELSE 0 END) AS discontinued,
            SUM(CASE WHEN si.status = 'Active'
                      AND COALESCE(si.minimum_level, 0) > 0
                      AND si.quantity_on_hand <= si.minimum_level THEN 1 ELSE 0 END) AS low_stock,
            SUM(CASE WHEN si.status = 'Active'
                      AND COALESCE(si.maximum_level, 0) > 0
                      AND si.quantity_on_hand > si.maximum_level THEN 1 ELSE 0 END) AS overstocked,
            COALESCE(SUM(si.quantity_on_hand), 0) AS units_on_hand,
            COALESCE(SUM(si.quantity_on_hand * si.unit_cost), 0) AS stock_value,
            SUM(CASE WHEN si.asset_id IS NOT NULL THEN 1 ELSE 0 END) AS serialised,
            SUM(CASE WHEN si.asset_id IS NULL THEN 1 ELSE 0 END) AS consumables
         FROM stock_items si`
    );

    const [movementRows] = await db.query(
        `SELECT
            COUNT(*) AS total_movements,
            SUM(CASE WHEN movement_type = 'Receipt' THEN 1 ELSE 0 END) AS receipts,
            SUM(CASE WHEN movement_type = 'Issue' THEN 1 ELSE 0 END) AS issues,
            SUM(CASE WHEN movement_type = 'Return' THEN 1 ELSE 0 END) AS returns,
            SUM(CASE WHEN movement_type = 'Adjustment' THEN 1 ELSE 0 END) AS adjustments,
            SUM(CASE WHEN movement_type = 'Write Off' THEN 1 ELSE 0 END) AS write_offs,
            SUM(CASE WHEN movement_type = 'Transfer' THEN 1 ELSE 0 END) AS transfers,
            SUM(CASE WHEN movement_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                      AND movement_type = 'Receipt' THEN 1 ELSE 0 END) AS receipts_30d,
            SUM(CASE WHEN movement_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                      AND movement_type = 'Issue' THEN 1 ELSE 0 END) AS issues_30d,
            COALESCE(SUM(CASE WHEN movement_type IN ('Receipt', 'Return')
                              THEN total_cost ELSE 0 END), 0) AS receipts_value
         FROM stock_movements`
    );

    const [typeRows] = await db.query(
        `SELECT movement_type, COUNT(*) AS total,
                COALESCE(SUM(ABS(quantity)), 0) AS units
         FROM stock_movements
         GROUP BY movement_type
         ORDER BY movement_type ASC`
    );

    const [storeRows] = await db.query(
        `SELECT si.store_location, COUNT(*) AS total,
                COALESCE(SUM(si.quantity_on_hand), 0) AS units
         FROM stock_items si
         GROUP BY si.store_location
         ORDER BY si.store_location ASC`
    );

    const [categoryRows] = await db.query(
        `SELECT si.category, COUNT(*) AS total,
                COALESCE(SUM(si.quantity_on_hand), 0) AS units
         FROM stock_items si
         GROUP BY si.category
         ORDER BY si.category ASC`
    );

    // Register assets the store module has not catalogued yet, so the totals
    // agree with the list view rather than silently omitting them.
    const [derivedRows] = await db.query(
        `SELECT
            COUNT(*) AS total,
            COALESCE(SUM(COALESCE(a.purchase_cost, 0)), 0) AS value
         ${ASSET_STOCK_FROM}
         WHERE ${ASSET_STOCK_SCOPE}
           AND NOT EXISTS (SELECT 1 FROM stock_items si2 WHERE si2.asset_id = a.id)`
    );

    const items = itemRows[0] || {};
    const movements = movementRows[0] || {};
    const derived = derivedRows[0] || {};

    return {
        total: Number(items.total || 0),
        active: Number(items.active || 0),
        inactive: Number(items.inactive || 0),
        discontinued: Number(items.discontinued || 0),
        lowStock: Number(items.low_stock || 0),
        overstocked: Number(items.overstocked || 0),
        unitsOnHand: Number(items.units_on_hand || 0),
        stockValue: Number(items.stock_value || 0),
        serialisedItems: Number(items.serialised || 0),
        consumableItems: Number(items.consumables || 0),

        totalMovements: Number(movements.total_movements || 0),
        receipts: Number(movements.receipts || 0),
        issues: Number(movements.issues || 0),
        returns: Number(movements.returns || 0),
        adjustments: Number(movements.adjustments || 0),
        writeOffs: Number(movements.write_offs || 0),
        transfers: Number(movements.transfers || 0),
        receipts30d: Number(movements.receipts_30d || 0),
        issues30d: Number(movements.issues_30d || 0),
        receiptsValue: Number(movements.receipts_value || 0),

        derivedFromRegister: Number(derived.total || 0),
        derivedValue: Number(derived.value || 0),

        byMovementType: typeRows,
        byStore: storeRows,
        byCategory: categoryRows
    };
}


module.exports = {
    // Table names & DDL
    STOCK_ITEM_TABLE,
    STOCK_MOVEMENT_TABLE,
    STOCK_ITEM_TABLE_DDL,
    STOCK_MOVEMENT_TABLE_DDL,

    // SQL fragments (exposed so the controller can compose scoped reads)
    STOCK_ITEM_COLUMNS,
    STOCK_ITEM_FROM,
    STOCK_ITEM_JOIN_COLUMNS,
    STOCK_ITEM_SELECT,
    MOVEMENT_COLUMNS,
    MOVEMENT_FROM,
    MOVEMENT_JOIN_COLUMNS,
    MOVEMENT_SELECT,
    ASSET_STOCK_FROM,
    ASSET_STOCK_SCOPE,
    STOCK_STATE_SQL,
    WRITABLE_COLUMNS,
    MOVEMENT_WRITABLE_COLUMNS,

    // Bootstrap
    ensureTable,

    // Reads - store cards
    findById,
    findByRef,
    findByAssetId,
    findByAssetKey,
    findAll,
    findLowStock,
    getBalances,

    // Reads - movements
    findMovements,
    findMovementById,
    findMovementsByItem,
    findMovementsByAsset,
    findRecentMovements,

    // Writes
    create,
    update,
    remove,
    recordMovement,
    reverseMovement,

    // Counters / helpers
    countMovementsByItem,
    resolveAssetPk,
    itemRefExists,
    findMaxRefSuffix,
    getStats
};
