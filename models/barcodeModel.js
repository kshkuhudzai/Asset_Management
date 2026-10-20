'use strict';

// models/barcodeModel.js
// All database access for QR Code / Barcode Management (section 5.8).
//
// Design notes
//   * Section 5.8 asks to "generate or associate a unique QR/barcode with each
//     asset" and to "support scanning for identification and verification". Two
//     things are therefore needed: durable identity media per asset, and a
//     resolver that turns a scanned string into an asset.
//   * The register ALREADY holds `assets.qr_code_value` (section 6,
//     Identification Media). That column is the source of truth for "what code
//     is printed on this asset", so this module reads and writes it rather than
//     inventing a competing field. It is kept unique across the register by the
//     controller, because two assets sharing a scan code would make scanning
//     ambiguous.
//   * What the register cannot express is the LABEL lifecycle: which medium was
//     used (QR sticker, barcode, RFID), how many times it was printed, when it
//     was last printed and by whom, whether the physical label is still intact,
//     and a reprint count for audit. Those live in `asset_barcode_labels`, one
//     row per label issued for an asset.
//   * Every scan is appended to `asset_scan_events`, so 5.8 scan history is a
//     plain ordered read rather than a reconstruction.
//   * Scanning is a READ. Section 5.8 limits what a scan may reveal and
//     section 10 states "Sensitive information must not be exposed through
//     unauthenticated QR-code scans", so every route sits behind `protect` and
//     the controller returns only a non-sensitive projection.
//
// Controllers must never build SQL themselves - every query lives here so
// table/column names stay in one place.
//

const db = require('../config/db');

/* -------------------------------------------------------------------------- */
/* DDL                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The printable label register.
 *
 * `asset_id` cascades on delete: a thrown-away asset cannot leave a dangling
 * label. `code_value` is not unique here because a replacement sticker may
 * legitimately re-issue the same code; the controller enforces uniqueness of
 * the ACTIVE code per asset.
 */
const LABEL_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS asset_barcode_labels (
        id INT AUTO_INCREMENT PRIMARY KEY,
        label_ref VARCHAR(50) UNIQUE,                  -- LBL-000001
        asset_id INT NOT NULL,                         -- FK to assets.id

        code_value VARCHAR(255) NOT NULL,              -- encoded string
        code_type ENUM('QR Code', 'Barcode', 'RFID', 'Manual')
            NOT NULL DEFAULT 'QR Code',
        symbology VARCHAR(50),                         -- QR, Code128, EAN-13 ...

        label_reference VARCHAR(100),                  -- printed batch / sheet ref
        label_status ENUM('Active', 'Damaged', 'Lost', 'Retired', 'Replaced')
            NOT NULL DEFAULT 'Active',
        label_condition ENUM('Good', 'Fair', 'Damaged') DEFAULT 'Good',

        print_count INT NOT NULL DEFAULT 1,            -- times printed
        last_printed_at DATETIME NULL,
        last_printed_by INT,                           -- FK to users.id

        is_primary TINYINT(1) NOT NULL DEFAULT 1,      -- code shown on the asset
        notes TEXT,

        issued_by INT,                                 -- FK to users.id
        issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (issued_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (last_printed_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_label_asset (asset_id),
        INDEX idx_label_code (code_value),
        INDEX idx_label_status (label_status),
        INDEX idx_label_type (code_type)
    )
`;

/**
 * Scan events.
 *
 * Separate from the label register because a scan is an EVENT while a label is
 * durable identity media: scan history is auditable activity in its own right
 * (section 13). `asset_id` is SET NULL so losing the asset does not erase the
 * evidence that something was scanned.
 *
 * `verification_id` is a soft reference (no FK) so this module can be deployed
 * independently of the section 5.9 verification tables.
 */
const SCAN_TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS asset_scan_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        scan_ref VARCHAR(50) UNIQUE,                   -- SCN-000001
        asset_id INT NULL,                             -- FK to assets.id
        code_value VARCHAR(255) NOT NULL,

        scan_result ENUM('Matched', 'Unknown Code', 'Retired Asset', 'Ambiguous')
            NOT NULL DEFAULT 'Matched',
        scan_purpose ENUM('Identification', 'Verification', 'Stocktake', 'Audit')
            NOT NULL DEFAULT 'Identification',
        scan_location VARCHAR(150),
        device_info VARCHAR(255),

        verification_id INT NULL,                      -- soft FK to 5.9
        scanned_by INT,                                -- FK to users.id
        scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
        FOREIGN KEY (scanned_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_scan_asset (asset_id),
        INDEX idx_scan_code (code_value),
        INDEX idx_scan_at (scanned_at)
    )
`;

/**
 * Creates both tables if they do not exist. Idempotent, so it is safe to call
 * on every boot.
 *
 * @returns {Promise<void>}
 */
async function ensureTable() {
    await db.query(LABEL_TABLE_DDL);
    await db.query(SCAN_TABLE_DDL);
}

/* -------------------------------------------------------------------------- */
/* Reference generation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Produces the next sequential reference for a table, e.g. LBL-000007.
 *
 * Uses MAX(id) rather than COUNT(*) so deleting a row cannot cause a reference
 * to be reused.
 *
 * @param {string} table Physical table name.
 * @param {string} prefix Reference prefix, e.g. 'LBL'.
 * @returns {Promise<string>} Zero-padded reference.
 */
async function nextReference(table, prefix) {
    const [rows] = await db.query(
        `SELECT COALESCE(MAX(id), 0) + 1 AS next FROM ${table}`
    );
    const next = rows[0] ? Number(rows[0].next) : 1;
    return `${prefix}-${String(next).padStart(6, '0')}`;
}

/** Next label reference, e.g. LBL-000001. */
const nextLabelRef = () => nextReference('asset_barcode_labels', 'LBL');

/** Next scan reference, e.g. SCN-000001. */
const nextScanRef = () => nextReference('asset_scan_events', 'SCN');

/* -------------------------------------------------------------------------- */
/* Shared SELECT fragments                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Columns joined from `assets` for a label row.
 *
 * Only the fields a barcode screen or a printed label needs are selected, so a
 * scan response can never leak cost, notes or other sensitive register data by
 * accident.
 *
 * Note: `a.asset_id` is aliased as `asset_code` so it does not overwrite the
 * integer primary key `l.asset_id` returned from `asset_barcode_labels`.
 */
const ASSET_COLUMNS = `
    a.asset_id AS asset_code,
    a.asset_tag,
    a.serial_number,
    a.manufacturer,
    a.model,
    a.category_id,
    a.location,
    a.department,
    a.status AS asset_status,
    a.condition_status AS asset_condition,
    a.qr_code_value AS asset_qr_code_value,
    a.assigned_user_id,
    a.date_registered,
    c.name AS category_name,
    COALESCE(c.name, 'ICT Asset') AS asset_type,
    u.full_name AS assigned_user_name
`;

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Inserts one label row.
 *
 * @param {object} data Column values already validated by the controller.
 * @returns {Promise<number>} The new label id.
 */
async function createLabel(data) {
    const [result] = await db.query(
        `INSERT INTO asset_barcode_labels
            (label_ref, asset_id, code_value, code_type, symbology,
             label_reference, label_status, label_condition, print_count,
             last_printed_at, last_printed_by, is_primary, notes, issued_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.label_ref,
            data.asset_id,
            data.code_value,
            data.code_type || 'QR Code',
            data.symbology || null,
            data.label_reference || null,
            data.label_status || 'Active',
            data.label_condition || 'Good',
            data.print_count === undefined ? 1 : data.print_count,
            data.last_printed_at || null,
            data.last_printed_by || null,
            data.is_primary === undefined ? 1 : data.is_primary,
            data.notes || null,
            data.issued_by || null
        ]
    );
    return result.insertId;
}

/**
 * Fetches one label joined to its asset.
 *
 * Accepts a numeric id or an LBL- reference, mirroring the other modules.
 *
 * @param {string|number} idOrRef
 * @returns {Promise<object|null>}
 */
async function findLabel(idOrRef) {
    const asNumber = Number(idOrRef);
    const useId = Number.isInteger(asNumber) && asNumber > 0;
    const [rows] = await db.query(
        `SELECT l.*, ${ASSET_COLUMNS}
           FROM asset_barcode_labels l
           JOIN assets a ON a.id = l.asset_id
           LEFT JOIN asset_categories c ON c.id = a.category_id
           LEFT JOIN users u ON u.id = a.assigned_user_id
          WHERE ${useId ? 'l.id = ?' : 'l.label_ref = ?'}
          LIMIT 1`,
        [useId ? asNumber : idOrRef]
    );
    return rows[0] || null;
}

/**
 * The active label currently attached to an asset, if any.
 *
 * @param {number} assetId
 * @returns {Promise<object|null>}
 */
async function findPrimaryLabelForAsset(assetId) {
    const [rows] = await db.query(
        `SELECT l.*, ${ASSET_COLUMNS}
           FROM asset_barcode_labels l
           JOIN assets a ON a.id = l.asset_id
           LEFT JOIN asset_categories c ON c.id = a.category_id
           LEFT JOIN users u ON u.id = a.assigned_user_id
          WHERE l.asset_id = ?
            AND l.label_status IN ('Active', 'Damaged')
          ORDER BY l.is_primary DESC, l.id DESC
          LIMIT 1`,
        [assetId]
    );
    return rows[0] || null;
}

/**
 * All labels for one asset, newest first - the label history panel.
 *
 * @param {number} assetId
 * @returns {Promise<object[]>}
 */
async function findLabelsForAsset(assetId) {
    const [rows] = await db.query(
        `SELECT l.*, u.full_name AS issued_by_name, p.full_name AS last_printed_by_name
           FROM asset_barcode_labels l
           LEFT JOIN users u ON u.id = l.issued_by
           LEFT JOIN users p ON p.id = l.last_printed_by
          WHERE l.asset_id = ?
          ORDER BY l.id DESC`,
        [assetId]
    );
    return rows;
}

/**
 * Does this code value already belong to a DIFFERENT asset?
 *
 * Enforces "associate a unique QR/barcode with each asset" (section 5.8).
 * `excludeAssetId` lets an asset keep its own code when re-issuing a
 * replacement sticker.
 *
 * @param {string} codeValue
 * @param {number} [excludeAssetId]
 * @returns {Promise<object|null>} The clashing asset, or null.
 */
async function findCodeOwner(codeValue, excludeAssetId) {
    const [rows] = await db.query(
        `SELECT id, asset_id, asset_tag, serial_number, qr_code_value
           FROM assets
          WHERE qr_code_value = ?
            AND (? IS NULL OR id <> ?)\n          LIMIT 1`,
        [codeValue, excludeAssetId || null, excludeAssetId || null]
    );
    return rows[0] || null;
}

/**
 * Lists labels with search, filtering and pagination.
 *
 * @param {object} opts search / asset_id / code_type / label_status /
 *                      department / location / limit / offset
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function findAllLabels(opts = {}) {
    const where = [];
    const params = [];

    if (opts.search) {
        const like = `%${opts.search}%`;
        where.push(`(l.code_value LIKE ? OR l.label_ref LIKE ?
                     OR a.asset_tag LIKE ? OR a.serial_number LIKE ?
                     OR l.label_reference LIKE ?)`);
        params.push(like, like, like, like, like);
    }
    if (opts.asset_id) {
        where.push('l.asset_id = ?');
        params.push(opts.asset_id);
    }
    if (opts.code_type) {
        where.push('l.code_type = ?');
        params.push(opts.code_type);
    }
    if (opts.label_status) {
        where.push('l.label_status = ?');
        params.push(opts.label_status);
    }
    if (opts.department) {
        where.push('a.department = ?');
        params.push(opts.department);
    }
    if (opts.location) {
        where.push('a.location = ?');
        params.push(opts.location);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total
           FROM asset_barcode_labels l
           JOIN assets a ON a.id = l.asset_id
           LEFT JOIN asset_categories c ON c.id = a.category_id
           ${whereSql}`,
        params
    );

    const limit = Math.max(1, Math.min(Number(opts.limit) || 25, 200));
    const offset = Math.max(0, Number(opts.offset) || 0);

    const [rows] = await db.query(
        `SELECT l.*, ${ASSET_COLUMNS}
           FROM asset_barcode_labels l
           JOIN assets a ON a.id = l.asset_id
           LEFT JOIN asset_categories c ON c.id = a.category_id
           LEFT JOIN users u ON u.id = a.assigned_user_id
           ${whereSql}
          ORDER BY l.id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    return { rows, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * Applies a partial update to one label.
 *
 * The column whitelist lives in the controller; this function writes only what
 * it is handed.
 *
 * @param {number} id
 * @param {object} fields Column => value pairs.
 * @returns {Promise<number>} Affected row count.
 */
async function updateLabel(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return 0;

    const assignments = keys.map((k) => `${k} = ?`).join(', ');
    const [result] = await db.query(
        `UPDATE asset_barcode_labels SET ${assignments} WHERE id = ?`,
        [...keys.map((k) => fields[k]), id]
    );
    return result.affectedRows;
}

/**
 * Bumps the print counter for a label and stamps who printed it.
 *
 * @param {number} id
 * @param {number|null} userId
 * @returns {Promise<number>} Affected row count.
 */
async function recordPrint(id, userId) {
    const [result] = await db.query(
        `UPDATE asset_barcode_labels
            SET print_count = print_count + 1,
                last_printed_at = NOW(),
                last_printed_by = ?
          WHERE id = ?`,
        [userId || null, id]
    );
    return result.affectedRows;
}

/**
 * Retires every label currently attached to an asset.
 *
 * Called before a replacement sticker is issued so an asset never has two
 * Active labels at once.
 *
 * @param {number|string} assetId Numeric assets.id or unique asset_id/asset_tag.
 * @param {string} newStatus
 * @returns {Promise<number>} Affected row count.
 */
async function retireLabelsForAsset(assetId, newStatus = 'Replaced') {
    const numericAssetId = Number(assetId);
    let targetId = numericAssetId;

    if (!Number.isInteger(numericAssetId) || numericAssetId <= 0) {
        const [assetRows] = await db.query(
            'SELECT id FROM assets WHERE asset_id = ? OR asset_tag = ? LIMIT 1',
            [assetId, assetId]
        );
        if (assetRows.length) {
            targetId = assetRows[0].id;
        } else {
            return 0;
        }
    }

    const [result] = await db.query(
        `UPDATE asset_barcode_labels
            SET label_status = ?, is_primary = 0
          WHERE asset_id = ?
            AND label_status = 'Active'`,
        [newStatus, targetId]
    );
    return result.affectedRows;
}

/* -------------------------------------------------------------------------- */
/* Scan events (section 5.8)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Records one scan event.
 *
 * @param {object} data Column values.
 * @returns {Promise<number>} The new scan id.
 */
async function createScanEvent(data) {
    const [result] = await db.query(
        `INSERT INTO asset_scan_events
            (scan_ref, asset_id, code_value, scan_result, scan_purpose,
             scan_location, device_info, verification_id, scanned_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.scan_ref,
            data.asset_id || null,
            data.code_value,
            data.scan_result || 'Matched',
            data.scan_purpose || 'Identification',
            data.scan_location || null,
            data.device_info || null,
            data.verification_id || null,
            data.scanned_by || null
        ]
    );
    return result.insertId;
}

/**
 * Resolves a scanned code to an asset.
 *
 * The lookup is an exact match on `qr_code_value` (indexed). A scanner appends
 * a newline or carriage return depending on the device, so the caller trims the
 * value before it reaches here.
 *
 * @param {string} codeValue Exact code as scanned.
 * @returns {Promise<object|null>} The asset row, or null when unmatched.
 */
async function findAssetByCode(codeValue) {
    const [rows] = await db.query(
        `SELECT a.id, a.asset_id, a.asset_tag, a.serial_number,
                a.manufacturer, a.model, a.category_id, a.location,
                a.department, a.status, a.condition_status,
                a.qr_code_value, a.assigned_user_id, a.date_registered,
                c.name AS category_name,
                COALESCE(c.name, 'ICT Asset') AS asset_type,
                u.full_name AS assigned_user_name
           FROM assets a
           LEFT JOIN asset_categories c ON c.id = a.category_id
           LEFT JOIN users u ON u.id = a.assigned_user_id
          WHERE a.qr_code_value = ?
          LIMIT 1`,
        [codeValue]
    );
    return rows[0] || null;
}

/**
 * Lists scan events with search, filtering and pagination.
 *
 * @param {object} opts
 * @returns {Promise<{rows: object[], total: number}>}
 */
async function findAllScans(opts = {}) {
    const where = [];
    const params = [];

    if (opts.search) {
        const like = `%${opts.search}%`;
        where.push(`(s.code_value LIKE ? OR s.scan_ref LIKE ?
                     OR a.asset_tag LIKE ? OR s.scan_location LIKE ?)`);
        params.push(like, like, like, like);
    }
    if (opts.asset_id) {
        where.push('s.asset_id = ?');
        params.push(opts.asset_id);
    }
    if (opts.scan_result) {
        where.push('s.scan_result = ?');
        params.push(opts.scan_result);
    }
    if (opts.scan_purpose) {
        where.push('s.scan_purpose = ?');
        params.push(opts.scan_purpose);
    }
    if (opts.verification_id) {
        where.push('s.verification_id = ?');
        params.push(opts.verification_id);
    }
    if (opts.from) {
        where.push('s.scanned_at >= ?');
        params.push(opts.from);
    }
    if (opts.to) {
        where.push('s.scanned_at <= ?');
        params.push(`${opts.to} 23:59:59`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await db.query(
        `SELECT COUNT(*) AS total
           FROM asset_scan_events s
           LEFT JOIN assets a ON a.id = s.asset_id
           ${whereSql}`,
        params
    );

    const limit = Math.max(1, Math.min(Number(opts.limit) || 25, 200));
    const offset = Math.max(0, Number(opts.offset) || 0);

    const [rows] = await db.query(
        `SELECT s.*, a.asset_tag, a.serial_number, a.department, a.location,
                u.full_name AS scanned_by_name
           FROM asset_scan_events s
           LEFT JOIN assets a ON a.id = s.asset_id
           LEFT JOIN users u ON u.id = s.scanned_by
           ${whereSql}
          ORDER BY s.scanned_at DESC, s.id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    return { rows, total: countRows[0] ? Number(countRows[0].total) : 0 };
}

/**
 * One scan event by id or SCN- reference.
 *
 * @param {string|number} idOrRef
 * @returns {Promise<object|null>}
 */
async function findScan(idOrRef) {
    const asNumber = Number(idOrRef);
    const useId = Number.isInteger(asNumber) && asNumber > 0;
    const [rows] = await db.query(
        `SELECT s.*, a.asset_tag, a.serial_number, a.department, a.location,
                u.full_name AS scanned_by_name
           FROM asset_scan_events s
           LEFT JOIN assets a ON a.id = s.asset_id
           LEFT JOIN users u ON u.id = s.scanned_by
          WHERE ${useId ? 's.id = ?' : 's.scan_ref = ?'}
          LIMIT 1`,
        [useId ? asNumber : idOrRef]
    );
    return rows[0] || null;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
    // DDL / bootstrap
    LABEL_TABLE_DDL,
    SCAN_TABLE_DDL,
    ensureTable,

    // References
    nextLabelRef,
    nextScanRef,

    // Labels
    createLabel,
    findLabel,
    findPrimaryLabelForAsset,
    findLabelsForAsset,
    findCodeOwner,
    findAllLabels,
    updateLabel,
    recordPrint,
    retireLabelsForAsset,

    // Scans
    createScanEvent,
    findAssetByCode,
    findAllScans,
    findScan
};
