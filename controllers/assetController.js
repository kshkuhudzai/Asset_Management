'use strict';

// controllers/assetController.js
// Asset register: CRUD over `assets` plus the configurable `asset_categories`
// reference data and QR value generation.
//
// Endpoints
//   GET    /api/assets                      - list / search / filter + pagination
//   GET    /api/assets/stats                - aggregate counts for dashboards
//   GET    /api/assets/meta                 - ENUM choices + generated next ids
//   GET    /api/assets/scan/:qrValue        - resolve a scanned QR payload
//   GET    /api/assets/:id                  - fetch one asset
//   GET    /api/assets/:id/history          - audit timeline for one asset
//   POST   /api/assets                      - register a new asset
//   PUT    /api/assets/:id                  - full update
//   PATCH  /api/assets/:id                  - partial update
//   POST   /api/assets/:id/qr               - (re)generate the QR value
//   DELETE /api/assets/:id                  - disabled; use disposal approval
//
//   GET    /api/assets/categories           - list categories
//   GET    /api/assets/categories/:id       - fetch one category
//   POST   /api/assets/categories           - create a category
//   PUT    /api/assets/categories/:id       - rename / re-describe a category
//   DELETE /api/assets/categories/:id       - delete an unused category
//
// Conventions (mirrors authController):
//   * Handlers are async; Express 5 forwards rejected promises to the global
//     error handler, so no try/catch wrapper is needed for unexpected errors.
//   * Responses always use the shared { status, message, data } envelope.
//   * Assets are soft-deleted (status = 'Disposed') and never physically
//     removed, so the audit trail and assignment history stay intact.
//   * Every mutating handler writes an audit_logs row explicitly, including
//     the old/new values needed to reconstruct the change.

const assetModel = require('../models/assetModel');
const auditModel = require('../models/auditModel');
const { auditLog } = require('../middleware/auditMiddleware');
const { getClientIp, normalizeString, successResponse, errorResponse } = require('../utils/helpers');
const { parseCsv } = require('../utils/csv');

// Asset table name as it appears in audit_logs.table_name.
const ASSET_TABLE = 'assets';
const CATEGORY_TABLE = 'asset_categories';

// ENUM values from the database schema. Kept here so validation and the
// /meta endpoint share a single source of truth.
const ASSET_STATUSES = Object.freeze([
    'In Use',
    'In Stock',
    'Under Repair',
    'Missing',
    'Retired',
    'Disposed'
]);

const ASSET_CONDITIONS = Object.freeze(['Good', 'Fair', 'Damaged', 'Obsolete']);

// Asset-id prefixes per category slug. Unknown categories fall back to AST.
const ASSET_ID_PREFIXES = Object.freeze({
    'Desktop Computers': 'NBSZ-DKT-',
    'Laptops': 'NBSZ-LPT-',
    'Servers': 'NBSZ-SRV-',
    'Network Equipment': 'NBSZ-NET-',
    'Printers & Scanners': 'NBSZ-PRN-',
    'Mobile Devices': 'NBSZ-MOB-',
    'Storage Devices': 'NBSZ-STG-',
    'Peripherals': 'NBSZ-PER-',
    'Software & Licences': 'NBSZ-SFT-',
    'Uninterruptible Power Supplies': 'NBSZ-UPS-',
    'Other ICT Equipment': 'NBSZ-AST-'
});

const DEFAULT_ASSET_ID_PREFIX = 'NBSZ-AST-';
const IMPORT_COLUMNS = new Set([
    'asset_id',
    'asset_tag',
    'serial_number',
    'category_name',
    'manufacturer',
    'model',
    'purchase_date',
    'purchase_cost',
    'supplier',
    'po_invoice_ref',
    'warranty_provider',
    'warranty_start',
    'warranty_end',
    'warranty_ref',
    'location',
    'department',
    'assigned_user_id',
    'responsible_officer',
    'status',
    'condition_status',
    'last_inspection_date'
]);

// Longest value each VARCHAR column accepts - validated up-front so MySQL
// never silently truncates (or 1406-errors on) user input.
const MAX_LENGTHS = Object.freeze({
    assetId: 50,
    assetTag: 50,
    serialNumber: 100,
    manufacturer: 100,
    model: 100,
    supplier: 150,
    poInvoiceRef: 100,
    warrantyProvider: 150,
    warrantyRef: 100,
    location: 100,
    department: 100,
    responsibleOfficer: 100,
    qrCodeValue: 255
});

/**
 * Collects field-level validation errors into a `[{field, message}]` array.
 */
function pushError(errors, field, message) {
    errors.push({ field, message });
}

/**
 * True for a YYYY-MM-DD string that represents a real calendar date.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

/**
 * Normalises a nullable date field: '' / null / undefined -> null, a valid
 * YYYY-MM-DD string -> itself. Returns `undefined` for free-text values that
 * are not a date at all (they are ignored by the caller's error reporting).
 *
 * @param {*} value
 * @returns {string|null}
 */
function normalizeDate(value) {
    const text = normalizeString(value);
    return text === '' ? null : text;
}

/**
 * Normalises a nullable free-text field: '' / null -> null.
 *
 * @param {*} value
 * @returns {string|null}
 */
function normalizeOptionalString(value) {
    const text = normalizeString(value);
    return text === '' ? null : text;
}

/**
 * Parses an id from a request param / body value.
 *
 * @param {*} value
 * @returns {number|null}
 */
function parseId(value) {
    const numeric = parseInt(value, 10);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * Builds the asset-id prefix for a category name.
 *
 * @param {string|null} categoryName
 * @returns {string}
 */
function prefixForCategory(categoryName) {
    if (!categoryName) return DEFAULT_ASSET_ID_PREFIX;
    return ASSET_ID_PREFIXES[categoryName] || DEFAULT_ASSET_ID_PREFIX;
}



/**
 * Validates and normalises an asset payload.
 *
 * `isCreate` toggles the rules: on create, `asset_tag` is mandatory and a
 * missing `asset_id` is auto-generated; on update every field is optional and
 * only the supplied keys are returned.
 *
 * @param {object} body Raw req.body.
 * @param {object} [options]
 * @param {boolean} [options.isCreate=false]
 * @param {object|null} [options.category] Resolved category row (for prefixing).
 * @returns {{errors: object[], data: object}}
 */
function validateAssetPayload(body, { isCreate = false, category = null } = {}) {
    const errors = [];
    const data = {};

    /* --------------------------- Required fields --------------------------- */

    // asset_tag: mandatory on create (it is the physical label).
    if (isCreate || body.asset_tag !== undefined) {
        const assetTag = normalizeString(body.asset_tag);
        if (!assetTag) {
            pushError(errors, 'asset_tag', 'Asset tag is required.');
        } else if (assetTag.length > MAX_LENGTHS.assetTag) {
            pushError(errors, 'asset_tag', `Asset tag must be ${MAX_LENGTHS.assetTag} characters or fewer.`);
        } else {
            data.assetTag = assetTag;
        }
    }

    // asset_id: optional on create (auto-generated), immutable once set.
    if (body.asset_id !== undefined) {
        const assetId = normalizeString(body.asset_id);
        if (assetId.length > MAX_LENGTHS.assetId) {
            pushError(errors, 'asset_id', `Asset ID must be ${MAX_LENGTHS.assetId} characters or fewer.`);
        } else if (assetId) {
            data.assetId = assetId;
        }
    }

    /* --------------------------- Simple strings ---------------------------- */

    const stringFields = [
        ['serial_number', 'serialNumber'],
        ['manufacturer', 'manufacturer'],
        ['model', 'model'],
        ['supplier', 'supplier'],
        ['po_invoice_ref', 'poInvoiceRef'],
        ['warranty_provider', 'warrantyProvider'],
        ['warranty_ref', 'warrantyRef'],
        ['location', 'location'],
        ['department', 'department'],
        ['responsible_officer', 'responsibleOfficer'],
        ['qr_code_value', 'qrCodeValue']
    ];

    for (const [bodyKey, dataKey] of stringFields) {
        if (body[bodyKey] === undefined) continue;

        const value = normalizeOptionalString(body[bodyKey]);
        if (value && value.length > MAX_LENGTHS[dataKey]) {
            pushError(errors, bodyKey, `${bodyKey} must be ${MAX_LENGTHS[dataKey]} characters or fewer.`);
        } else {
            data[dataKey] = value;
        }
    }


    /* ------------------------------- Dates --------------------------------- */

    const dateFields = [
        ['purchase_date', 'purchaseDate'],
        ['warranty_start', 'warrantyStart'],
        ['warranty_end', 'warrantyEnd'],
        ['last_inspection_date', 'lastInspectionDate']
    ];

    for (const [bodyKey, dataKey] of dateFields) {
        if (body[bodyKey] === undefined) continue;

        const value = normalizeDate(body[bodyKey]);
        if (value !== null && !isValidDate(value)) {
            pushError(errors, bodyKey, `${bodyKey} must be a valid date in YYYY-MM-DD format.`);
        } else {
            data[dataKey] = value;
        }
    }

    // Business rule: a warranty cannot end before it starts.
    const start = data.warrantyStart;
    const end = data.warrantyEnd;
    if (start && end && end < start) {
        pushError(errors, 'warranty_end', 'warranty_end cannot be earlier than warranty_start.');
    }

    /* ------------------------------ Numbers -------------------------------- */

    if (body.purchase_cost !== undefined) {
        const raw = normalizeString(body.purchase_cost);
        if (raw === '') {
            data.purchaseCost = null;
        } else {
            const cost = Number(raw);
            if (!Number.isFinite(cost)) {
                pushError(errors, 'purchase_cost', 'purchase_cost must be a number.');
            } else if (cost < 0) {
                pushError(errors, 'purchase_cost', 'purchase_cost cannot be negative.');
            } else if (cost > 9999999999999.99) {
                pushError(errors, 'purchase_cost', 'purchase_cost is too large.');
            } else {
                data.purchaseCost = cost;
            }
        }
    }

    /* -------------------------- Ids & ENUM fields -------------------------- */

    if (body.category_id !== undefined) {
        const raw = body.category_id;
        if (raw === null || raw === '') {
            data.categoryId = null;
        } else {
            const categoryId = parseId(raw);
            if (categoryId === null) {
                pushError(errors, 'category_id', 'category_id must be a positive integer.');
            } else {
                data.categoryId = categoryId;
            }
        }
    } else if (isCreate && category) {
        // Convenience: supplying a known category name implies its id.
        data.categoryId = category.id;
    }

    if (body.assigned_user_id !== undefined) {
        const raw = body.assigned_user_id;
        if (raw === null || raw === '') {
            data.assignedUserId = null;
        } else {
            const userId = parseId(raw);
            if (userId === null) {
                pushError(errors, 'assigned_user_id', 'assigned_user_id must be a positive integer.');
            } else {
                data.assignedUserId = userId;
            }
        }
    }

    if (body.status !== undefined) {
        const status = normalizeString(body.status);
        if (!ASSET_STATUSES.includes(status)) {
            pushError(errors, 'status', `status must be one of: ${ASSET_STATUSES.join(', ')}.`);
        } else {
            data.status = status;
        }
    }

    if (body.condition_status !== undefined) {
        const condition = normalizeString(body.condition_status);
        if (!ASSET_CONDITIONS.includes(condition)) {
            pushError(
                errors,
                'condition_status',
                `condition_status must be one of: ${ASSET_CONDITIONS.join(', ')}.`
            );
        } else {
            data.conditionStatus = condition;
        }
    }

    return { errors, data };
}

/* ========================================================================== */
/* GET /api/assets                                                            */
/* ========================================================================== */

/**
 * Lists the asset register with search, filters, sorting and pagination.
 *
 * Query: ?search=&category_id=&status=&condition_status=&location=
 *        &department=&assigned_user_id=&include_disposed=true
 *        &warranty_expiring_before=YYYY-MM-DD&sort_by=&sort_dir=&limit=&offset=
 */
async function getAllAssets(req, res) {
    const errors = [];

    const categoryId = req.query.category_id ? parseId(req.query.category_id) : null;
    if (req.query.category_id && categoryId === null) {
        pushError(errors, 'category_id', 'category_id must be a positive integer.');
    }

    const assignedUserId = req.query.assigned_user_id ? parseId(req.query.assigned_user_id) : null;
    if (req.query.assigned_user_id && assignedUserId === null) {
        pushError(errors, 'assigned_user_id', 'assigned_user_id must be a positive integer.');
    }

    const status = normalizeString(req.query.status) || undefined;
    if (status && !ASSET_STATUSES.includes(status)) {
        pushError(errors, 'status', `status must be one of: ${ASSET_STATUSES.join(', ')}.`);
    }

    const conditionStatus = normalizeString(req.query.condition_status) || undefined;
    if (conditionStatus && !ASSET_CONDITIONS.includes(conditionStatus)) {
        pushError(
            errors,
            'condition_status',
            `condition_status must be one of: ${ASSET_CONDITIONS.join(', ')}.`
        );
    }

    const warrantyExpiringBefore = normalizeString(req.query.warranty_expiring_before) || undefined;
    if (warrantyExpiringBefore && !isValidDate(warrantyExpiringBefore)) {
        pushError(
            errors,
            'warranty_expiring_before',
            'warranty_expiring_before must be a valid date in YYYY-MM-DD format.'
        );
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    // Disposed assets are hidden unless explicitly requested.
    const includeDisposed = ['true', '1', 'yes'].includes(
        String(req.query.include_disposed || '').toLowerCase()
    );

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { assets, total } = await assetModel.findAll({
        search: normalizeString(req.query.search) || undefined,
        categoryId,
        status,
        conditionStatus,
        location: normalizeString(req.query.location) || undefined,
        department: normalizeString(req.query.department) || undefined,
        assignedUserId,
        excludeDisposed: !includeDisposed,
        warrantyExpiringBefore,
        sortBy: normalizeString(req.query.sort_by) || 'date_registered',
        sortDir: normalizeString(req.query.sort_dir) || 'desc',
        limit,
        offset
    });

    return res.status(200).json(
        successResponse('Assets retrieved successfully.', {
            assets,
            pagination: {
                total,
                limit,
                offset,
                returned: assets.length
            }
        })
    );
}

/* ========================================================================== */
/* GET /api/assets/stats                                                      */
/* ========================================================================== */

/**
 * Aggregate register counts used by the dashboard and summary tiles.
 */
async function getAssetStats(req, res) {
    const stats = await assetModel.getStats();

    return res
        .status(200)
        .json(successResponse('Asset statistics retrieved successfully.', stats));
}

/* ========================================================================== */
/* GET /api/assets/meta                                                       */
/* ========================================================================== */

/**
 * Reference data for building the register UI: the two ENUM lists, the
 * category pick-list and the next asset id for each category prefix.
 */
async function getAssetMeta(req, res) {
    const categories = await assetModel.findCategories({ withAssetCounts: true });

    // Next id per distinct prefix actually in use for these categories.
    const prefixes = [...new Set(categories.map((category) => prefixForCategory(category.name)))];
    const nextAssetIds = {};
    for (const prefix of prefixes) {
        nextAssetIds[prefix] = await assetModel.generateNextAssetId(prefix);
    }

    return res.status(200).json(
        successResponse('Asset reference data retrieved successfully.', {
            statuses: [...ASSET_STATUSES],
            conditions: [...ASSET_CONDITIONS],
            categories,
            next_asset_ids: nextAssetIds
        })
    );
}

/* ========================================================================== */
/* GET /api/assets/scan/:qrValue                                              */
/* ========================================================================== */

/**
 * Resolves a scanned QR payload to its register entry. Any authenticated role
 * may scan; only the two public identifiers are ever encoded in the value.
 */
async function scanAsset(req, res) {
    const qrValue = normalizeString(req.params.qrValue);

    if (!qrValue) {
        return res.status(400).json(errorResponse('A QR value is required.'));
    }

    const asset = await assetModel.findByQrValue(qrValue);
    if (!asset) {
        return res
            .status(404)
            .json(errorResponse('No asset matches that QR code. Check the label and try again.'));
    }

    return res
        .status(200)
        .json(successResponse('Asset located from QR code.', { asset }));
}

/* ========================================================================== */
/* GET /api/assets/:id                                                        */
/* ========================================================================== */

/**
 * Fetches a single asset by its numeric id, generated asset_id or asset tag.
 */
async function getAssetById(req, res) {
    const key = normalizeString(req.params.id);
    if (!key) {
        return res.status(400).json(errorResponse('An asset identifier is required.'));
    }

    // Numeric -> primary key. Anything else -> generated id or physical tag.
    const asset = Number.isInteger(Number(key)) && String(Number(key)) === key
        ? await assetModel.findById(key)
        : (await assetModel.findByAssetId(key)) || (await assetModel.findByAssetTag(key));

    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    return res
        .status(200)
        .json(successResponse('Asset retrieved successfully.', { asset }));
}

/* ========================================================================== */
/* GET /api/assets/:id/history                                                */
/* ========================================================================== */

/**
 * Returns the audit timeline for one asset, oldest first, so the UI can render
 * a change history. Administrators and Auditors see every field snapshot.
 */
async function getAssetHistory(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric asset id is required.'));
    }

    const asset = await assetModel.findById(id);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const history = await auditModel.findForRecord(ASSET_TABLE, id);

    return res.status(200).json(
        successResponse('Asset history retrieved successfully.', {
            asset_id: asset.id,
            asset_code: asset.asset_id,
            history
        })
    );
}

/* ========================================================================== */
/* POST /api/assets                                                           */
/* ========================================================================== */

/**
 * Registers a new asset.
 *
 * Body (all optional except asset_tag):
 *   asset_tag, asset_id, serial_number, category_id | category_name,
 *   manufacturer, model, purchase_date, purchase_cost, supplier,
 *   po_invoice_ref, warranty_provider, warranty_start, warranty_end,
 *   warranty_ref, location, department, assigned_user_id,
 *   responsible_officer, status, condition_status, last_inspection_date,
 *   qr_code_value
 *
 * When `asset_id` is omitted the next sequential code for the category prefix
 * is generated. When `qr_code_value` is omitted a QR payload is derived from
 * the asset id and tag.
 */
async function createAsset(req, res) {
    const body = req.body || {};

    // Resolve the category first - its name drives the asset-id prefix.
    let category = null;
    const categoryName = normalizeString(body.category_name);
    const categoryId = body.category_id !== undefined && body.category_id !== ''
        ? parseId(body.category_id)
        : null;

    if (categoryId !== null) {
        category = await assetModel.findCategoryById(categoryId);
        if (!category) {
            return res
                .status(400)
                .json(errorResponse('Validation failed.', [
                    { field: 'category_id', message: 'The selected asset category does not exist.' }
                ]));
        }
    } else if (categoryName) {
        category = await assetModel.findCategoryByName(categoryName);
        if (!category) {
            return res
                .status(400)
                .json(errorResponse('Validation failed.', [
                    { field: 'category_name', message: 'The supplied asset category does not exist.' }
                ]));
        }
    }

    const { errors, data } = validateAssetPayload(body, { isCreate: true, category });
    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    /* ------------------------- Uniqueness pre-checks ----------------------- */

    // asset_id - generate a sequential one when the caller did not supply it.
    if (!data.assetId) {
        const prefix = prefixForCategory(category ? category.name : null);
        data.assetId = await assetModel.generateNextAssetId(prefix);
    } else if (await assetModel.assetIdExists(data.assetId)) {
        return res
            .status(409)
            .json(errorResponse('That asset ID is already in use.', [
                { field: 'asset_id', message: 'An asset with this asset_id already exists.' }
            ]));
    }

    if (await assetModel.assetTagExists(data.assetTag)) {
        return res
            .status(409)
            .json(errorResponse('That asset tag is already in use.', [
                { field: 'asset_tag', message: 'An asset with this asset_tag already exists.' }
            ]));
    }

    if (data.serialNumber && (await assetModel.serialNumberExists(data.serialNumber))) {
        return res
            .status(409)
            .json(errorResponse('That serial number is already registered.', [
                { field: 'serial_number', message: 'An asset with this serial_number already exists.' }
            ]));
    }

    /* --------------------------- Defaults & QR ---------------------------- */

    // Status defaults to 'In Stock' and condition to 'Good' per the schema.
    if (data.status === undefined) data.status = 'In Stock';
    if (data.conditionStatus === undefined) data.conditionStatus = 'Good';

    if (data.qrCodeValue) {
        const owner = await assetModel.findQrValueOwner(data.qrCodeValue);
        if (owner) {
            return res
                .status(409)
                .json(errorResponse('That QR value is already assigned to another asset.', [
                    { field: 'qr_code_value', message: 'This QR value is already in use.' }
                ]));
        }
    } else {
        data.qrCodeValue = await assetModel.generateUniqueQrValue({
            assetId: data.assetId,
            assetTag: data.assetTag
        });
    }

    const created = await assetModel.create(data);

    // Record the registration with the full new state.
    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'CREATE',
        tableName: ASSET_TABLE,
        recordId: created.id,
        oldValues: null,
        newValues: created,
        ipAddress: getClientIp(req)
    });

    return res.status(201).json(
        successResponse('Asset registered successfully.', {
            asset: created,
            qr_code_value: created.qr_code_value
        })
    );
}

async function importAssets(req, res) {
    let parsedRows;
    try {
        parsedRows = parseCsv(req.body);
    } catch (error) {
        return res.status(error.status || 400).json(errorResponse(error.message));
    }

    if (!parsedRows.length) {
        return res.status(400).json(errorResponse('The CSV file has a header but no asset rows.'));
    }
    if (parsedRows.length > 1000) {
        return res.status(400).json(errorResponse('A single import cannot exceed 1,000 asset rows.'));
    }

    const headers = Object.keys(parsedRows.find((row) => row.data)?.data || {});
    const unknownColumns = headers.filter((header) => !IMPORT_COLUMNS.has(header));
    if (unknownColumns.length) {
        return res.status(400).json(errorResponse(
            `Unsupported CSV column(s): ${unknownColumns.join(', ')}.`
        ));
    }
    if (!headers.includes('asset_tag')) {
        return res.status(400).json(errorResponse('The CSV must include an asset_tag column.'));
    }

    const rows = [];
    for (const entry of parsedRows) {
        if (entry.error) {
            rows.push({ row: entry.rowNumber, status: 'Rejected', errors: [entry.error] });
            continue;
        }

        const response = {
            statusCode: 200,
            payload: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.payload = payload;
                return this;
            }
        };
        const rowRequest = {
            body: entry.data,
            user: req.user,
            headers: req.headers,
            socket: req.socket,
            connection: req.connection,
            ip: req.ip
        };

        try {
            await createAsset(rowRequest, response);
            if (response.statusCode >= 200 && response.statusCode < 300) {
                rows.push({
                    row: entry.rowNumber,
                    status: 'Imported',
                    asset_id: response.payload?.data?.asset?.asset_id,
                    asset_tag: response.payload?.data?.asset?.asset_tag
                });
            } else {
                const errors = response.payload?.errors?.map((item) =>
                    `${item.field}: ${item.message}`
                ) || [response.payload?.message || 'The asset was rejected.'];
                rows.push({ row: entry.rowNumber, status: 'Rejected', errors });
            }
        } catch (error) {
            console.error(`Asset CSV import failed on row ${entry.rowNumber}:`, error.message);
            rows.push({
                row: entry.rowNumber,
                status: 'Failed',
                errors: ['A server error prevented this asset from being imported.']
            });
        }
    }

    const imported = rows.filter((row) => row.status === 'Imported').length;
    const rejected = rows.length - imported;
    return res.status(200).json(successResponse('Asset import completed.', {
        total: rows.length,
        imported,
        rejected,
        rows
    }));
}

/* ========================================================================== */
/* PUT / PATCH /api/assets/:id                                                */
/* ========================================================================== */

/**
 * Updates an asset. PUT and PATCH share this handler: every field except
 * `asset_id` is optional, so the only practical difference is documentation.
 *
 * `asset_id` is immutable - allowing it to change would break every printed
 * label and previously-audited reference.
 */
async function updateAsset(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric asset id is required.'));
    }

    const existing = await assetModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const body = { ...(req.body || {}) };
    if (body.status !== undefined && normalizeString(body.status) === 'Disposed') {
        return res.status(409).json(
            errorResponse('Assets can only be disposed through the approved disposal workflow.', [
                { field: 'status', message: 'Use the disposal request and approval workflow.' }
            ])
        );
    }

    // asset_id is generated once and never edited.
    if (body.asset_id !== undefined && normalizeString(body.asset_id) !== existing.asset_id) {
        return res
            .status(400)
            .json(errorResponse('Validation failed.', [
                { field: 'asset_id', message: 'asset_id is generated on registration and cannot be changed.' }
            ]));
    }
    delete body.asset_id;

    // Resolve a new category when one is supplied so the FK stays valid.
    let category = null;
    if (body.category_id !== undefined && body.category_id !== null && body.category_id !== '') {
        const categoryId = parseId(body.category_id);
        if (categoryId === null) {
            return res.status(400).json(errorResponse('Validation failed.', [
                { field: 'category_id', message: 'category_id must be a positive integer.' }
            ]));
        }
        category = await assetModel.findCategoryById(categoryId);
        if (!category) {
            return res.status(400).json(errorResponse('Validation failed.', [
                { field: 'category_id', message: 'The selected asset category does not exist.' }
            ]));
        }
    }

    const { errors, data } = validateAssetPayload(body, { isCreate: false, category });
    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    if (!Object.keys(data).length) {
        return res.status(400).json(errorResponse('No updatable fields were supplied.'));
    }

    /* ------------------------- Uniqueness pre-checks ----------------------- */

    if (data.assetTag && (await assetModel.assetTagExists(data.assetTag, id))) {
        return res
            .status(409)
            .json(errorResponse('That asset tag is already in use.', [
                { field: 'asset_tag', message: 'Another asset already uses this asset_tag.' }
            ]));
    }

    if (data.serialNumber && (await assetModel.serialNumberExists(data.serialNumber, id))) {
        return res
            .status(409)
            .json(errorResponse('That serial number is already registered.', [
                { field: 'serial_number', message: 'Another asset already uses this serial_number.' }
            ]));
    }

    if (data.qrCodeValue && (await assetModel.findQrValueOwner(data.qrCodeValue, id))) {
        return res
            .status(409)
            .json(errorResponse('That QR value is already assigned to another asset.', [
                { field: 'qr_code_value', message: 'This QR value is already in use.' }
            ]));
    }

    const updated = await assetModel.update(id, data);

    // Record only the fields that actually changed, plus before/after snapshots.
    const changedFields = Object.keys(data).filter(
        (key) => String(existing[key] ?? '') !== String(updated[key] ?? '')
    );

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'UPDATE',
        tableName: ASSET_TABLE,
        recordId: id,
        oldValues: existing,
        newValues: updated,
        ipAddress: getClientIp(req)
    });

    return res.status(200).json(
        successResponse('Asset updated successfully.', {
            asset: updated,
            changed_fields: changedFields
        })
    );
}


/* ========================================================================== */
/* DELETE /api/assets/:id                                                     */
/* ========================================================================== */

/**
 * Direct deletion is disabled so it cannot bypass the disposal approval flow.
 */
async function deleteAsset(req, res) {
    return res.status(409).json(
        errorResponse('Assets cannot be deleted directly. Use the disposal request and approval workflow.')
    );
}

/* ========================================================================== */
/* POST /api/assets/:id/qr                                                    */
/* ========================================================================== */

/**
 * (Re)generates the QR value for an asset. Useful after a physical label is
 * reprinted or when the stored value has become invalid.
 *
 * Body (optional): { qr_code_value } to set a specific value instead of
 * generating one.
 */
async function regenerateAssetQr(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric asset id is required.'));
    }

    const existing = await assetModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const requested = normalizeString(req.body && req.body.qr_code_value);

    if (requested && requested.length > MAX_LENGTHS.qrCodeValue) {
        return res.status(400).json(errorResponse('Validation failed.', [
            {
                field: 'qr_code_value',
                message: `qr_code_value must be ${MAX_LENGTHS.qrCodeValue} characters or fewer.`
            }
        ]));
    }

    if (requested && (await assetModel.findQrValueOwner(requested, id))) {
        return res
            .status(409)
            .json(errorResponse('That QR value is already assigned to another asset.', [
                { field: 'qr_code_value', message: 'This QR value is already in use.' }
            ]));
    }

    const qrCodeValue =
        requested ||
        (await assetModel.generateUniqueQrValue(
            { assetId: existing.asset_id, assetTag: existing.asset_tag },
            id
        ));

    const updated = await assetModel.update(id, { qrCodeValue });

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'UPDATE',
        tableName: ASSET_TABLE,
        recordId: id,
        oldValues: { qr_code_value: existing.qr_code_value },
        newValues: { qr_code_value: updated.qr_code_value },
        ipAddress: getClientIp(req)
    });

    return res.status(200).json(
        successResponse('QR code generated successfully.', {
            asset: updated,
            qr_code_value: updated.qr_code_value
        })
    );
}

/* ========================================================================== */
/* Asset categories                                                           */
/* ========================================================================== */

/**
 * GET /api/assets/categories - lists categories with their asset counts.
 */
async function getAllCategories(req, res) {
    const withCounts = !['false', '0', 'no'].includes(
        String(req.query.with_counts || '').toLowerCase()
    );

    const categories = await assetModel.findCategories({ withAssetCounts: withCounts });

    return res.status(200).json(
        successResponse('Asset categories retrieved successfully.', {
            categories,
            total: categories.length
        })
    );
}

/**
 * GET /api/assets/categories/:id - fetch one category.
 */
async function getCategoryById(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric category id is required.'));
    }

    const category = await assetModel.findCategoryById(id);
    if (!category) {
        return res.status(404).json(errorResponse('Asset category not found.'));
    }

    const assetCount = await assetModel.countAssetsInCategory(id);

    return res.status(200).json(
        successResponse('Asset category retrieved successfully.', {
            category: { ...category, asset_count: assetCount }
        })
    );
}

/**
 * POST /api/assets/categories - creates a new asset category.
 *
 * Body: { name, description? }
 */
async function createCategory(req, res) {
    const body = req.body || {};
    const errors = [];

    const name = normalizeString(body.name);
    if (!name) {
        pushError(errors, 'name', 'Category name is required.');
    } else if (name.length > 100) {
        pushError(errors, 'name', 'Category name must be 100 characters or fewer.');
    }

    const description = normalizeOptionalString(body.description);

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    if (await assetModel.findCategoryByName(name)) {
        return res
            .status(409)
            .json(errorResponse('An asset category with that name already exists.'));
    }

    const created = await assetModel.createCategory({ name, description });

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'CREATE',
        tableName: CATEGORY_TABLE,
        recordId: created.id,
        oldValues: null,
        newValues: created,
        ipAddress: getClientIp(req)
    });

    return res
        .status(201)
        .json(successResponse('Asset category created successfully.', { category: created }));
}

/**
 * PUT /api/assets/categories/:id - renames / re-describes a category.
 */
async function updateCategory(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric category id is required.'));
    }

    const existing = await assetModel.findCategoryById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Asset category not found.'));
    }

    const body = req.body || {};
    const errors = [];
    const data = {};

    if (body.name !== undefined) {
        const name = normalizeString(body.name);
        if (!name) {
            pushError(errors, 'name', 'Category name cannot be empty.');
        } else if (name.length > 100) {
            pushError(errors, 'name', 'Category name must be 100 characters or fewer.');
        } else {
            data.name = name;
        }
    }

    if (body.description !== undefined) {
        data.description = normalizeOptionalString(body.description);
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    if (!Object.keys(data).length) {
        return res.status(400).json(errorResponse('No updatable fields were supplied.'));
    }

    if (data.name && data.name.toLowerCase() !== existing.name.toLowerCase()) {
        const clash = await assetModel.findCategoryByName(data.name);
        if (clash && Number(clash.id) !== id) {
            return res
                .status(409)
                .json(errorResponse('An asset category with that name already exists.'));
        }
    }

    const updated = await assetModel.updateCategory(id, data);

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'UPDATE',
        tableName: CATEGORY_TABLE,
        recordId: id,
        oldValues: existing,
        newValues: updated,
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('Asset category updated successfully.', { category: updated }));
}

/**
 * DELETE /api/assets/categories/:id - deletes an unused category.
 *
 * Categories that are still referenced by at least one asset are refused with
 * 409: the FK is ON DELETE SET NULL, so allowing it would silently strip the
 * classification from those assets.
 */
async function deleteCategory(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric category id is required.'));
    }

    const existing = await assetModel.findCategoryById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Asset category not found.'));
    }

    const assetCount = await assetModel.countAssetsInCategory(id);
    if (assetCount > 0) {
        return res
            .status(409)
            .json(
                errorResponse(
                    `This category is in use by ${assetCount} asset(s) and cannot be deleted. Re-categorise them first.`
                )
            );
    }

    await assetModel.deleteCategory(id);

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'DELETE',
        tableName: CATEGORY_TABLE,
        recordId: id,
        oldValues: existing,
        newValues: null,
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('Asset category deleted successfully.', { id }));
}

/* ========================================================================== */

module.exports = {
    // Assets
    getAllAssets,
    getAssetStats,
    getAssetMeta,
    scanAsset,
    getAssetById,
    getAssetHistory,
    createAsset,
    importAssets,
    updateAsset,
    deleteAsset,
    regenerateAssetQr,

    // Asset categories
    getAllCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    deleteCategory,

    // Exported for unit testing / reuse by other modules.
    ASSET_STATUSES,
    ASSET_CONDITIONS,
    ASSET_ID_PREFIXES,
    validateAssetPayload,
    isValidDate,
    prefixForCategory
};
