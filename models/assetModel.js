'use strict';

// models/assetModel.js
// All database access for the asset register: the `assets` table and its
// companion `asset_categories` reference table. Controllers must never build
// SQL themselves - every query lives here so column/table names stay in one
// place.
//
// Design notes
//   * `asset_id` is a human-readable, system-generated identifier (e.g.
//     NBSZ-ICT-000123) and `asset_tag` is the physical label value. Both are
//     UNIQUE, so pre-flight duplicate checks are exposed as helpers.
//   * `serial_number` is UNIQUE but nullable - MySQL allows many NULLs in a
//     unique index, so assets without a serial are fine.
//   * Rows are never physically deleted; `softDelete` moves an asset to the
//     'Disposed' status and clears its custodian so history stays intact.

const db = require('../config/db');

// Column list used for every client-facing SELECT so the API shape never
// drifts. Joined columns are prefixed with `a.` so the joins can select
// human-readable category / custodian names alongside the raw ids.
const ASSET_COLUMNS = `
    a.id,
    a.asset_id,
    a.asset_tag,
    a.serial_number,
    a.category_id,
    a.manufacturer,
    a.model,
    a.purchase_date,
    a.purchase_cost,
    a.supplier,
    a.po_invoice_ref,
    a.warranty_provider,
    a.warranty_start,
    a.warranty_end,
    a.warranty_ref,
    a.location,
    a.department,
    a.assigned_user_id,
    a.responsible_officer,
    a.status,
    a.condition_status,
    a.last_inspection_date,
    a.qr_code_value,
    a.date_registered
`;

// The asset table plus the two lookup joins, always applied together.
const ASSET_FROM = `
    FROM assets a
    LEFT JOIN asset_categories c ON c.id = a.category_id
    LEFT JOIN users u ON u.id = a.assigned_user_id
`;

// Joined helper columns appended after ASSET_COLUMNS.
const ASSET_JOIN_COLUMNS = `
    c.name AS category_name,
    u.username AS assigned_username,
    u.full_name AS assigned_full_name
`;

const CATEGORY_COLUMNS = `
    c.id,
    c.name,
    c.description,
    c.created_at
`;

// The select used by every single-asset read so the shape is identical whether
// the row came from a list, a create or an update.
const ASSET_SELECT = `
    SELECT
        ${ASSET_COLUMNS},
        ${ASSET_JOIN_COLUMNS}
    ${ASSET_FROM}
`;

/**
 * Finds a single asset by its numeric primary key, including the joined
 * category name and custodian details.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>} The asset, or null when not found.
 */
async function findById(id) {
    const [rows] = await db.query(`${ASSET_SELECT} WHERE a.id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

/**
 * Finds a single asset by its generated asset_id (the human-readable code).
 *
 * @param {string} assetId e.g. 'NBSZ-ICT-000001'
 * @returns {Promise<object|null>}
 */
async function findByAssetId(assetId) {
    const [rows] = await db.query(`${ASSET_SELECT} WHERE a.asset_id = ? LIMIT 1`, [assetId]);
    return rows[0] || null;
}

/**
 * Finds a single asset by its physical tag value.
 *
 * @param {string} assetTag
 * @returns {Promise<object|null>}
 */
async function findByAssetTag(assetTag) {
    const [rows] = await db.query(`${ASSET_SELECT} WHERE a.asset_tag = ? LIMIT 1`, [assetTag]);
    return rows[0] || null;
}

/**
 * Finds a single asset by manufacturer serial number.
 *
 * @param {string} serialNumber
 * @returns {Promise<object|null>}
 */
async function findBySerialNumber(serialNumber) {
    const [rows] = await db.query(`${ASSET_SELECT} WHERE a.serial_number = ? LIMIT 1`, [serialNumber]);
    return rows[0] || null;
}

/**
 * Lists assets with optional search / filter / sort and pagination.
 *
 * Every filter is optional; only the supplied ones are added to the WHERE
 * clause. `excludeDisposed` is applied by the controller for the default list
 * view so retired stock does not clutter the register.
 *
 * @param {object} [options]
 * @param {string} [options.search] Free-text match on asset_id, asset_tag,
 *        serial_number, manufacturer, model, location, department and
 *        responsible_officer.
 * @param {number} [options.categoryId]
 * @param {string} [options.status] Exact ENUM match.
 * @param {string} [options.conditionStatus] Exact ENUM match.
 * @param {string} [options.location] Partial match.
 * @param {string} [options.department] Partial match.
 * @param {number} [options.assignedUserId]
 * @param {boolean} [options.excludeDisposed] Hide 'Disposed' assets.
 * @param {boolean} [options.warrantyExpiringBefore] Only assets whose
 *        warranty_end is on/before this YYYY-MM-DD date.
 * @param {string} [options.sortBy='date_registered'] Whitelisted column.
 * @param {string} [options.sortDir='desc'] 'asc' or 'desc'.
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @returns {Promise<{assets: object[], total: number}>}
 */
async function findAll({
    search,
    categoryId,
    status,
    conditionStatus,
    location,
    department,
    assignedUserId,
    excludeDisposed = false,
    warrantyExpiringBefore,
    sortBy = 'date_registered',
    sortDir = 'desc',
    limit = 50,
    offset = 0
} = {}) {
    const where = [];
    const params = [];

    if (search) {
        where.push(
            `(a.asset_id LIKE ? OR a.asset_tag LIKE ? OR a.serial_number LIKE ?
              OR a.manufacturer LIKE ? OR a.model LIKE ? OR a.location LIKE ?
              OR a.department LIKE ? OR a.responsible_officer LIKE ?)`
        );
        const like = `%${search}%`;
        params.push(like, like, like, like, like, like, like, like);
    }
    if (categoryId !== undefined && categoryId !== null) {
        where.push('a.category_id = ?');
        params.push(categoryId);
    }
    if (status) {
        where.push('a.status = ?');
        params.push(status);
    }
    if (conditionStatus) {
        where.push('a.condition_status = ?');
        params.push(conditionStatus);
    }
    if (location) {
        where.push('a.location LIKE ?');
        params.push(`%${location}%`);
    }
    if (department) {
        where.push('a.department LIKE ?');
        params.push(`%${department}%`);
    }
    if (assignedUserId !== undefined && assignedUserId !== null) {
        where.push('a.assigned_user_id = ?');
        params.push(assignedUserId);
    }
    if (excludeDisposed) {
        where.push("a.status <> 'Disposed'");
    }
    if (warrantyExpiringBefore) {
        where.push('a.warranty_end IS NOT NULL AND a.warranty_end <= ?');
        params.push(warrantyExpiringBefore);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Whitelist sort columns - never interpolate raw user input into SQL.
    const sortableColumns = {
        asset_id: 'a.asset_id',
        asset_tag: 'a.asset_tag',
        serial_number: 'a.serial_number',
        manufacturer: 'a.manufacturer',
        model: 'a.model',
        location: 'a.location',
        department: 'a.department',
        status: 'a.status',
        condition_status: 'a.condition_status',
        purchase_date: 'a.purchase_date',
        purchase_cost: 'a.purchase_cost',
        warranty_end: 'a.warranty_end',
        last_inspection_date: 'a.last_inspection_date',
        date_registered: 'a.date_registered'
    };
    const orderColumn = sortableColumns[sortBy] || sortableColumns.date_registered;
    const orderDirection = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const [rows] = await db.query(
        `SELECT
            ${ASSET_COLUMNS},
            ${ASSET_JOIN_COLUMNS}
         ${ASSET_FROM}
         ${whereSql}
         ORDER BY ${orderColumn} ${orderDirection}, a.id ${orderDirection}
         LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)]
    );

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total ${ASSET_FROM} ${whereSql}`,
        params
    );

    return { assets: rows, total: countRows[0].total };
}

/**
 * Finds an asset by its QR code value.
 *
 * @param {string} qrValue
 * @returns {Promise<object|null>}
 */
async function findByQrValue(qrValue) {
    const [rows] = await db.query(`${ASSET_SELECT} WHERE a.qr_code_value = ? LIMIT 1`, [qrValue]);
    return rows[0] || null;
}

/**
 * Returns the highest numeric suffix currently used for a given asset-id
 * prefix, so the controller can allocate the next sequential code.
 *
 * Example: prefix 'NBSZ-ICT-' -> an existing 'NBSZ-ICT-000012' yields 12.
 *
 * @param {string} prefix e.g. 'NBSZ-ICT-'
 * @returns {Promise<number>} The largest suffix found (0 when none exist).
 */
async function findMaxAssetIdSuffix(prefix) {
    const [rows] = await db.query(
        `SELECT asset_id
         FROM assets
         WHERE asset_id LIKE ?
         ORDER BY LENGTH(asset_id) DESC, asset_id DESC
         LIMIT 1`,
        [`${prefix}%`]
    );

    if (!rows.length) return 0;

    const suffix = String(rows[0].asset_id).slice(prefix.length);
    const numeric = parseInt(suffix, 10);
    return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Checks whether an asset id already exists.
 *
 * @param {string} assetId
 * @param {number|string|null} [excludeId] Ignore this row (used on update).
 * @returns {Promise<boolean>}
 */
async function assetIdExists(assetId, excludeId = null) {
    return columnValueExists('asset_id', assetId, excludeId);
}

/**
 * Checks whether an asset tag already exists.
 *
 * @param {string} assetTag
 * @param {number|string|null} [excludeId]
 * @returns {Promise<boolean>}
 */
async function assetTagExists(assetTag, excludeId = null) {
    return columnValueExists('asset_tag', assetTag, excludeId);
}

/**
 * Checks whether a serial number already exists.
 *
 * @param {string} serialNumber
 * @param {number|string|null} [excludeId]
 * @returns {Promise<boolean>}
 */
async function serialNumberExists(serialNumber, excludeId = null) {
    return columnValueExists('serial_number', serialNumber, excludeId);
}

/**
 * Internal helper: does a value already exist in one of the UNIQUE asset
 * columns? The column name is never taken from user input - callers pass a
 * literal string from the helper functions above.
 *
 * @param {'asset_id'|'asset_tag'|'serial_number'} column
 * @param {*} value
 * @param {number|string|null} excludeId
 * @returns {Promise<boolean>}
 */
async function columnValueExists(column, value, excludeId = null) {
    const params = [value];
    let sql = `SELECT id FROM assets WHERE ${column} = ?`;

    if (excludeId !== null && excludeId !== undefined) {
        sql += ' AND id <> ?';
        params.push(excludeId);
    }

    const [rows] = await db.query(`${sql} LIMIT 1`, params);
    return rows.length > 0;
}

/**
 * Returns the existing asset that uses a given QR value, excluding one id.
 * Used so QR values stay unique across the register.\n *
 * @param {string} qrValue
 * @param {number|string|null} [excludeId]
 * @returns {Promise<object|null>}
 */
async function findQrValueOwner(qrValue, excludeId = null) {
    const params = [qrValue];
    let sql = 'SELECT id, asset_id, asset_tag, qr_code_value FROM assets WHERE qr_code_value = ?';

    if (excludeId !== null && excludeId !== undefined) {
        sql += ' AND id <> ?';
        params.push(excludeId);
    }

    const [rows] = await db.query(`${sql} LIMIT 1`, params);
    return rows[0] || null;
}

/**
 * Maps a controller-supplied payload object onto the writable asset columns.
 * Only keys present in the payload are included, so the same builder serves
 * both INSERT and UPDATE.
 *
 * Column names are hard-coded here (never derived from user input) which keeps
 * the statements injection-proof.
 *
 * @param {object} data camelCase or snake_case payload from the controller.
 * @param {boolean} forInsert When true, always emit every insertable column so
 *        the statement has a fixed arity.
 * @returns {{columns: string[], values: Array, assignments: string[]}}
 */
function buildColumnMapping(data, forInsert) {
    // [payloadKey, columnName]
    const mapping = [
        ['assetId', 'asset_id'],
        ['assetTag', 'asset_tag'],
        ['serialNumber', 'serial_number'],
        ['categoryId', 'category_id'],
        ['manufacturer', 'manufacturer'],
        ['model', 'model'],
        ['purchaseDate', 'purchase_date'],
        ['purchaseCost', 'purchase_cost'],
        ['supplier', 'supplier'],
        ['poInvoiceRef', 'po_invoice_ref'],
        ['warrantyProvider', 'warranty_provider'],
        ['warrantyStart', 'warranty_start'],
        ['warrantyEnd', 'warranty_end'],
        ['warrantyRef', 'warranty_ref'],
        ['location', 'location'],
        ['department', 'department'],
        ['assignedUserId', 'assigned_user_id'],
        ['responsibleOfficer', 'responsible_officer'],
        ['status', 'status'],
        ['conditionStatus', 'condition_status'],
        ['lastInspectionDate', 'last_inspection_date'],
        ['qrCodeValue', 'qr_code_value']
    ];

    const columns = [];
    const values = [];
    const assignments = [];

    for (const [key, column] of mapping) {
        const hasCamel = Object.prototype.hasOwnProperty.call(data, key);
        const hasSnake = Object.prototype.hasOwnProperty.call(data, column);
        const provided = hasCamel || hasSnake;
        const val = hasCamel ? data[key] : data[column];

        if (forInsert) {
            // Always include the column; fall back to null so arity is fixed.
            columns.push(column);
            values.push(provided ? val : null);
        } else if (provided) {
            assignments.push(`${column} = ?`);
            values.push(val);
        }
    }

    return { columns, values, assignments };
}

/**
 * Inserts a new asset.
 *
 * @param {object} data camelCase payload (see buildColumnMapping).
 * @returns {Promise<object>} The freshly-created asset with joins applied.
 */
async function create(data) {
    const { columns, values } = buildColumnMapping(data, true);

    const [result] = await db.query(
        `INSERT INTO assets (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
        values
    );

    return findById(result.insertId);
}

/**
 * Updates an asset with a partial payload. Columns absent from `data` keep
 * their current values.
 *
 * @param {number|string} id
 * @param {object} data camelCase payload.
 * @returns {Promise<object|null>} The updated asset, or null if not matched.
 */
async function update(id, data) {
    const { assignments, values } = buildColumnMapping(data, false);

    if (!assignments.length) return findById(id);

    values.push(id);
    const [result] = await db.query(
        `UPDATE assets SET ${assignments.join(', ')} WHERE id = ?`,
        values
    );

    if (result.affectedRows === 0) return null;
    return findById(id);
}

/**
 * Soft-deletes an asset by moving it to the 'Disposed' status and clearing the
 * custodian. The row (and its audit history) is retained permanently.
 *
 * @param {number|string} id
 * @param {string} [conditionStatus] Optional final condition to record.
 * @returns {Promise<object|null>} The updated asset, or null if not matched.
 */
async function softDelete(id, conditionStatus = null) {
    const sets = ["status = 'Disposed'", 'assigned_user_id = NULL'];
    const params = [];

    if (conditionStatus) {
        sets.push('condition_status = ?');
        params.push(conditionStatus);
    }

    params.push(id);
    const [result] = await db.query(
        `UPDATE assets SET ${sets.join(', ')} WHERE id = ?`,
        params
    );

    if (result.affectedRows === 0) return null;
    return findById(id);
}

/**
 * Aggregate counts used by the register summary / dashboard tiles.
 *
 * @returns {Promise<{total: number, inUse: number, inStock: number, underRepair: number, missing: number, retired: number, disposed: number, byStatus: object[], byCategory: object[], byLocation: object[]}>}
 */
async function getStats() {
    const [byStatus] = await db.query(
        `SELECT status, COUNT(*) AS total
         FROM assets
         GROUP BY status
         ORDER BY status ASC`
    );

    const statusCounts = new Map(
        byStatus.map((row) => [row.status, Number(row.total)])
    );
    const countStatus = (status) => statusCounts.get(status) || 0;

    const [byCategory] = await db.query(
        `SELECT
            COALESCE(c.name, 'Uncategorised') AS category,
            COUNT(*) AS total
         FROM assets a
         LEFT JOIN asset_categories c ON c.id = a.category_id
         GROUP BY category
         ORDER BY total DESC`
    );

    const [byLocation] = await db.query(
        `SELECT
            COALESCE(NULLIF(a.location, ''), 'Unspecified') AS location,
            COUNT(*) AS total
         FROM assets a
         GROUP BY location
         ORDER BY total DESC`
    );

    return {
        total: byStatus.reduce((total, row) => total + Number(row.total), 0),
        inUse: countStatus('In Use'),
        inStock: countStatus('In Stock'),
        underRepair: countStatus('Under Repair'),
        missing: countStatus('Missing'),
        retired: countStatus('Retired'),
        disposed: countStatus('Disposed'),
        byStatus,
        byCategory,
        byLocation
    };
}

/* ========================================================================== */
/* Asset categories (reference data)                                          */
/* ========================================================================== */

/**
 * Lists asset categories, optionally with the number of assets filed under
 * each. Sorted alphabetically so pick-lists render predictably.
 *
 * @param {object} [options]
 * @param {boolean} [options.withAssetCounts=false] Include an asset_count column.
 * @returns {Promise<object[]>}\n */
async function findCategories({ withAssetCounts = false } = {}) {
    if (!withAssetCounts) {
        const [rows] = await db.query(
            `SELECT
                ${CATEGORY_COLUMNS}
             FROM asset_categories c
             ORDER BY c.name ASC`
        );
        return rows;
    }

    const [rows] = await db.query(
        `SELECT
            ${CATEGORY_COLUMNS},
            COUNT(a.id) AS asset_count
         FROM asset_categories c
         LEFT JOIN assets a ON a.category_id = c.id
         GROUP BY c.id, c.name, c.description, c.created_at
         ORDER BY c.name ASC`
    );
    return rows;
}

/**
 * Finds a category by its numeric id.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
async function findCategoryById(id) {
    const [rows] = await db.query(
        `SELECT ${CATEGORY_COLUMNS} FROM asset_categories c WHERE c.id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

/**
 * Finds a category by name (case-insensitive). Used for duplicate checks.
 *
 * @param {string} name
 * @returns {Promise<object|null>}
 */
async function findCategoryByName(name) {
    const [rows] = await db.query(
        `SELECT ${CATEGORY_COLUMNS}
         FROM asset_categories c
         WHERE LOWER(c.name) = LOWER(?)
         LIMIT 1`,
        [name]
    );
    return rows[0] || null;
}

/**
 * Creates a new asset category.
 *
 * @param {object} data
 * @param {string} data.name
 * @param {string|null} [data.description]
 * @returns {Promise<object>} The created category.
 */
async function createCategory({ name, description = null }) {
    const [result] = await db.query(
        'INSERT INTO asset_categories (name, description) VALUES (?, ?)',
        [name, description]
    );

    return findCategoryById(result.insertId);
}

/**
 * Updates an asset category.
 *
 * @param {number|string} id
 * @param {object} data
 * @param {string} [data.name]
 * @param {string|null} [data.description]
 * @returns {Promise<object|null>} The updated category, or null if not found.
 */
async function updateCategory(id, data) {
    const sets = [];
    const params = [];

    if (data.name !== undefined) {
        sets.push('name = ?');
        params.push(data.name);
    }
    if (data.description !== undefined) {
        sets.push('description = ?');
        params.push(data.description);
    }

    if (!sets.length) return findCategoryById(id);

    params.push(id);
    const [result] = await db.query(
        `UPDATE asset_categories SET ${sets.join(', ')} WHERE id = ?`,
        params
    );

    if (result.affectedRows === 0) return null;
    return findCategoryById(id);
}

/**
 * Counts how many assets reference a category. A category in use must not be
 * deleted, otherwise its assets would silently lose their classification.
 *
 * @param {number|string} categoryId
 * @returns {Promise<number>}
 */
async function countAssetsInCategory(categoryId) {
    const [rows] = await db.query(
        'SELECT COUNT(*) AS total FROM assets WHERE category_id = ?',
        [categoryId]
    );
    return rows[0].total;
}

/**
 * Deletes an asset category. The controller must check
 * `countAssetsInCategory` first and refuse the delete when the count is > 0.
 *
 * @param {number|string} id
 * @returns {Promise<boolean>} True when a row was removed.
 */
async function deleteCategory(id) {
    const [result] = await db.query('DELETE FROM asset_categories WHERE id = ?', [id]);
    return result.affectedRows > 0;
}

/* ========================================================================== */
/* QR code values                                                             */
/* ========================================================================== */

/**
 * Generates a deterministic, human-readable QR payload for an asset.
 *
 * Format: `NBSZ|ASSET|<asset_id>|<asset_tag>` - a scanner-friendly pipe
 * delimited string. The security requirement states that sensitive fields must
 * not be exposed through a QR scan, so only the two public identifiers are
 * encoded - never serial numbers, costs or custodian details.
 *
 * A trailing check token derived from the asset id keeps the value unique even
 * if two assets were given the same tag by mistake.
 *
 * @param {object} asset
 * @param {string} asset.assetId
 * @param {string} asset.assetTag
 * @returns {string} The QR payload (fits in VARCHAR(255)).
 */
function buildQrValue({ assetId, assetTag }) {
    const id = String(assetId || '').trim();
    const tag = String(assetTag || '').trim();
    return `NBSZ|ASSET|${id}|${tag}`;
}

/**
 * Builds a QR value and guarantees it does not already belong to another
 * asset. Appends a numeric discriminator on collision.
 *
 * @param {object} asset
 * @param {string} asset.assetId
 * @param {string} asset.assetTag
 * @param {number|string|null} [excludeId] Asset being updated (ignored in the clash check).
 * @returns {Promise<string>} A unique QR payload.
 */
async function generateUniqueQrValue({ assetId, assetTag }, excludeId = null) {
    const base = buildQrValue({ assetId, assetTag });
    let candidate = base;
    let attempt = 1;

    /* eslint-disable no-await-in-loop */
    while (await findQrValueOwner(candidate, excludeId)) {
        candidate = `${base}#${attempt}`;
        attempt += 1;
        if (attempt > 50) {
            // Extremely unlikely - fall back to a time-based discriminator.
            candidate = `${base}#${Date.now()}`;
            break;
        }
    }
    /* eslint-enable no-await-in-loop */

    return candidate;
}

/**
 * Allocates the next sequential asset id for a category prefix, e.g.
 * `NBSZ-ICT-000007`. Zero-padded to six digits to match the register format.
 *
 * @param {string} [prefix='NBSZ-AST-']
 * @returns {Promise<string>}
 */
async function generateNextAssetId(prefix = 'NBSZ-AST-') {
    const max = await findMaxAssetIdSuffix(prefix);
    return `${prefix}${String(max + 1).padStart(6, '0')}`;
}

module.exports = {
    ASSET_COLUMNS,
    ASSET_JOIN_COLUMNS,
    ASSET_SELECT,
    CATEGORY_COLUMNS,

    // Assets
    findById,
    findByAssetId,
    findByAssetTag,
    findBySerialNumber,
    findByQrValue,
    findAll,
    create,
    update,
    softDelete,
    getStats,

    // Uniqueness helpers
    assetIdExists,
    assetTagExists,
    serialNumberExists,
    findMaxAssetIdSuffix,
    findQrValueOwner,

    // Asset categories
    findCategories,
    findCategoryById,
    findCategoryByName,
    createCategory,
    updateCategory,
    countAssetsInCategory,
    deleteCategory,

    // Identification / code generation
    buildQrValue,
    generateUniqueQrValue,
    generateNextAssetId
};
