'use strict';

// Barcode issuance, printing, lookup, scan history, and audit workflows.
//
// Business rules (section 5.8, 10, 11)
//   * A scan code is unique across the register, because two assets sharing a
//     code would make scanning ambiguous (acceptance criterion 6).
//   * Losing or damaging a label never deletes the asset; it marks the physical
//     medium, and the asset record is untouched.
//   * A replacement label retires the previous one first, so an asset never has
//     two Active labels at once.
//   * A scan response carries only identification fields - never cost, notes or
//     warranty data - so a scan cannot leak sensitive information.

const crypto = require('crypto');
const barcodeModel = require('../models/barcodeModel');
const assetModel = require('../models/assetModel');
const db = require('../config/db');
const { auditLog } = require('../middleware/auditMiddleware');
const { ROLES } = require('../middleware/rbacMiddleware');
const {
    getClientIp,
    normalizeString,
    successResponse,
    errorResponse
} = require('../utils/helpers');

// Table names as they appear in audit_logs.table_name.
const LABEL_TABLE = 'asset_barcode_labels';

// ENUM values from the asset_barcode_labels schema. Kept here so validation and
// the /meta endpoint share a single source of truth.
const CODE_TYPES = Object.freeze(['QR Code', 'Barcode', 'RFID', 'Manual']);

const LABEL_STATUSES = Object.freeze([
    'Active',
    'Damaged',
    'Lost',
    'Retired',
    'Replaced'
]);

const LABEL_CONDITIONS = Object.freeze(['Good', 'Fair', 'Damaged']);

// ENUM values from the asset_scan_events schema.
const SCAN_RESULTS = Object.freeze([
    'Matched',
    'Unknown Code',
    'Retired Asset',
    'Ambiguous'
]);

const SCAN_PURPOSES = Object.freeze([
    'Identification',
    'Verification',
    'Stocktake',
    'Audit'
]);

// Symbologies offered in the pick-list. Free text in the schema, but a
// controlled list keeps printed labels consistent.
const SYMBOLOGIES = Object.freeze([
    'QR',
    'Code128',
    'Code39',
    'EAN-13',
    'EAN-8',
    'UPC-A',
    'DataMatrix',
    'PDF417'
]);

// Guard rail so a caller cannot ask for an unbounded page.
const MAX_LIMIT = 200;

// Bulk generation cap, so one request cannot mint a runaway number of codes.
const MAX_BULK_GENERATE = 100;

// Roles that may read the barcode register.
const READER_ROLES = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR];

// Roles that may mint codes and print labels. Auditors are read-only oversight.
const WRITER_ROLES = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER];

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Today as YYYY-MM-DD in the server's local timezone.
 *
 * @returns {string}
 */
function today() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Safely extracts a non-empty trimmed string or returns undefined.
 *
 * @param {*} val
 * @returns {string|undefined}
 */
function toCleanString(val) {
    if (val === undefined || val === null) return undefined;
    const str = String(val).trim();
    return str === '' ? undefined : str;
}

/**
 * Parses a pagination / list query into the options the model expects.
 *
 * @param {object} query
 * @returns {object}
 */
function listOptions(query) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.max(1, Math.min(Number(query.limit) || 25, MAX_LIMIT));

    return {
        search: toCleanString(query.search),
        asset_id: Number(query.asset_id) || undefined,
        code_type: toCleanString(query.code_type),
        label_status: toCleanString(query.label_status),
        department: toCleanString(query.department),
        location: toCleanString(query.location),
        scan_result: toCleanString(query.scan_result),
        scan_purpose: toCleanString(query.scan_purpose),
        verification_id: Number(query.verification_id) || undefined,
        from: toCleanString(query.from),
        to: toCleanString(query.to),
        limit,
        offset: (page - 1) * limit,
        page,
        sort: toCleanString(query.sort),
        order: toCleanString(query.order)
    };
}

/**
 * Builds the standard paginated response envelope.
 *
 * @param {object[]} rows
 * @param {number} total
 * @param {number} page
 * @param {number} limit
 * @returns {object}
 */
function pageData(rows, total, page, limit) {
    return {
        items: rows,
        pagination: {
            total,
            page,
            limit,
            total_pages: Math.max(1, Math.ceil(total / limit))
        }
    };
}

/**
 * Generates the scan code printed on an asset label.
 *
 * Format: NBSZ-<8 hex> e.g. NBSZ-3F9A2C7B.
 *
 * The code is deliberately opaque rather than "NBSZ-<asset tag>": section 10
 * requires that a scan not expose sensitive information, and an asset tag often
 * encodes the department or an internal sequence. An opaque token also means a
 * label can be reprinted without the underlying asset tag becoming guessable
 * from a photographed sticker.
 *
 * Uniqueness is verified against the register by `mintCode`, so a collision is
 * simply retried.
 *
 * @returns {string}
 */
function generateCodeValue() {
    const hex = crypto
        .randomBytes(4)
        .toString('hex')
        .toUpperCase();
    return `NBSZ-${hex}`;
}

/**
 * Produces a code that is not already used by any asset.
 *
 * @param {number} [excludeAssetId] Allow this asset's own current code.
 * @returns {Promise<string>}
 */
async function mintUniqueCode(excludeAssetId) {
    // 8 hex characters give ~4.3 billion values, so a collision is rare; the
    // loop is bounded so a pathological register cannot hang the request.
    for (let attempt = 0; attempt < 25; attempt += 1) {
        const candidate = generateCodeValue();
        // eslint-disable-next-line no-await-in-loop
        const owner = await barcodeModel.findCodeOwner(candidate, excludeAssetId);
        if (!owner) return candidate;
    }

    const err = new Error(
        'Could not generate a unique barcode value. Please try again.'
    );
    err.status = 500;
    throw err;
}

/**
 * Validates and normalises a label payload.
 *
 * @param {object} body
 * @param {object} [opts]
 * @param {boolean} [opts.partial] Skip required-field checks.
 * @returns {{errors: object[], values: object}}
 */
function validateLabelPayload(body, opts = {}) {
    body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const errors = [];
    const values = {};

    const codeValue = toCleanString(body.code_value);
    if (codeValue !== undefined) {
        if (codeValue.length > 255) {
            errors.push({
                field: 'code_value',
                message: 'Code value must be 255 characters or fewer.'
            });
        } else {
            values.code_value = codeValue;
        }
    }

    const codeType = toCleanString(body.code_type);
    if (codeType !== undefined) {
        if (!CODE_TYPES.includes(codeType)) {
            errors.push({
                field: 'code_type',
                message: `Code type must be one of: ${CODE_TYPES.join(', ')}.`
            });
        } else {
            values.code_type = codeType;
        }
    } else if (!opts.partial) {
        values.code_type = 'QR Code';
    }

    const symbology = toCleanString(body.symbology);
    if (symbology !== undefined) {
        if (!SYMBOLOGIES.includes(symbology)) {
            errors.push({
                field: 'symbology',
                message: `Symbology must be one of: ${SYMBOLOGIES.join(', ')}.`
            });
        } else {
            values.symbology = symbology;
        }
    }

    const labelStatus = toCleanString(body.label_status);
    if (labelStatus !== undefined) {
        if (!LABEL_STATUSES.includes(labelStatus)) {
            errors.push({
                field: 'label_status',
                message: `Label status must be one of: ${LABEL_STATUSES.join(', ')}.`
            });
        } else {
            values.label_status = labelStatus;
        }
    }

    const condition = toCleanString(body.label_condition);
    if (condition !== undefined) {
        if (!LABEL_CONDITIONS.includes(condition)) {
            errors.push({
                field: 'label_condition',
                message: `Label condition must be one of: ${LABEL_CONDITIONS.join(', ')}.`
            });
        } else {
            values.label_condition = condition;
        }
    }

    if (body.label_reference !== undefined) {
        values.label_reference = toCleanString(body.label_reference) || null;
    }
    if (body.notes !== undefined) {
        values.notes = toCleanString(body.notes) || null;
    }

    return { errors, values };
}

/* -------------------------------------------------------------------------- */
/* Reference data                                                              */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/barcode/meta
 * ENUM choices and pick-lists for the barcode screens.
 */
async function getBarcodeMeta(req, res) {
    const [categories] = await db.query(
        'SELECT id, name FROM asset_categories ORDER BY name'
    );

    const [departments] = await db.query(
        `SELECT DISTINCT department FROM assets
          WHERE department IS NOT NULL AND department <> ''
          ORDER BY department`
    );

    const [locations] = await db.query(
        `SELECT DISTINCT location FROM assets
          WHERE location IS NOT NULL AND location <> ''
          ORDER BY location`
    );

    return res.json(
        successResponse('Barcode reference data retrieved successfully.', {
            code_types: CODE_TYPES,
            label_statuses: LABEL_STATUSES,
            label_conditions: LABEL_CONDITIONS,
            scan_results: SCAN_RESULTS,
            scan_purposes: SCAN_PURPOSES,
            symbologies: SYMBOLOGIES,
            code_prefix: 'NBSZ-',
            categories: categories.map((c) => ({ id: c.id, name: c.name })),
            departments: departments.map((d) => d.department),
            locations: locations.map((l) => l.location)
        })
    );
}

/**
 * GET /api/barcode/stats
 * Label coverage figures for the dashboard tiles.
 */
async function getBarcodeStats(req, res) {
    const [[assets]] = await db.query(
        `SELECT
            COUNT(*) AS total_assets,
            SUM(CASE WHEN qr_code_value IS NOT NULL AND qr_code_value <> ''
                     THEN 1 ELSE 0 END) AS assets_with_code
           FROM assets`
    );

    const [[labels]] = await db.query(
        `SELECT
            COUNT(*) AS total_labels,
            SUM(CASE WHEN label_status = 'Active' THEN 1 ELSE 0 END) AS active_labels,
            SUM(CASE WHEN label_status = 'Damaged' THEN 1 ELSE 0 END) AS damaged_labels,
            SUM(CASE WHEN label_status = 'Lost' THEN 1 ELSE 0 END) AS lost_labels,
            SUM(CASE WHEN label_status = 'Replaced' THEN 1 ELSE 0 END) AS replaced_labels,
            SUM(print_count) AS total_prints
           FROM asset_barcode_labels`
    );

    const [[scans]] = await db.query(
        `SELECT
            COUNT(*) AS total_scans,
            SUM(CASE WHEN scan_result = 'Matched' THEN 1 ELSE 0 END) AS matched_scans,
            SUM(CASE WHEN scan_result = 'Unknown Code' THEN 1 ELSE 0 END) AS unknown_scans,
            SUM(CASE WHEN DATE(scanned_at) = CURDATE() THEN 1 ELSE 0 END) AS scans_today
           FROM asset_scan_events`
    );

    const totalAssets = Number(assets.total_assets) || 0;
    const withCode = Number(assets.assets_with_code) || 0;
    const coverage = totalAssets
        ? Math.round((withCode / totalAssets) * 1000) / 10
        : 0;

    // Label types actually in use, so the screen can show where QR and where
    // barcode has been rolled out.
    const [byType] = await db.query(
        `SELECT code_type, COUNT(*) AS total
           FROM asset_barcode_labels
          GROUP BY code_type
          ORDER BY total DESC`
    );

    const num = (v) => Number(v) || 0;

    return res.json(
        successResponse('Barcode statistics retrieved successfully.', {
            assets: {
                total: totalAssets,
                with_code: withCode,
                without_code: totalAssets - withCode,
                coverage_percent: coverage
            },
            labels: {
                total: num(labels.total_labels),
                active: num(labels.active_labels),
                damaged: num(labels.damaged_labels),
                lost: num(labels.lost_labels),
                replaced: num(labels.replaced_labels),
                total_prints: num(labels.total_prints)
            },
            scans: {
                total: num(scans.total_scans),
                matched: num(scans.matched_scans),
                unknown: num(scans.unknown_scans),
                today: num(scans.scans_today)
            },
            by_code_type: byType.map((r) => ({
                code_type: r.code_type,
                total: Number(r.total)
            }))
        })
    );
}

/**
 * GET /api/barcode/coverage
 * Lists register assets that do not yet have an active barcode label row.
 * (acceptance criterion 6)
 */
async function getBarcodeCoverage(req, res) {
    const opts = listOptions(req.query);
    const missingOnly = normalizeString(req.query.missing_only) !== 'false';

    const where = ["a.status NOT IN ('Disposed', 'Retired')"];
    const params = [];

    if (missingOnly) {
        where.push("(l.id IS NULL OR a.qr_code_value IS NULL OR a.qr_code_value = '')");
    }
    if (opts.search) {
        const like = `%${opts.search}%`;
        where.push('(a.asset_tag LIKE ? OR a.serial_number LIKE ? OR c.name LIKE ?)');
        params.push(like, like, like);
    }
    if (opts.department) {
        where.push('a.department = ?');
        params.push(opts.department);
    }
    if (opts.location) {
        where.push('a.location = ?');
        params.push(opts.location);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [[count]] = await db.query(
        `SELECT COUNT(DISTINCT a.id) AS total
           FROM assets a
           LEFT JOIN asset_categories c ON c.id = a.category_id
           LEFT JOIN asset_barcode_labels l ON l.asset_id = a.id AND l.label_status = 'Active'
           ${whereSql}`,
        params
    );

    const [rows] = await db.query(
        `SELECT a.id, a.asset_id, a.asset_tag, a.serial_number, a.manufacturer,
                a.model, a.department, a.location, a.status, a.qr_code_value,
                MAX(c.name) AS category_name,
                COALESCE(MAX(c.name), 'ICT Asset') AS asset_type,
                MAX(l.label_ref) AS label_ref,
                MAX(l.code_value) AS active_label_code,
                MAX(CASE WHEN l.id IS NOT NULL THEN 1 ELSE 0 END) AS has_active_label
           FROM assets a
           LEFT JOIN asset_categories c ON c.id = a.category_id
           LEFT JOIN asset_barcode_labels l ON l.asset_id = a.id AND l.label_status = 'Active'
           ${whereSql}
          GROUP BY a.id, a.asset_id, a.asset_tag, a.serial_number, a.manufacturer,
                   a.model, a.department, a.location, a.status, a.qr_code_value
          ORDER BY a.asset_tag
          LIMIT ? OFFSET ?`,
        [...params, opts.limit, opts.offset]
    );

    const total = Number(count.total) || 0;

    return res.json(
        successResponse('Barcode coverage retrieved successfully.', {
            items: rows,
            pagination: {
                total,
                page: opts.page,
                limit: opts.limit,
                total_pages: Math.max(1, Math.ceil(total / opts.limit))
            }
        })
    );
}

/* -------------------------------------------------------------------------- */
/* Label CRUD                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * GET /api/barcode
 * List / search / filter the label register.
 */
async function getAllLabels(req, res) {
    const opts = listOptions(req.query);
    const { rows, total } = await barcodeModel.findAllLabels(opts);

    return res.json(
        successResponse(
            'Barcode labels retrieved successfully.',
            pageData(rows, total, opts.page, opts.limit)
        )
    );
}

/**
 * GET /api/barcode/:id
 * Fetch one label by numeric id or LBL- reference.
 */
async function getLabelById(req, res) {
    const label = await barcodeModel.findLabel(req.params.id);

    if (!label) {
        return res
            .status(404)
            .json(errorResponse('Barcode label not found.'));
    }

    return res.json(
        successResponse('Barcode label retrieved successfully.', label)
    );
}

/**
 * GET /api/barcode/asset/:assetId
 * One asset's active label plus its full label history.
 */
async function getAssetLabel(req, res) {
    const assetId = Number(req.params.assetId);

    if (!Number.isInteger(assetId) || assetId <= 0) {
        return res
            .status(400)
            .json(errorResponse('A valid asset id is required.'));
    }

    const asset = await assetModel.findById(assetId);

    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const label = await barcodeModel.findPrimaryLabelForAsset(assetId);
    const history = await barcodeModel.findLabelsForAsset(assetId);
    const { rows: scans } = await barcodeModel.findAllScans({
        asset_id: assetId,
        limit: 20,
        offset: 0
    });

    return res.json(
        successResponse('Asset barcode details retrieved successfully.', {
            asset: {
                id: asset.id,
                asset_id: asset.asset_id,
                asset_tag: asset.asset_tag,
                asset_type: asset.category_name || asset.asset_type || 'ICT Asset',
                category_name: asset.category_name,
                serial_number: asset.serial_number,
                manufacturer: asset.manufacturer,
                model: asset.model,
                department: asset.department,
                location: asset.location,
                status: asset.status,
                qr_code_value: asset.qr_code_value
            },
            label,
            source: label ? 'barcode_register' : 'asset_register',
            history,
            recent_scans: scans
        })
    );
}

/**
 * PUT / PATCH /api/barcode/:id
 * Correct the descriptive details of a label (status, condition, reference,
 * notes, symbology). The encoded value itself is never editable: changing what
 * is printed on an existing sticker would invalidate the physical label.
 */
async function updateLabel(req, res) {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res
            .status(400)
            .json(errorResponse('A valid label id is required.'));
    }

    const existing = await barcodeModel.findLabel(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Barcode label not found.'));
    }

    const { errors, values } = validateLabelPayload(req.body, { partial: true });

    if (errors.length) {
        return res
            .status(400)
            .json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const fields = {};
    Object.keys(values).forEach((k) => {
        if (values[k] !== undefined) fields[k] = values[k];
    });

    if (!Object.keys(fields).length) {
        return res
            .status(400)
            .json(errorResponse('No updatable fields were supplied.'));
    }

    await barcodeModel.updateLabel(id, fields);

    const updated = await barcodeModel.findLabel(id);

    await auditLog({
        userId: req.user.id,
        action: 'UPDATE',
        tableName: LABEL_TABLE,
        recordId: id,
        oldValues: {
            label_status: existing.label_status,
            label_condition: existing.label_condition,
            label_reference: existing.label_reference,
            symbology: existing.symbology
        },
        newValues: fields,
        ipAddress: getClientIp(req)
    });

    return res.json(
        successResponse('Barcode label updated successfully.', updated)
    );
}

/* -------------------------------------------------------------------------- */
/* Code generation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Mints a code for one asset and opens a label row for it.
 *
 * Shared by the single-asset and bulk endpoints so both behave identically.
 *
 * @param {object} asset   The register row.
 * @param {object} payload Validated options (code_type, symbology, ...).
 * @param {number} userId  Acting user.
 * @returns {Promise<object>} Summary of the label that was issued.
 */
async function issueLabelForAsset(asset, payload, userId, previousLabelStatus = 'Replaced') {
    const codeValue = payload.code_value
        ? payload.code_value
        : await mintUniqueCode();

    const owner = await barcodeModel.findCodeOwner(codeValue, asset.id);
    if (owner) {
        const err = new Error(
            `The code ${codeValue} is already assigned to asset ${owner.asset_tag}.`
        );
        err.status = 409;
        throw err;
    }

    await barcodeModel.retireLabelsForAsset(asset.id, previousLabelStatus);

    await assetModel.update(asset.id, { qrCodeValue: codeValue, qr_code_value: codeValue });

    const labelRef = await barcodeModel.nextLabelRef();

    const labelId = await barcodeModel.createLabel({
        label_ref: labelRef,
        asset_id: asset.id,
        code_value: codeValue,
        code_type: payload.code_type || 'QR Code',
        symbology: payload.symbology || 'QR',
        label_reference: payload.label_reference || null,
        label_status: 'Active',
        label_condition: 'Good',
        print_count: 1,
        last_printed_at: new Date(),
        last_printed_by: userId,
        is_primary: 1,
        notes: payload.notes || null,
        issued_by: userId
    });

    return {
        asset_id: asset.id,
        asset_tag: asset.asset_tag,
        code_value: codeValue,
        label_ref: labelRef,
        label_id: labelId
    };
}

/**
 * POST /api/barcode/asset/:assetId/generate
 * Mint a code for one asset (acceptance criterion 6).
 */
async function generateAssetCode(req, res) {
    const assetId = Number(req.params.assetId);
    const body = req.body || {};

    if (!Number.isInteger(assetId) || assetId <= 0) {
        return res
            .status(400)
            .json(errorResponse('A valid asset id is required.'));
    }

    const asset = await assetModel.findById(assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    if (['Disposed', 'Retired'].includes(asset.status) &&
        normalizeString(body.force) !== 'true') {
        return res
            .status(400)
            .json(
                errorResponse(
                    `Asset ${asset.asset_tag} is ${asset.status} and does not normally need a label. ` +
                    'Send force=true to label it anyway for historical tracing.'
                )
            );
    }

    const { errors, values } = validateLabelPayload(body, { partial: true });
    if (errors.length) {
        return res
            .status(400)
            .json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const result = await issueLabelForAsset(asset, values, req.user.id);

    await auditLog({
        userId: req.user.id,
        action: 'CREATE',
        tableName: LABEL_TABLE,
        recordId: result.label_id,
        newValues: {
            asset_id: asset.id,
            asset_tag: asset.asset_tag,
            code_value: result.code_value,
            label_ref: result.label_ref
        },
        ipAddress: getClientIp(req)
    });

    const label = await barcodeModel.findLabel(result.label_id);

    return res
        .status(201)
        .json(
            successResponse(
                `Barcode ${result.code_value} issued for ${asset.asset_tag}.`,
                label
            )
        );
}

/**
 * POST /api/barcode/generate
 * Mint codes for many assets in one pass - the bulk rollout path.
 */
async function generateBulkCodes(req, res) {
    const body = req.body || {};
    const raw = Array.isArray(body.asset_ids) ? body.asset_ids : [];

    if (!raw.length) {
        return res
            .status(400)
            .json(errorResponse('Supply an asset_ids array with at least one asset.'));
    }

    if (raw.length > MAX_BULK_GENERATE) {
        return res
            .status(400)
            .json(
                errorResponse(
                    `A single request may generate at most ${MAX_BULK_GENERATE} codes. ` +
                    `${raw.length} were requested.`
                )
            );
    }

    const ids = [...new Set(raw.map(Number))];

    if (!ids.length || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        return res
            .status(400)
            .json(errorResponse('asset_ids must contain valid numeric asset ids.'));
    }

    const { errors, values } = validateLabelPayload(body, { partial: true });
    if (errors.length) {
        return res
            .status(400)
            .json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const generated = [];
    const failed = [];

    for (const id of ids) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const asset = await assetModel.findById(id);

            if (!asset) {
                failed.push({ asset_id: id, reason: 'Asset not found.' });
                continue;
            }

            // eslint-disable-next-line no-await-in-loop
            const result = await issueLabelForAsset(asset, values, req.user.id);
            generated.push(result);
        } catch (err) {
            if (err.status !== 409) {
                throw err;
            }
            failed.push({ asset_id: id, reason: err.message });
        }
    }

    await auditLog({
        userId: req.user.id,
        action: 'BULK_CREATE',
        tableName: LABEL_TABLE,
        recordId: null,
        newValues: {
            requested: ids.length,
            generated: generated.length,
            failed: failed.length
        },
        ipAddress: getClientIp(req)
    });

    return res.status(generated.length ? 201 : 400).json(
        successResponse(
            `${generated.length} barcode(s) issued` +
            (failed.length ? `, ${failed.length} failed.` : '.'),
            { generated, failed, requested: ids.length }
        )
    );
}

/* -------------------------------------------------------------------------- */
/* Printing and replacement (§5.8 printable label reference)                   */
/* -------------------------------------------------------------------------- */

/**
 * POST /api/barcode/asset/:assetId/print
 * Records a print run for an asset's active label.
 */
async function recordLabelPrint(req, res) {
    const assetId = Number(req.params.assetId);

    if (!Number.isInteger(assetId) || assetId <= 0) {
        return res
            .status(400)
            .json(errorResponse('A valid asset id is required.'));
    }

    const label = await barcodeModel.findPrimaryLabelForAsset(assetId);

    if (!label) {
        return res
            .status(404)
            .json(
                errorResponse(
                    'This asset has no active barcode label. Generate one first.'
                )
            );
    }

    if (label.label_status !== 'Active') {
        return res
            .status(409)
            .json(errorResponse('Only active barcode labels can be printed.'));
    }

    await barcodeModel.recordPrint(label.id, req.user.id);

    const updated = await barcodeModel.findLabel(label.id);

    await auditLog({
        userId: req.user.id,
        action: 'PRINT',
        tableName: LABEL_TABLE,
        recordId: label.id,
        oldValues: { print_count: label.print_count },
        newValues: { print_count: updated.print_count },
        ipAddress: getClientIp(req)
    });

    return res.json(
        successResponse(
            `Print recorded for ${updated.code_value} (${updated.print_count} total).`,
            {
                label: updated,
                printable: {
                    code_value: updated.code_value,
                    code_type: updated.code_type,
                    symbology: updated.symbology,
                    asset_tag: updated.asset_tag,
                    asset_type: updated.asset_type || updated.category_name || 'ICT Asset',
                    category_name: updated.category_name,
                    serial_number: updated.serial_number,
                    manufacturer: updated.manufacturer,
                    model: updated.model,
                    department: updated.department,
                    location: updated.location,
                    label_reference: updated.label_reference,
                    printed_on: today()
                }
            }
        )
    );
}

/**
 * POST /api/barcode/label/:id/replace
 * Retire a damaged or lost label and issue a fresh code for the same asset.
 */
async function replaceLabel(req, res) {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
        return res
            .status(400)
            .json(errorResponse('A valid label id is required.'));
    }

    const existing = await barcodeModel.findLabel(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Barcode label not found.'));
    }

    const body = req.body || {};
    const keepCode = normalizeString(body.keep_code) === 'true';
    const reason = toCleanString(body.label_status) || 'Replaced';

    if (!['Damaged', 'Lost', 'Retired', 'Replaced'].includes(reason)) {
        return res
            .status(400)
            .json(
                errorResponse(
                    'label_status must be Damaged, Lost, Retired or Replaced for a replacement.'
                )
            );
    }

    const { errors, values } = validateLabelPayload(body, { partial: true });
    if (errors.length) {
        return res
            .status(400)
            .json(errorResponse('Please correct the highlighted fields.', errors));
    }

    let asset = null;
    const numericAssetId = Number(existing.asset_id);
    if (Number.isInteger(numericAssetId) && numericAssetId > 0) {
        asset = await assetModel.findById(numericAssetId);
    }
    if (!asset && existing.asset_code) {
        asset = await assetModel.findByAssetId(existing.asset_code);
    }
    if (!asset && existing.asset_tag) {
        asset = await assetModel.findByAssetTag(existing.asset_tag);
    }

    if (!asset) {
        return res
            .status(404)
            .json(errorResponse('The asset this label belongs to no longer exists.'));
    }

    const payload = {
        ...values,
        code_type: values.code_type || existing.code_type,
        symbology: values.symbology || existing.symbology,
        code_value: keepCode ? existing.code_value : values.code_value
    };

    const result = await issueLabelForAsset(asset, payload, req.user.id, reason);

    await auditLog({
        userId: req.user.id,
        action: 'REPLACE',
        tableName: LABEL_TABLE,
        recordId: result.label_id,
        oldValues: {
            label_id: existing.id,
            label_ref: existing.label_ref,
            code_value: existing.code_value,
            label_status: reason
        },
        newValues: {
            label_id: result.label_id,
            label_ref: result.label_ref,
            code_value: result.code_value
        },
        ipAddress: getClientIp(req)
    });

    const label = await barcodeModel.findLabel(result.label_id);

    return res
        .status(201)
        .json(
            successResponse(
                `Label replaced for ${asset.asset_tag}. New code ${result.code_value}.`,
                { label, retired: { id: existing.id, label_ref: existing.label_ref, reason } }
            )
        );
}

/* -------------------------------------------------------------------------- */
/* Scanning (§5.8)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolves a scanned code and optionally logs the scan event.
 */
async function resolveScan(req, res, logEvent) {
    const rawCode = (req.body && req.body.code) || req.params.code || '';
    const codeValue = String(rawCode).trim();

    if (!codeValue) {
        return res
            .status(400)
            .json(errorResponse('A scanned code value is required.'));
    }

    const purpose =
        toCleanString(req.body && req.body.scan_purpose) || 'Identification';

    if (!SCAN_PURPOSES.includes(purpose)) {
        return res
            .status(400)
            .json(
                errorResponse(
                    `scan_purpose must be one of: ${SCAN_PURPOSES.join(', ')}.`
                )
            );
    }

    const asset = await barcodeModel.findAssetByCode(codeValue);

    let scanResult = 'Matched';
    if (!asset) {
        scanResult = 'Unknown Code';
    } else if (['Disposed', 'Retired'].includes(asset.status)) {
        scanResult = 'Retired Asset';
    }

    let scanId = null;
    if (logEvent) {
        const scanRef = await barcodeModel.nextScanRef();
        scanId = await barcodeModel.createScanEvent({
            scan_ref: scanRef,
            asset_id: asset ? asset.id : null,
            code_value: codeValue,
            scan_result: scanResult,
            scan_purpose: purpose,
            scan_location:
                toCleanString(req.body && req.body.scan_location) ||
                (asset ? asset.location : null),
            device_info: toCleanString(req.body && req.body.device_info) || null,
            verification_id: Number(req.body && req.body.verification_id) || null,
            scanned_by: req.user.id
        });
    }

    if (!asset) {
        return res.status(404).json(
            errorResponse(
                `No asset is registered against the code ${codeValue}.`
            )
        );
    }

    const payload = {
        asset: {
            id: asset.id,
            asset_id: asset.asset_id,
            asset_tag: asset.asset_tag,
            asset_type: asset.asset_type || asset.category_name || 'ICT Asset',
            serial_number: asset.serial_number,
            manufacturer: asset.manufacturer,
            model: asset.model,
            category_name: asset.category_name,
            department: asset.department,
            location: asset.location,
            status: asset.status,
            condition_status: asset.condition_status,
            assigned_user_name: asset.assigned_user_name || null,
            registered_date: asset.date_registered || null,
            date_registered: asset.date_registered || null,
            qr_code_value: asset.qr_code_value
        },
        scan_result: scanResult,
        scan_ref: null
    };

    if (scanId) {
        const scan = await barcodeModel.findScan(scanId);
        payload.scan_ref = scan ? scan.scan_ref : null;
        payload.scan_id = scanId;
    }

    const message =
        scanResult === 'Retired Asset'
            ? `Asset ${asset.asset_tag} is ${asset.status} - it is no longer in service.`
            : `Asset ${asset.asset_tag} identified.`;

    return res.json(successResponse(message, payload));
}

/**
 * GET /api/barcode/lookup/:code
 * Resolve a code without writing a scan event (a read-only peek).
 */
async function lookupCode(req, res) {
    return resolveScan(req, res, false);
}

/**
 * POST /api/barcode/scan
 * Resolve a code and record the scan event (the scanner workflow).
 */
async function scanCode(req, res) {
    return resolveScan(req, res, true);
}

/**
 * GET /api/barcode/scans
 * Scan history with filters.
 */
async function getScanEvents(req, res) {
    const opts = listOptions(req.query);
    const { rows, total } = await barcodeModel.findAllScans(opts);

    return res.json(
        successResponse(
            'Scan history retrieved successfully.',
            pageData(rows, total, opts.page, opts.limit)
        )
    );
}

/**
 * GET /api/barcode/scans/:id
 * One scan event by id or SCN- reference.
 */
async function getScanEventById(req, res) {
    const scan = await barcodeModel.findScan(req.params.id);

    if (!scan) {
        return res.status(404).json(errorResponse('Scan event not found.'));
    }

    return res.json(successResponse('Scan event retrieved successfully.', scan));
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                     */
/* -------------------------------------------------------------------------- */

module.exports = {
    // Reference data
    getBarcodeMeta,
    getBarcodeStats,
    getBarcodeCoverage,

    // Labels
    getAllLabels,
    getLabelById,
    getAssetLabel,
    updateLabel,

    // Code generation
    generateAssetCode,
    generateBulkCodes,
    recordLabelPrint,
    replaceLabel,

    // Scanning
    lookupCode,
    scanCode,
    getScanEvents,
    getScanEventById,

    // Exported for unit testing / reuse by other modules.
    CODE_TYPES,
    LABEL_STATUSES,
    LABEL_CONDITIONS,
    SCAN_RESULTS,
    SCAN_PURPOSES,
    SYMBOLOGIES,
    READER_ROLES,
    WRITER_ROLES,
    generateCodeValue
};
