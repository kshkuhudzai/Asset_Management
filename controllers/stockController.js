'use strict';

// controllers/stockController.js
// ICT Stock / Store (§5.7 of the requirements): tracking the assets held in ICT
// stores or spare stock, recording the receipt, issue and return of stock, and
// providing stock balances and movement history.
//
// Endpoints
//   GET    /api/stock                        - list / search / filter + page
//   GET    /api/stock/stats                  - aggregate stock figures
//   GET    /api/stock/meta                   - ENUM choices + pick-lists
//   GET    /api/stock/balances               - stock balances (§5.7)
//   GET    /api/stock/low-stock              - replenishment list (§5.7)
//   GET    /api/stock/movements              - movement history (§5.7)
//   GET    /api/stock/movements/recent       - latest movements (dashboard)
//   GET    /api/stock/movements/:id          - one ledger entry
//   GET    /api/stock/asset/:assetId         - one asset's store card + history
//   GET    /api/stock/:id                    - fetch one store card
//   POST   /api/stock                        - open a store card
//   POST   /api/stock/:id/receipt            - record stock received
//   POST   /api/stock/:id/issue              - record stock issued out
//   POST   /api/stock/:id/return             - record stock returned
//   POST   /api/stock/:id/adjust             - correct a balance (auditable)
//   POST   /api/stock/movements/:id/reverse  - reverse a movement
//   PUT    /api/stock/:id                    - correct the catalogue details
//   PATCH  /api/stock/:id                    - partial update (same handler)
//
// Conventions (mirrors warrantyController):
//   * Handlers are async; Express 5 forwards rejected promises to the global
//     error handler, so no try/catch wrapper is needed for unexpected errors.
//   * Responses always use the shared { status, message, data } envelope.
//   * Movements are never deleted - a mistake is corrected by a reversal.
//   * Every mutating handler writes an audit_logs row explicitly.
//
// Business rules (§5.7, §9, §11)
//   * A balance only ever moves through a ledger entry, so `quantity_on_hand`
//     and the movement history can never disagree.
//   * An issue may not take more than is on hand - negative stock is a data
//     error, not a state the store can be in.
//   * A reversal must be applied to a movement that has not already been
//     reversed, so the ledger cannot be reversed twice.
//   * This module never mutates `assets.status`: stock is tracked here, custody
//     is owned by the assignment module (§5.3).

const stockModel = require('../models/stockModel');
const assetModel = require('../models/assetModel');
const userModel = require('../models/userModel');
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
const STOCK_ITEM_TABLE = 'stock_items';
const STOCK_MOVEMENT_TABLE = 'stock_movements';

// ENUM values from the stock_items schema. Kept here so validation and the
// /meta endpoint share a single source of truth.
const ITEM_STATUSES = Object.freeze(['Active', 'Inactive', 'Discontinued']);

// ENUM values from the stock_movements schema.
const MOVEMENT_TYPES = Object.freeze([
    'Receipt',
    'Issue',
    'Return',
    'Adjustment',
    'Transfer',
    'Write Off',
    'Stock Take'
]);

// The derived state of a store card (§5.7 balances).
const STOCK_STATES = Object.freeze([
    'In Stock',
    'Low Stock',
    'Overstocked',
    'Inactive',
    'Discontinued'
]);

// Units the store deals in. Free text in the schema, but a pick-list keeps the
// balances report consistent.
const UNIT_OF_MEASURE = Object.freeze([
    'Unit',
    'Box',
    'Pack',
    'Set',
    'Metre',
    'Roll',
    'Licence',
    'Other'
]);

// Default store locations, mirroring the register's location vocabulary.
const STORE_LOCATIONS = Object.freeze([
    'ICT Store - Head Office',
    'ICT Store - Bulawayo',
    'ICT Store - Gweru',
    'ICT Store - Mutare',
    'ICT Storeroom - Data Centre'
]);

// The movement types a caller may raise through the dedicated endpoints. A
// 'Stock Take' or 'Transfer' entry is recorded through /adjust so the store
// officer has to state a reason.
const ISSUABLE_TYPES = Object.freeze(['Issue', 'Return', 'Receipt', 'Write Off']);

// Condition vocabulary, shared with the asset register.
const CONDITION_STATUSES = Object.freeze(['Good', 'Fair', 'Damaged', 'Obsolete']);

// Guard rail so a caller cannot ask for an unbounded page.
const MAX_LIMIT = 200;

// Roles that may read the full store picture.
const READER_ROLES = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR];

// Reference prefixes.
const ITEM_REF_PREFIX = 'STK-';
const MOVEMENT_REF_PREFIX = 'MOV-';


/* ========================================================================== */
/* Small parsing / response helpers                                           */
/* ========================================================================== */

/**
 * Parses a positive integer id, returning null when the value is not one.
 *
 * @param {*} value
 * @returns {number|null}
 */
function parseId(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
        return Number.isInteger(value) && value > 0 ? value : null;
    }
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) return null;
    const number = Number(text);
    return number > 0 ? number : null;
}

/**
 * Parses a signed integer, falling back when the value is unusable.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function parseInteger(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.trunc(number);
}

/**
 * Parses a non-negative integer, falling back when the value is unusable.
 *
 * @param {*} value
 * @param {number} fallback
 * @param {number} [max]
 * @returns {number}
 */
function parseCount(value, fallback, max) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    const rounded = Math.floor(number);
    return max === undefined ? rounded : Math.min(rounded, max);
}

/**
 * Parses a boolean the way a browser form would send it.
 *
 * @param {*} value
 * @returns {boolean|null}
 */
function parseBoolean(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
    return null;
}

/**
 * Parses a non-negative money amount.
 *
 * @param {*} value
 * @returns {number|null}
 */
function parseMoney(value) {
    if (value === null || value === undefined || value === '') return 0;
    const number = Number(value);
    if (Number.isNaN(number) || number < 0) return null;
    return Math.round(number * 100) / 100;
}

/**
 * Pushes a field error onto the accumulator.
 *
 * @param {object[]} errors
 * @param {string} field
 * @param {string} message
 */
function pushError(errors, field, message) {
    errors.push({ field, message });
}

/**
 * True when the string is a real calendar date in YYYY-MM-DD form. The day is
 * round-tripped through Date so 2026-02-31 is rejected rather than silently
 * rolling over into March.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
    );
}

/**
 * Normalises a date-ish value to YYYY-MM-DD, or null when unusable.
 *
 * @param {*} value
 * @returns {string|null}
 */
function normaliseDate(value) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return null;
        const pad = (n) => String(n).padStart(2, '0');
        return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    }

    const text = normalizeString(value);
    if (!text) return null;

    const day = text.slice(0, 10);
    return isValidDate(day) ? day : null;
}

/**
 * Today's date as YYYY-MM-DD.
 *
 * @returns {string}
 */
function today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}


/* ========================================================================== */
/* Lookups and reference generation                                           */
/* ========================================================================== */

/**
 * Resolves an asset from a request value that may be a numeric primary key, a
 * generated asset code (NBSZ-ICT-000001) or a physical asset tag.
 *
 * @param {*} value
 * @returns {Promise<object|null>}
 */
async function resolveAsset(value) {
    const key = normalizeString(value);
    if (!key) return null;

    if (/^\d+$/.test(key)) {
        return (
            (await assetModel.findById(key)) ||
            (await assetModel.findByAssetId(key)) ||
            (await assetModel.findByAssetTag(key))
        );
    }

    return (await assetModel.findByAssetId(key)) || (await assetModel.findByAssetTag(key));
}

/**
 * Resolves a user from a request value that may be a numeric id, a username, an
 * email address or a full name.
 *
 * @param {*} value
 * @returns {Promise<object|null>}
 */
async function resolveUser(value) {
    const key = normalizeString(value);
    if (!key) return null;

    if (/^\d+$/.test(key)) return userModel.findById(key);

    return userModel.findByUsername(key);
}

/**
 * Resolves a store card from a numeric id, an STK- reference or the synthetic
 * `asset-<assetId>` identifier used for register-derived rows.
 *
 * Register-derived entries are read-only snapshots of the asset row, so they are
 * resolved here for viewing but the write handlers refuse them.
 *
 * @param {*} value
 * @returns {Promise<object|null>}
 */
async function resolveStockItem(value) {
    const key = normalizeString(value);
    if (!key) return null;

    const derived = /^asset-(\d+)$/i.exec(key);
    if (derived) {
        const asset = await assetModel.findById(derived[1]);
        return asset ? buildDerivedItem(asset) : null;
    }

    if (/^\d+$/.test(key)) return stockModel.findById(key);

    return stockModel.findByRef(key.toUpperCase());
}

/**
 * True when the resolved record is a register-derived (read-only) store item
 * rather than a row in `stock_items`.
 *
 * @param {object|null} record
 * @returns {boolean}
 */
function isDerivedItem(record) {
    return !!record && record.source === 'asset_register';
}

/**
 * Builds the read-only store view of an asset's register row so an asset the
 * store has not catalogued yet still appears in the balances (§5.7).
 *
 * @param {object} asset
 * @returns {object}
 */
function buildDerivedItem(asset) {
    const name = [asset.manufacturer, asset.model].filter(Boolean).join(' ').trim();

    return {
        id: `asset-${asset.id}`,
        source: 'asset_register',
        item_ref: null,
        asset_id: asset.id,
        asset_code: asset.asset_id,
        asset_tag: asset.asset_tag,
        serial_number: asset.serial_number,
        item_name: name || asset.asset_tag,
        part_code: null,
        category: asset.category_name || 'Uncategorised',
        unit_of_measure: 'Unit',
        store_location: asset.location || null,
        bin_location: null,
        department: asset.department || null,
        quantity_on_hand: 1,
        minimum_level: 0,
        maximum_level: null,
        unit_cost: Number(asset.purchase_cost || 0),
        currency: 'USD',
        supplier: asset.supplier || null,
        supplier_contact: null,
        status: 'Active',
        remarks: null,
        created_by: null,
        created_at: asset.date_registered || null,
        updated_at: asset.date_registered || null,
        asset_status: asset.status,
        asset_condition: asset.condition_status,
        asset_location: asset.location,
        asset_department: asset.department,
        category_name: asset.category_name || null,
        movement_count: 0,
        quantity_received: 0,
        quantity_issued: 0,
        quantity_above_minimum: 1,
        stock_state: 'In Stock',
        read_only: true
    };
}

/**
 * The asset ids a Departmental User may see in the store: the assets currently in
 * their custody. Every other role sees the whole estate.
 *
 * Returning `null` means "no restriction"; an empty array means "nothing".
 *
 * @param {object} user The authenticated user (req.user).
 * @returns {Promise<number[]|null>}
 */
async function visibleAssetIds(user) {
    if (!user || user.role !== ROLES.DEPARTMENTAL_USER) return null;

    const [rows] = await db.query('SELECT id FROM assets WHERE assigned_user_id = ?', [user.id]);
    return rows.map((row) => row.id);
}

/**
 * Mints the next store-card reference (STK-000001).
 *
 * The suffix is derived from the highest number already issued so a reference is
 * never reused, even after cards are deactivated.
 *
 * @returns {Promise<string>}
 */
async function generateItemRef() {
    const highest = await stockModel.findMaxRefSuffix('stock_items', 'item_ref', ITEM_REF_PREFIX);

    for (let attempt = 1; attempt <= 50; attempt += 1) {
        const candidate = `${ITEM_REF_PREFIX}${String(highest + attempt).padStart(6, '0')}`;
        /* eslint-disable no-await-in-loop */
        if (!(await stockModel.itemRefExists(candidate))) return candidate;
        /* eslint-enable no-await-in-loop */
    }

    // Falling back to a timestamp keeps the reference unique even under a
    // pathological amount of contention.
    return `${ITEM_REF_PREFIX}${Date.now()}`;
}

/**
 * Mints the next movement reference (MOV-000001).
 *
 * @returns {Promise<string>}
 */
async function generateMovementRef() {
    const highest = await stockModel.findMaxRefSuffix(
        'stock_movements',
        'movement_ref',
        MOVEMENT_REF_PREFIX
    );

    for (let attempt = 1; attempt <= 50; attempt += 1) {
        const candidate = `${MOVEMENT_REF_PREFIX}${String(highest + attempt).padStart(6, '0')}`;
        /* eslint-disable no-await-in-loop */
        const [rows] = await db.query(
            'SELECT id FROM stock_movements WHERE movement_ref = ? LIMIT 1',
            [candidate]
        );
        /* eslint-enable no-await-in-loop */
        if (!rows.length) return candidate;
    }

    return `${MOVEMENT_REF_PREFIX}${Date.now()}`;
}

/**
 * Writes one audit_logs row for a mutation.
 *
 * Never throws: auditMiddleware.auditLog swallows storage failures so a full
 * audit table cannot block a legitimate stock movement.
 *
 * @param {import('express').Request} req
 * @param {object} payload
 * @returns {Promise<number|null>}
 */
async function recordAudit(req, payload) {
    return auditLog({
        userId: req.user ? req.user.id : null,
        action: payload.action,
        tableName: payload.tableName || STOCK_ITEM_TABLE,
        recordId: payload.recordId ?? 0,
        oldValues: payload.oldValues ?? null,
        newValues: payload.newValues ?? null,
        ipAddress: getClientIp(req)
    });
}


/* ========================================================================== */
/* Validation                                                                 */
/* ========================================================================== */

/**
 * Validates and normalises the body of a store-card create or update.
 *
 * Returns DB column names (snake_case) in `columns` so the model can pass them
 * straight through, and the parsed values in `data` for the handler's own checks.
 *
 * @param {object} body
 * @param {object} [options]
 * @param {boolean} [options.isCreate=false]
 * @returns {{errors: object[], data: object, columns: object}}
 */
function validateItemPayload(body, { isCreate = false } = {}) {
    const errors = [];
    const data = {};
    const columns = {};

    /* ------------------------------- Asset -------------------------------- */

    // A NULL asset is legitimate: a consumable line (patch leads, thermal paste)
    // is a quantity with no serialised asset behind it.
    if (body.asset_id !== undefined) {
        if (body.asset_id === null || body.asset_id === '' || body.asset_id === 'none') {
            data.assetId = null;
            columns.asset_id = null;
        } else {
            const assetId = parseId(body.asset_id);
            if (assetId === null) {
                pushError(errors, 'asset_id', 'asset_id must reference a registered asset.');
            } else {
                data.assetId = assetId;
                columns.asset_id = assetId;
            }
        }
    }

    /* ------------------------------ Identity ------------------------------ */

    const itemName = normalizeString(body.item_name);
    if (isCreate && !itemName) {
        pushError(errors, 'item_name', 'The item name is required.');
    } else if (body.item_name !== undefined) {
        if (!itemName) {
            pushError(errors, 'item_name', 'The item name cannot be blank.');
        } else {
            data.itemName = itemName;
            columns.item_name = itemName;
        }
    }

    if (body.part_code !== undefined) {
        columns.part_code = normalizeString(body.part_code) || null;
    }

    if (body.category !== undefined) {
        columns.category = normalizeString(body.category) || null;
    }

    if (body.unit_of_measure !== undefined) {
        const unit = normalizeString(body.unit_of_measure) || 'Unit';
        if (!UNIT_OF_MEASURE.includes(unit)) {
            pushError(
                errors,
                'unit_of_measure',
                `unit_of_measure must be one of: ${UNIT_OF_MEASURE.join(', ')}.`
            );
        } else {
            columns.unit_of_measure = unit;
        }
    }

    /* ------------------------------- Location ----------------------------- */

    ['store_location', 'bin_location', 'department', 'supplier', 'supplier_contact'].forEach(
        (key) => {
            if (body[key] === undefined) return;
            columns[key] = normalizeString(body[key]) || null;
        }
    );

    /* --------------------------- Reorder control -------------------------- */

    if (body.minimum_level !== undefined) {
        if (body.minimum_level === null || body.minimum_level === '') {
            columns.minimum_level = 0;
        } else {
            const level = parseInteger(body.minimum_level, -1);
            if (level < 0) {
                pushError(errors, 'minimum_level', 'minimum_level cannot be negative.');
            } else {
                columns.minimum_level = level;
            }
        }
    }

    if (body.maximum_level !== undefined) {
        if (body.maximum_level === null || body.maximum_level === '') {
            columns.maximum_level = null;
        } else {
            const level = parseInteger(body.maximum_level, -1);
            if (level < 0) {
                pushError(errors, 'maximum_level', 'maximum_level cannot be negative.');
            } else {
                columns.maximum_level = level;
            }
        }
    }

    // A maximum below the minimum would make the 'Overstocked' state unreachable.
    const nextMinimum = columns.minimum_level !== undefined ? columns.minimum_level : 0;
    if (
        columns.maximum_level !== undefined &&
        columns.maximum_level !== null &&
        columns.maximum_level < Number(nextMinimum || 0)
    ) {
        pushError(errors, 'maximum_level', 'maximum_level cannot be below minimum_level.');
    }

    /* ------------------------------ Opening ------------------------------- */

    // Only accepted when the card is opened: thereafter a balance only moves
    // through the ledger, so the two can never disagree.
    if (
        isCreate &&
        body.quantity_on_hand !== undefined &&
        body.quantity_on_hand !== null &&
        body.quantity_on_hand !== ''
    ) {
        const quantity = parseInteger(body.quantity_on_hand, -1);
        if (quantity < 0) {
            pushError(errors, 'quantity_on_hand', 'The opening quantity cannot be negative.');
        } else {
            columns.quantity_on_hand = quantity;
        }
    }

    /* ------------------------------- Money -------------------------------- */

    if (body.unit_cost !== undefined) {
        const cost = parseMoney(body.unit_cost);
        if (cost === null) {
            pushError(errors, 'unit_cost', 'unit_cost must be a non-negative amount.');
        } else {
            columns.unit_cost = cost;
        }
    }

    if (body.currency !== undefined) {
        columns.currency = normalizeString(body.currency).toUpperCase().slice(0, 10) || 'USD';
    }

    /* ------------------------------ Lifecycle ----------------------------- */

    if (body.status !== undefined) {
        const status = normalizeString(body.status);
        if (!ITEM_STATUSES.includes(status)) {
            pushError(errors, 'status', `status must be one of: ${ITEM_STATUSES.join(', ')}.`);
        } else {
            columns.status = status;
        }
    }

    if (body.remarks !== undefined) {
        columns.remarks = normalizeString(body.remarks) || null;
    }

    return { errors, data, columns };
}

/**
 * Validates and normalises the body of a stock movement.
 *
 * The sign of the quantity is decided by the caller (`sign`: +1 for stock coming
 * into the store, -1 for stock leaving it) rather than trusted from the request,
 * so a client cannot turn a receipt into an unexplained issue.
 *
 * @param {object} body
 * @param {object} options
 * @param {number} options.sign +1 (in) or -1 (out).
 * @param {string} options.movementType The ledger type to record.
 * @param {boolean} [options.requireQuantity=true]
 * @returns {{errors: object[], data: object, columns: object}}
 */
function validateMovementPayload(body, { sign, movementType, requireQuantity = true } = {}) {
    const errors = [];
    const data = {};
    const columns = { movement_type: movementType };

    /* ------------------------------ Quantity ------------------------------ */

    const rawQuantity = body.quantity === undefined ? body.units : body.quantity;

    if (rawQuantity === undefined || rawQuantity === null || rawQuantity === '') {
        if (requireQuantity) {
            pushError(errors, 'quantity', 'The quantity is required.');
        }
    } else {
        const magnitude = Math.abs(parseInteger(rawQuantity, NaN));
        if (!Number.isFinite(magnitude) || magnitude === 0) {
            pushError(errors, 'quantity', 'The quantity must be a whole number greater than zero.');
        } else {
            data.quantity = magnitude;
            columns.quantity = sign * magnitude;
        }
    }

    /* ------------------------------- Date --------------------------------- */

    if (body.movement_date !== undefined && body.movement_date !== null && body.movement_date !== '') {
        const parsed = normaliseDate(body.movement_date);
        if (!parsed) {
            pushError(errors, 'movement_date', 'movement_date must be a valid date (YYYY-MM-DD).');
        } else {
            data.movementDate = parsed;
            columns.movement_date = parsed;
        }
    } else {
        data.movementDate = today();
        columns.movement_date = data.movementDate;
    }

    /* ------------------------------ Reference ----------------------------- */

    if (body.reference !== undefined) {
        data.reference = normalizeString(body.reference) || null;
        columns.reference = data.reference;
    }

    if (body.reason !== undefined) {
        data.reason = normalizeString(body.reason) || null;
        columns.reason = data.reason;
    }

    if (body.counterparty !== undefined) {
        data.counterparty = normalizeString(body.counterparty) || null;
        columns.counterparty = data.counterparty;
    }

    /* -------------------------------- Money ------------------------------- */

    if (body.unit_cost !== undefined) {
        const cost = parseMoney(body.unit_cost);
        if (cost === null) {
            pushError(errors, 'unit_cost', 'unit_cost must be a non-negative amount.');
        } else {
            data.unitCost = cost;
            columns.unit_cost = cost;
            // The extended cost is stamped on the row so a historic issue slip
            // does not change when the catalogue price is later corrected.
            columns.total_cost = data.quantity
                ? Math.round(data.quantity * cost * 100) / 100
                : 0;
        }
    }

    /* ------------------------------ Recipient ----------------------------- */

    ['to_user_name', 'to_department', 'to_location'].forEach((key) => {
        if (body[key] === undefined) return;
        data[key] = normalizeString(body[key]) || null;
        columns[key] = data[key];
    });

    if (body.condition_status !== undefined && body.condition_status !== null && body.condition_status !== '') {
        const condition = normalizeString(body.condition_status);
        if (!CONDITION_STATUSES.includes(condition)) {
            pushError(
                errors,
                'condition_status',
                `condition_status must be one of: ${CONDITION_STATUSES.join(', ')}.`
            );
        } else {
            data.conditionStatus = condition;
            columns.condition_status = condition;
        }
    }

    if (body.remarks !== undefined) {
        data.remarks = normalizeString(body.remarks) || null;
        columns.remarks = data.remarks;
    }

    return { errors, data, columns };
}


/* ========================================================================== */
/* Reads                                                                      */
/* ========================================================================== */

/**
 * GET /api/stock
 * Lists stock items with search, filter and pagination.
 *
 * Register-derived rows (assets the register reports as 'In Stock' that have no
 * store card yet) are merged in unless `include_derived=false` is passed, so
 * §5.7's "assets held in ICT stores" is complete from the first day of use.
 */
async function getAllStockItems(req, res) {
    const query = req.query || {};
    const scope = await visibleAssetIds(req.user);

    const page = parseCount(query.page, 1);
    const limit = parseCount(query.limit, 25, MAX_LIMIT);
    const offset = query.offset !== undefined
        ? parseCount(query.offset, 0)
        : (page - 1) * limit;

    const includeDerived = parseBoolean(query.include_derived);
    const lowStockOnly = parseBoolean(query.low_stock) === true;

    const { rows, total, derived } = await stockModel.findAll({
        search: normalizeString(query.search) || null,
        status: normalizeString(query.status) || null,
        category: normalizeString(query.category) || null,
        storeLocation: normalizeString(query.store_location) || null,
        lowStockOnly,
        assetId: query.asset_id !== undefined ? parseId(query.asset_id) : undefined,
        assetIds: scope === null ? undefined : scope,
        includeDerived: includeDerived === null ? true : includeDerived,
        limit,
        offset,
        sort: normalizeString(query.sort) || 'item_ref',
        order: normalizeString(query.order) || 'asc'
    });

    return res.json(
        successResponse('Stock items retrieved successfully.', {
            stock_items: rows,
            items: rows,
            total,
            derived,
            limit,
            offset,
            page
        })
    );
}

/**
 * GET /api/stock/stats
 * Aggregate stock figures for the dashboard and reports (§12).
 */
async function getStockStats(req, res) {
    const stats = await stockModel.getStats();

    return res.json(successResponse('Stock statistics retrieved successfully.', stats));
}

/**
 * GET /api/stock/balances
 * §5.7 "stock balances": what is on hand, split by store, category and state.
 */
async function getStockBalances(req, res) {
    const balances = await stockModel.getBalances();

    return res.json(
        successResponse('Stock balances retrieved successfully.', {
            ...balances,
            totals: {
                lineItems: balances.lineItems,
                unitsOnHand: balances.unitsOnHand,
                stockValue: balances.stockValue
            }
        })
    );
}

/**
 * GET /api/stock/low-stock
 * Store cards at or below their minimum level - the replenishment list (§5.7).
 */
async function getLowStock(req, res) {
    const query = req.query || {};
    const limit = parseCount(query.limit, 100, MAX_LIMIT);
    const assetIds = await visibleAssetIds(req.user);

    const rows = await stockModel.findLowStock(limit, assetIds === null ? undefined : assetIds);

    return res.json(
        successResponse('Low-stock items retrieved successfully.', {
            stock_items: rows,
            items: rows,
            total: rows.length
        })
    );
}

/**
 * GET /api/stock/movements
 * §5.7 "movement history" - the append-only ledger, optionally filtered.
 */
async function getMovements(req, res) {
    const query = req.query || {};
    const assetIds = await visibleAssetIds(req.user);

    const page = parseCount(query.page, 1);
    const limit = parseCount(query.limit, 50, MAX_LIMIT);
    const offset = query.offset !== undefined
        ? parseCount(query.offset, 0)
        : (page - 1) * limit;

    // A caller may address the ledger by store card (numeric) or by asset
    // (numeric id, asset code or tag).
    let stockItemId;
    let assetId;

    if (query.asset_id !== undefined && query.asset_id !== '') {
        const resolved = await stockModel.resolveAssetPk(query.asset_id);
        if (!resolved) {
            return res.status(404).json(errorResponse('Asset not found.'));
        }
        assetId = resolved;
    } else if (query.stock_item_id !== undefined && query.stock_item_id !== '') {
        stockItemId = parseId(query.stock_item_id);
        if (stockItemId === null) {
            return res
                .status(400)
                .json(errorResponse('stock_item_id must be a positive integer.'));
        }
    }

    const { rows, total } = await stockModel.findMovements({
        stockItemId,
        assetId,
        assetIds: assetIds === null ? undefined : assetIds,
        movementType: normalizeString(query.movement_type) || null,
        dateFrom: normalizeString(query.date_from) || null,
        dateTo: normalizeString(query.date_to) || null,
        search: normalizeString(query.search) || null,
        limit,
        offset,
        order: normalizeString(query.order) || 'desc'
    });

    return res.json(
        successResponse('Stock movements retrieved successfully.', {
            movements: rows,
            total,
            limit,
            offset,
            page
        })
    );
}

/**
 * GET /api/stock/movements/recent
 * The latest ledger entries, for the dashboard panel.
 */
async function getRecentMovements(req, res) {
    const limit = parseCount((req.query || {}).limit, 10, 100);
    const rows = await stockModel.findRecentMovements(limit);

    return res.json(
        successResponse('Recent stock movements retrieved successfully.', {
            movements: rows,
            total: rows.length
        })
    );
}

/**
 * GET /api/stock/movements/:id
 * Fetches one ledger entry.
 */
async function getMovementById(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid movement id is required.'));
    }

    const movement = await stockModel.findMovementById(id);
    if (!movement) {
        return res.status(404).json(errorResponse('Stock movement not found.'));
    }
    const scope = await visibleAssetIds(req.user);
    if (scope !== null && !scope.includes(Number(movement.asset_id))) {
        return res.status(404).json(errorResponse('Stock movement not found.'));
    }

    return res.json(successResponse('Stock movement retrieved successfully.', { movement }));
}

/**
 * GET /api/stock/asset/:assetId
 * One asset's store position: its card (if catalogued), its register view and
 * its complete movement history.
 */
async function getAssetStock(req, res) {
    const asset = await resolveAsset(req.params.assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }
    const scope = await visibleAssetIds(req.user);
    if (scope !== null && !scope.includes(Number(asset.id))) {
        return res.status(404).json(errorResponse('Asset stock position not found.'));
    }

    const item = await stockModel.findByAssetId(asset.id);
    const movements = await stockModel.findMovementsByAsset(asset.id, 200);

    // When the store has not catalogued the asset yet, the register row is
    // reported instead so the caller always gets a card to display.
    const record = item || buildDerivedItem(asset);

    return res.json(
        successResponse('Asset stock position retrieved successfully.', {
            asset: {
                id: asset.id,
                asset_id: asset.asset_id,
                asset_tag: asset.asset_tag,
                serial_number: asset.serial_number,
                status: asset.status,
                condition_status: asset.condition_status,
                location: asset.location,
                department: asset.department
            },
            stock_item: record,
            item: record,
            movements,
            total: movements.length,
            in_store: asset.status === 'In Stock',
            catalogued: !!item
        })
    );
}

/**
 * GET /api/stock/:id
 * Fetches one store card by numeric id, STK- reference or the synthetic
 * `asset-<id>` identifier.
 */
async function getStockItemById(req, res) {
    const record = await resolveStockItem(req.params.id);
    if (!record) {
        return res.status(404).json(errorResponse('Stock item not found.'));
    }
    const scope = await visibleAssetIds(req.user);
    if (scope !== null && (!record.asset_id || !scope.includes(Number(record.asset_id)))) {
        return res.status(404).json(errorResponse('Stock item not found.'));
    }

    // The movement history travels with the card so the detail drawer needs one
    // round trip, but not for a register-derived row (there is nothing to show).
    const movements = isDerivedItem(record)
        ? []
        : await stockModel.findMovementsByItem(record.id, 50);

    return res.json(
        successResponse('Stock item retrieved successfully.', {
            stock_item: record,
            item: record,
            movements,
            total_movements: movements.length
        })
    );
}

/**
 * GET /api/stock/meta
 * ENUM choices and pick-lists the store forms need, so the UI never hard-codes
 * a vocabulary the API would reject.
 */
async function getStockMeta(req, res) {
    const nextItemRef = await generateItemRef();

    // The asset pick-list covers the register's spare stock plus everything else,
    // because a store card may be opened for any asset.
    const { assets } = await assetModel.findAll({ limit: MAX_LIMIT, sortBy: 'asset_tag', sortDir: 'asc' });

    const itemsForPicker = await stockModel.findAll({
        includeDerived: false,
        limit: MAX_LIMIT,
        sort: 'item_name',
        order: 'asc'
    });

    const usersPage = await userModel.findAll({ limit: MAX_LIMIT });
    const users = usersPage.users || [];

    return res.json(
        successResponse('Stock reference data retrieved successfully.', {
            statuses: [...ITEM_STATUSES],
            movement_types: [...MOVEMENT_TYPES],
            issuable_types: [...ISSUABLE_TYPES],
            stock_states: [...STOCK_STATES],
            units_of_measure: [...UNIT_OF_MEASURE],
            store_locations: [...STORE_LOCATIONS],
            condition_statuses: [...CONDITION_STATUSES],
            next_item_ref: nextItemRef,
            item_ref_prefix: ITEM_REF_PREFIX,
            movement_ref_prefix: MOVEMENT_REF_PREFIX,
            assets,
            items: itemsForPicker.rows,
            stock_items: itemsForPicker.rows,
            users
        })
    );
}


/* ========================================================================== */
/* Writes                                                                     */
/* ========================================================================== */

/**
 * POST /api/stock
 * Opens a store card for a serialised spare or a consumable line (§5.7).
 *
 * An opening quantity is allowed here and only here: from then on the balance
 * moves through the ledger, so `quantity_on_hand` and the movement history can
 * never disagree. When an opening quantity is supplied it is also written to the
 * ledger as a 'Receipt' so the card has a history from day one.
 */
async function createStockItem(req, res) {
    const { errors, data, columns } = validateItemPayload(req.body || {}, { isCreate: true });

    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    // A named asset must exist and must not already have a store card, otherwise
    // the UNIQUE constraint would surface as an opaque 409.
    let asset = null;
    if (data.assetId) {
        asset = await assetModel.findById(data.assetId);
        if (!asset) {
            return res.status(404).json(
                errorResponse('Asset not found.', [
                    { field: 'asset_id', message: 'No such asset.' }
                ])
            );
        }

        const existingCard = await stockModel.findByAssetId(asset.id);
        if (existingCard) {
            return res.status(409).json(
                errorResponse(`That asset already has store card ${existingCard.item_ref}.`, [
                    {
                        field: 'asset_id',
                        message: `A card for this asset already exists (${existingCard.item_ref}).`
                    }
                ])
            );
        }

        // Default the catalogue fields from the register so the store officer has
        // less to type and the two records agree.
        if (columns.item_name === undefined) {
            const name = [asset.manufacturer, asset.model].filter(Boolean).join(' ').trim();
            columns.item_name = name || asset.asset_tag;
        }
        if (columns.store_location === undefined) columns.store_location = asset.location || null;
        if (columns.department === undefined) columns.department = asset.department || null;
        if (columns.supplier === undefined) columns.supplier = asset.supplier || null;
        if (columns.unit_cost === undefined) columns.unit_cost = Number(asset.purchase_cost || 0);
    }

    // The item name is NOT NULL; without an asset it must have been supplied.
    if (!columns.item_name) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                { field: 'item_name', message: 'The item name is required.' }
            ])
        );
    }

    const openingQuantity = Number(columns.quantity_on_hand || 0);

    columns.item_ref = await generateItemRef();
    columns.created_by = req.user.id;
    // The opening balance is written by the movement below, so start at zero and
    // let the ledger bring the card up to its opening figure.
    columns.quantity_on_hand = 0;

    const id = await stockModel.create(columns);

    if (openingQuantity > 0) {
        await stockModel.recordMovement({
            movement_ref: await generateMovementRef(),
            stock_item_id: id,
            asset_id: columns.asset_id ?? null,
            movement_type: 'Receipt',
            quantity: openingQuantity,
            movement_date: today(),
            reference: 'Opening balance',
            reason: 'Opening balance recorded when the store card was created.',
            counterparty: columns.supplier || null,
            unit_cost: Number(columns.unit_cost || 0),
            total_cost: Math.round(openingQuantity * Number(columns.unit_cost || 0) * 100) / 100,
            recorded_by: req.user.id
        });
    }

    const created = await stockModel.findById(id);

    await recordAudit(req, {
        action: 'CREATE',
        tableName: STOCK_ITEM_TABLE,
        recordId: id,
        newValues: created
    });

    if (openingQuantity > 0) {
        await recordAudit(req, {
            action: 'RECEIPT',
            tableName: STOCK_MOVEMENT_TABLE,
            recordId: id,
            newValues: { opening_quantity: openingQuantity, item_ref: columns.item_ref }
        });
    }

    return res.status(201).json(
        successResponse('Store card created successfully.', {
            stock_item: created,
            item: created,
            opening_quantity: openingQuantity,
            asset: asset
                ? {
                      id: asset.id,
                      asset_tag: asset.asset_tag,
                      status: asset.status,
                      condition_status: asset.condition_status
                  }
                : null
        })
    );
}

/**
 * Raised when a stock operation is refused for a business reason rather than a
 * programming error. The `field` is surfaced in the error envelope so the form
 * can highlight the offending input.
 */
class StockRuleError extends Error {
    constructor(message, field, status) {
        super(message);
        this.name = 'StockRuleError';
        this.field = field;
        this.status = status || 409;
    }
}

/**
 * The shared body of the receipt / issue / return / adjust handlers.
 *
 * Keeping one implementation means the balance arithmetic, the negative-stock
 * guard and the audit trail cannot drift between the four endpoints.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} options
 * @param {number} options.sign +1 when stock comes in, -1 when it goes out.
 * @param {string} options.movementType The ledger type to record.
 * @param {string} options.action The audit action label.
 * @param {string} options.successMessage
 * @returns {Promise<object|null>} The freshly read store card, or null when the
 *          request was refused and a response has already been sent.
 */
async function recordStockMovement(req, res, { sign, movementType, action, successMessage }) {
    const item = await resolveStockItem(req.params.id);

    if (!item) {
        res.status(404).json(errorResponse('Stock item not found.'));
        return null;
    }

    if (isDerivedItem(item)) {
        res.status(409).json(
            errorResponse(
                'This item comes from the asset register and has no store card yet. Open a store card for it first.'
            )
        );
        return null;
    }

    const { errors, data, columns } = validateMovementPayload(req.body || {}, {
        sign,
        movementType
    });

    if (errors.length) {
        res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
        return null;
    }

    try {
        const currentBalance = Number(item.quantity_on_hand) || 0;
        const signedQuantity = Number(columns.quantity);

        // Negative stock is a data error, not a state the store can be in.
        if (sign < 0 && Math.abs(signedQuantity) > currentBalance) {
            throw new StockRuleError(
                `Only ${currentBalance} ${item.unit_of_measure || 'unit'}(s) are on hand; ` +
                    `${Math.abs(signedQuantity)} were requested. The stock balance cannot go negative.`,
                'quantity',
                409
            );
        }

        if (item.status !== 'Active') {
            throw new StockRuleError(
                `Store card ${item.item_ref} is ${item.status} and cannot be moved. Reactivate it first.`,
                'status',
                409
            );
        }

        // A movement out of the store must name who received it, so the ledger
        // can answer "who has this?" without joining the assignment table.
        const body = req.body || {};
        const namesRecipient =
            Boolean(data.to_user_name) ||
            Boolean(data.to_department) ||
            Boolean(data.to_location) ||
            (body.to_user_id !== undefined && body.to_user_id !== null && body.to_user_id !== '');

        if (sign < 0 && !namesRecipient) {
            throw new StockRuleError(
                'State who the stock was issued to (a custodian, department or location).',
                'to_user_name',
                400
            );
        }

        return await commitMovement(req, res, {
            item,
            columns,
            body,
            signedQuantity,
            movementType,
            action,
            successMessage
        });
    } catch (err) {
        if (!(err instanceof StockRuleError)) throw err;

        res.status(err.status).json(
            errorResponse(err.message, [{ field: err.field, message: err.message }])
        );
        return null;
    }
}

/**
 * Resolves the recipient, writes the ledger row and returns the fresh card.
 *
 * Split out of `recordStockMovement` purely so each function stays small enough
 * to read: the guards live above, the persistence lives here.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} ctx
 * @returns {Promise<object>} The updated store card.
 */
async function commitMovement(req, res, ctx) {
    const { item, columns, body, signedQuantity, movementType, action, successMessage } = ctx;

    // Resolve the named custodian before the ledger row is written so an unknown
    // username cannot be recorded as a receiving party.
    let recipient = null;

    if (body.to_user_id !== undefined && body.to_user_id !== null && body.to_user_id !== '') {
        recipient = await resolveUser(body.to_user_id);
        if (!recipient) {
            res.status(404).json(
                errorResponse('Custodian not found.', [
                    { field: 'to_user_id', message: 'No such user.' }
                ])
            );
            return null;
        }
        columns.to_user_id = recipient.id;
        columns.to_user_name = recipient.full_name;
        if (!columns.to_department) columns.to_department = item.department || null;
    }

    // Fall back to the catalogue price when the caller did not state one, so the
    // movement value is not silently zero.
    if (!columns.unit_cost && Number(item.unit_cost) > 0) {
        columns.unit_cost = Number(item.unit_cost);
        columns.total_cost = Math.round(Math.abs(signedQuantity) * Number(item.unit_cost) * 100) / 100;
    }

    const movementRef = await generateMovementRef();

    let result;
    try {
        result = await stockModel.recordMovement({
            ...columns,
            movement_ref: movementRef,
            stock_item_id: item.id,
            asset_id: item.asset_id || null,
            recorded_by: req.user.id
        });
    } catch (err) {
        if (err.status !== 409) throw err;
        res.status(409).json(
            errorResponse(err.message, [
                { field: 'quantity', message: 'The balance changed; refresh and retry the movement.' }
            ])
        );
        return null;
    }

    const updated = await stockModel.findById(item.id);

    await recordAudit(req, {
        action,
        tableName: STOCK_MOVEMENT_TABLE,
        recordId: result.id,
        oldValues: { quantity_on_hand: item.quantity_on_hand },
        newValues: {
            movement_ref: movementRef,
            item_ref: item.item_ref,
            movement_type: movementType,
            quantity: columns.quantity,
            balance_after: result.balance
        }
    });

    res.status(201).json(
        successResponse(successMessage, {
            movement_id: result.id,
            movement_ref: movementRef,
            balance_after: result.balance,
            stock_item: updated,
            item: updated,
            recipient
        })
    );

    return updated;
}

/**
 * POST /api/stock/:id/receipt
 * §5.7 "record receipt" of stock into the store.
 */
async function receiveStock(req, res) {
    return recordStockMovement(req, res, {
        sign: 1,
        movementType: 'Receipt',
        action: 'RECEIPT',
        successMessage: 'Stock receipt recorded successfully.'
    });
}

/**
 * POST /api/stock/:id/issue
 * §5.7 "record issue" of stock out of the store.
 */
async function issueStock(req, res) {
    return recordStockMovement(req, res, {
        sign: -1,
        movementType: 'Issue',
        action: 'ISSUE',
        successMessage: 'Stock issue recorded successfully.'
    });
}

/**
 * POST /api/stock/:id/return
 * §5.7 "record return" of stock back into the store.
 */
async function returnStock(req, res) {
    return recordStockMovement(req, res, {
        sign: 1,
        movementType: 'Return',
        action: 'RETURN',
        successMessage: 'Stock return recorded successfully.'
    });
}

/**
 * POST /api/stock/:id/adjust
 * Corrects a balance (§5.7).
 *
 * Unlike receipt/issue, an adjustment may carry either sign and always requires a
 * reason, because it exists to explain a discrepancy rather than record a normal
 * transaction. This is also the route used for a stock-take and a write-off.
 */
async function adjustStock(req, res) {
    const body = req.body || {};

    const item = await resolveStockItem(req.params.id);
    if (!item) {
        return res.status(404).json(errorResponse('Stock item not found.'));
    }

    if (isDerivedItem(item)) {
        return res.status(409).json(
            errorResponse(
                'This item comes from the asset register and has no store card yet. Open a store card for it first.'
            )
        );
    }

    const requestedType = normalizeString(body.movement_type);
    const movementType = requestedType || 'Adjustment';

    // Only the corrective types may be raised here; a receipt or an issue has its
    // own endpoint and its own sign rules.
    if (!['Adjustment', 'Write Off', 'Stock Take', 'Transfer'].includes(movementType)) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                {
                    field: 'movement_type',
                    message:
                        'movement_type must be one of: Adjustment, Write Off, Stock Take, Transfer.'
                }
            ])
        );
    }

    // A reason is what makes an adjustment auditable (§11), so it is mandatory.
    if (!normalizeString(body.reason)) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                { field: 'reason', message: 'A reason is required when adjusting a stock balance.' }
            ])
        );
    }

    // `quantity` may be signed for an adjustment, so the caller's sign decides
    // the direction instead of the endpoint. A positive figure means "there is
    // more on hand than the ledger thought", i.e. stock in.
    const signedQuantity = parseInteger(body.quantity, NaN);
    if (!Number.isFinite(signedQuantity) || signedQuantity === 0) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                {
                    field: 'quantity',
                    message: 'The quantity must be a whole number other than zero.'
                }
            ])
        );
    }

    // A write-off only ever removes stock; asking for a positive write-off is a
    // mistake the caller should see immediately rather than a silent receipt.
    if (movementType === 'Write Off' && signedQuantity > 0) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                { field: 'quantity', message: 'A write-off quantity must be negative.' }
            ])
        );
    }

    const direction = signedQuantity > 0 ? 1 : -1;

    const { errors, columns } = validateMovementPayload(
        { ...body, quantity: Math.abs(signedQuantity) },
        { sign: direction, movementType }
    );

    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const currentBalance = Number(item.quantity_on_hand) || 0;
    if (direction < 0 && Math.abs(signedQuantity) > currentBalance) {
        return res.status(409).json(
            errorResponse(
                `Only ${currentBalance} ${item.unit_of_measure || 'unit'}(s) are on hand, so the ` +
                    `balance cannot be reduced by ${Math.abs(signedQuantity)}.`,
                [{ field: 'quantity', message: 'The adjustment would make the balance negative.' }]
            )
        );
    }

    return commitMovement(req, res, {
        item,
        columns,
        body,
        signedQuantity,
        movementType,
        action: movementType === 'Write Off' ? 'WRITE_OFF' : 'ADJUST',
        successMessage:
            movementType === 'Write Off'
                ? 'Stock write-off recorded successfully.'
                : 'Stock adjustment recorded successfully.'
    });
}

/**
 * POST /api/stock/movements/:id/reverse
 * Reverses a movement by appending a compensating entry (§5.7, §11).
 *
 * A reversal is the only way to undo a movement: the original row is never
 * edited or deleted, so the ledger remains a complete record of what happened.
 */
async function reverseStockMovement(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid movement id is required.'));
    }

    const original = await stockModel.findMovementById(id);
    if (!original) {
        return res.status(404).json(errorResponse('Stock movement not found.'));
    }

    if (original.reversed_by) {
        return res.status(409).json(
            errorResponse(
                `Movement ${original.movement_ref || `#${original.id}`} has already been reversed.`
            )
        );
    }

    // A compensating row must not itself be reversed - that would re-apply the
    // original movement under the guise of undoing it.
    if (original.reversed_movement_id) {
        return res.status(409).json(errorResponse('A reversal entry cannot itself be reversed.'));
    }

    const body = req.body || {};
    const movementDate = normaliseDate(body.movement_date) || today();

    const result = await stockModel.reverseMovement(id, {
        movement_ref: await generateMovementRef(),
        movement_date: movementDate,
        movement_type: 'Adjustment',
        reason:
            normalizeString(body.reason) ||
            `Reversal of ${original.movement_ref || `movement #${original.id}`}`,
        remarks: normalizeString(body.remarks) || null,
        recorded_by: req.user.id
    });

    const updated = result.original.stock_item_id
        ? await stockModel.findById(result.original.stock_item_id)
        : null;

    await recordAudit(req, {
        action: 'REVERSE',
        tableName: STOCK_MOVEMENT_TABLE,
        recordId: result.id,
        oldValues: {
            movement_ref: original.movement_ref,
            movement_type: original.movement_type,
            quantity: original.quantity
        },
        newValues: {
            reversal_of: original.id,
            balance_after: result.balance
        }
    });

    return res.status(201).json(
        successResponse('Stock movement reversed successfully.', {
            movement_id: result.id,
            reversal_of: original.id,
            balance_after: result.balance,
            stock_item: updated,
            item: updated
        })
    );
}

/**
 * PUT / PATCH /api/stock/:id
 * Corrects the catalogue details of a store card.
 *
 * The balance is deliberately not writable here: it only moves through the
 * ledger, so an "edit" can never be used to quietly restate the stock position.
 * Register-derived rows are read-only snapshots of the asset row.
 */
async function updateStockItem(req, res) {
    const existing = await resolveStockItem(req.params.id);

    if (!existing) {
        return res.status(404).json(errorResponse('Stock item not found.'));
    }

    if (isDerivedItem(existing)) {
        return res.status(409).json(
            errorResponse(
                'This item comes from the asset register and cannot be edited here. Open a store card for it instead.'
            )
        );
    }

    const { errors, data, columns } = validateItemPayload(req.body || {}, { isCreate: false });

    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    if (!Object.keys(columns).length) {
        return res.status(400).json(errorResponse('No recognised fields were supplied to update.'));
    }

    // Moving the card to a different asset must reference a real, uncarded asset.
    if (data.assetId !== undefined && data.assetId !== null) {
        const asset = await assetModel.findById(data.assetId);
        if (!asset) {
            return res.status(404).json(
                errorResponse('Asset not found.', [
                    { field: 'asset_id', message: 'No such asset.' }
                ])
            );
        }

        const clash = await stockModel.findByAssetId(asset.id);
        if (clash && Number(clash.id) !== Number(existing.id)) {
            return res.status(409).json(
                errorResponse(`That asset already has store card ${clash.item_ref}.`, [
                    {
                        field: 'asset_id',
                        message: `A card for this asset already exists (${clash.item_ref}).`
                    }
                ])
            );
        }
    }

    // Re-check the reorder bounds against whatever is already stored, so a
    // partial update supplying only one of them cannot invert the pair.
    const nextMinimum = columns.minimum_level !== undefined
        ? Number(columns.minimum_level)
        : Number(existing.minimum_level || 0);
    const nextMaximum = columns.maximum_level !== undefined
        ? columns.maximum_level
        : existing.maximum_level;

    if (nextMaximum !== null && nextMaximum !== undefined && Number(nextMaximum) < nextMinimum) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                { field: 'maximum_level', message: 'maximum_level cannot be below minimum_level.' }
            ])
        );
    }

    await stockModel.update(existing.id, columns);

    const updated = await stockModel.findById(existing.id);

    await recordAudit(req, {
        action: 'UPDATE',
        tableName: STOCK_ITEM_TABLE,
        recordId: existing.id,
        oldValues: existing,
        newValues: updated
    });

    return res.json(
        successResponse('Stock item updated successfully.', {
            stock_item: updated,
            item: updated
        })
    );
}


module.exports = {
    getAllStockItems,
    getStockStats,
    getStockBalances,
    getLowStock,
    getMovements,
    getRecentMovements,
    getMovementById,
    getAssetStock,
    getStockItemById,
    getStockMeta,

    createStockItem,
    updateStockItem,
    receiveStock,
    issueStock,
    returnStock,
    adjustStock,
    reverseStockMovement
};
