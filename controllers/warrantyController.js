'use strict';

// controllers/warrantyController.js
// Warranty and contract monitoring (§5.6 of the requirements): recording the
// warranty provider, start date and expiry date, alerting on upcoming expiries
// and monitoring support and maintenance contracts.
//
// Endpoints
//   GET    /api/warranties                            - list / search / filter + page
//   GET    /api/warranties/stats                      - aggregate warranty figures
//   GET    /api/warranties/meta                       - ENUM choices + pick-lists
//   GET    /api/warranties/expiring                   - upcoming expiry alerts (§5.6)
//   GET    /api/warranties/expired                    - cover that has already lapsed
//   GET    /api/warranties/recent                     - latest recordings (dashboard)
//   GET    /api/warranties/contracts                  - support & maintenance contracts
//   GET    /api/warranties/asset/:assetId             - one asset's coverage
//   GET    /api/warranties/:id                        - fetch one warranty
//   POST   /api/warranties                            - record a warranty / contract
//   PUT    /api/warranties/:id                        - correct the record
//   PATCH  /api/warranties/:id                        - partial update (same handler)
//   PATCH  /api/warranties/:id/status                 - move the lifecycle status
//   PATCH  /api/warranties/:id/renew                  - extend the cover
//   PATCH  /api/warranties/:id/cancel                 - retire a superseded record
//
// Conventions (mirrors maintenanceController):
//   * Handlers are async; Express 5 forwards rejected promises to the global
//     error handler, so no try/catch wrapper is needed for unexpected errors.
//   * Responses always use the shared { status, message, data } envelope.
//   * Records are never deleted - the coverage history is permanent.
//   * Every mutating handler writes an audit_logs row explicitly.
//
// Business rules (§5.6, §10, §12)
//   * A warranty must have a start date and an expiry date, and the expiry must
//     fall after the start.
//   * The expiry window for alerts is configurable (?days=, default 90) so §12's
//     "warranties expiring within configurable periods" is honoured.
//   * This module never mutates `assets.status`: a warranty lapsing is not a
//     custody or condition event, unlike a failed repair.
//   * A register warranty that has no explicit row yet is reported as a derived
//     entry so coverage captured at asset registration stays visible.

const warrantyModel = require('../models/warrantyModel');
const assetModel = require('../models/assetModel');
const userModel = require('../models/userModel');
const { auditLog } = require('../middleware/auditMiddleware');
const { ROLES } = require('../middleware/rbacMiddleware');
const {
    getClientIp,
    normalizeString,
    successResponse,
    errorResponse
} = require('../utils/helpers');

// Table name as it appears in audit_logs.table_name.
const WARRANTY_TABLE = 'warranties';

// ENUM values from the warranties schema. Kept here so validation and the /meta
// endpoint share a single source of truth.
const WARRANTY_TYPES = Object.freeze([
    'Asset Warranty',
    'Extended Warranty',
    'Support Contract',
    'Maintenance Contract',
    'Service Level Agreement',
    'Licence Support',
    'Insurance',
    'Other'
]);

const WARRANTY_STATUSES = Object.freeze(['Active', 'Expiring Soon', 'Expired', 'Cancelled']);

// The statuses that mean cover is still in force.
const OPEN_STATUSES = Object.freeze(['Active', 'Expiring Soon']);

// The types that represent a standing contract rather than a per-asset
// warranty, used by the /contracts view (§5.6 "support and maintenance
// contracts").
const CONTRACT_TYPES = Object.freeze([
    'Support Contract',
    'Maintenance Contract',
    'Service Level Agreement',
    'Licence Support'
]);

// Default alert window for §12's configurable expiry period.
const DEFAULT_EXPIRING_DAYS = 90;

// Guard rail so a caller cannot ask for a 100-year window by accident.
const MAX_EXPIRING_DAYS = 3650;

// Roles that may read the full warranty picture.
const READER_ROLES = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR];


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
 * Resolves a warranty from a numeric id or a WAR- reference, so a paper
 * certificate can be looked up directly.
 *
 * Derived (register) entries use a synthetic `asset-<id>` identifier; those are
 * read-only snapshots of the asset row, so they are resolved here for viewing
 * but the write handlers refuse them.
 *
 * @param {*} value
 * @returns {Promise<object|null>}
 */
async function resolveWarranty(value) {
    const key = normalizeString(value);
    if (!key) return null;

    const derived = /^asset-(\d+)$/i.exec(key);
    if (derived) {
        const asset = await assetModel.findById(derived[1]);
        return asset ? buildDerivedWarranty(asset) : null;
    }

    if (/^\d+$/.test(key)) return warrantyModel.findById(key);

    return warrantyModel.findByRef(key.toUpperCase());
}

/**
 * True when the resolved record is a register-derived (read-only) warranty
 * rather than a row in the `warranties` table.
 *
 * @param {object|null} record
 * @returns {boolean}
 */
function isDerived(record) {
    return !!record && record.source === 'asset_register';
}

/**
 * Builds the read-only warranty view of an asset's register columns so the
 * module reports coverage captured at registration (§6).
 *
 * @param {object} asset
 * @returns {object}
 */
function buildDerivedWarranty(asset) {
    const expiry = normaliseDate(asset.warranty_end);
    const remaining = daysUntil(expiry);

    let status = 'Active';
    if (remaining !== null && remaining < 0) status = 'Expired';
    else if (remaining !== null && remaining <= DEFAULT_EXPIRING_DAYS) status = 'Expiring Soon';

    return {
        id: `asset-${asset.id}`,
        source: 'asset_register',
        warranty_ref: asset.warranty_ref || null,
        asset_id: asset.id,
        asset_code: asset.asset_id,
        asset_tag: asset.asset_tag,
        serial_number: asset.serial_number,
        warranty_type: 'Asset Warranty',
        title: `Register warranty - ${asset.asset_tag}`,
        provider: asset.warranty_provider || null,
        start_date: normaliseDate(asset.warranty_start),
        expiry_date: expiry,
        status,
        coverage_state: status,
        days_remaining: remaining,
        auto_renew: 0,
        contract_value: 0,
        currency: null,
        notice_period_days: null,
        asset_status: asset.status,
        asset_condition: asset.condition_status,
        asset_location: asset.location,
        asset_department: asset.department,
        category_name: asset.category_name || null,
        read_only: true
    };
}

/**
 * Whole days from today until a YYYY-MM-DD date (negative when in the past).
 *
 * @param {string|null} date
 * @returns {number|null}
 */
function daysUntil(date) {
    if (!date) return null;

    const target = new Date(`${date}T00:00:00`);
    if (Number.isNaN(target.getTime())) return null;

    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    return Math.round((target.getTime() - midnight.getTime()) / 86400000);
}

/**
 * Resolves a user id from a request value, confirming the user exists.
 *
 * @param {*} value
 * @returns {Promise<object|null>}
 */
async function resolveUser(value) {
    const id = parseId(value);
    if (id === null) return null;
    return userModel.findById(id);
}

/**
 * The primary keys of the assets currently assigned to a user, used to scope a
 * Departmental User's view to their own custody (§9 least privilege).
 *
 * @param {number|string} userId
 * @returns {Promise<number[]>} Asset ids, or an empty array when none.
 */
async function assetsAssignedTo(userId) {
    try {
        const { assets } = await assetModel.findAll({
            assignedUserId: userId,
            limit: 500,
            offset: 0
        });
        return (assets || []).map((asset) => asset.id);
    } catch (err) {
        // Never fail the read because the scoping lookup misbehaved; the empty
        // array is the safe (most restrictive) answer.
        return [];
    }
}

/**
 * Mints the next warranty reference (WAR-000001) by reading the highest
 * existing suffix. A tiny race is possible between two simultaneous creates;
 * the UNIQUE index on `warranty_ref` turns that into a clean duplicate-key
 * error rather than a silently duplicated reference.
 *
 * @returns {Promise<string>}
 */
async function generateWarrantyRef() {
    const prefix = 'WAR-';
    try {
        const max = await warrantyModel.findMaxRefSuffix(prefix);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const candidate = `${prefix}${String(max + 1 + attempt).padStart(6, '0')}`;
            if (!(await warrantyModel.warrantyRefExists(candidate))) return candidate;
        }
        return `${prefix}${max + 6}`;
    } catch (err) {
        // Never let reference generation block a legitimate record.
        return `${prefix}${Date.now()}`;
    }
}

/**
 * Records a warranty audit entry, never throwing.
 *
 * @param {import('express').Request} req
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function recordAudit(req, payload) {
    await auditLog({
        userId: req.user ? req.user.id : payload.userId ?? null,
        action: payload.action,
        tableName: WARRANTY_TABLE,
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
 * Validates and normalises a warranty payload.
 *
 * `isCreate` toggles the rules: on create the start date and expiry date are
 * mandatory and an expiry before the start is rejected; on update every field
 * is optional and only the supplied keys are returned.
 *
 * @param {object} body Raw req.body.
 * @param {object} [options]
 * @param {boolean} [options.isCreate=false]
 * @returns {{errors: object[], data: object}}
 */
function validateWarrantyPayload(body, { isCreate = false } = {}) {
    const errors = [];
    const data = {};

    /* ------------------------------- Asset -------------------------------- */

    // A NULL asset is legitimate: a site-wide support contract covers the
    // estate rather than one machine. The controller re-checks this against the
    // database so a non-existent asset id cannot reach the FK.
    if (body.asset_id !== undefined) {
        if (body.asset_id === null || body.asset_id === '' || body.asset_id === 'none') {
            data.assetId = null;
        } else {
            const assetId = parseId(body.asset_id);
            if (assetId === null) {
                pushError(errors, 'asset_id', 'asset_id must reference a registered asset.');
            } else {
                data.assetId = assetId;
            }
        }
    }

    /* ------------------------------- Type --------------------------------- */

    if (body.warranty_type !== undefined) {
        const type = normalizeString(body.warranty_type);
        if (!WARRANTY_TYPES.includes(type)) {
            pushError(
                errors,
                'warranty_type',
                `warranty_type must be one of: ${WARRANTY_TYPES.join(', ')}.`
            );
        } else {
            data.warrantyType = type;
        }
    }

    /* ------------------------------ Status -------------------------------- */

    if (body.status !== undefined) {
        const status = normalizeString(body.status);
        if (!WARRANTY_STATUSES.includes(status)) {
            pushError(errors, 'status', `status must be one of: ${WARRANTY_STATUSES.join(', ')}.`);
        } else {
            data.status = status;
        }
    }

    /* ------------------------------ Dates --------------------------------- */

    if (body.start_date !== undefined) {
        if (body.start_date === null || body.start_date === '') {
            if (isCreate) {
                pushError(errors, 'start_date', 'The cover start date is required.');
            } else {
                data.startDate = null;
            }
        } else {
            const parsed = normaliseDate(body.start_date);
            if (!parsed) {
                pushError(errors, 'start_date', 'start_date must be a valid date (YYYY-MM-DD).');
            } else {
                data.startDate = parsed;
            }
        }
    } else if (isCreate) {
        pushError(errors, 'start_date', 'The cover start date is required.');
    }

    if (body.expiry_date !== undefined) {
        if (body.expiry_date === null || body.expiry_date === '') {
            if (isCreate) {
                pushError(errors, 'expiry_date', 'The cover expiry date is required.');
            } else {
                data.expiryDate = null;
            }
        } else {
            const parsed = normaliseDate(body.expiry_date);
            if (!parsed) {
                pushError(errors, 'expiry_date', 'expiry_date must be a valid date (YYYY-MM-DD).');
            } else {
                data.expiryDate = parsed;
            }
        }
    } else if (isCreate) {
        pushError(errors, 'expiry_date', 'The cover expiry date is required.');
    }

    // A warranty cannot expire before (or on the day) it starts.
    if (data.startDate && data.expiryDate && data.expiryDate <= data.startDate) {
        pushError(errors, 'expiry_date', 'expiry_date must be later than start_date.');
    }


    /* --------------------------- Notice & renewal ------------------------- */

    if (body.notice_period_days !== undefined) {
        if (body.notice_period_days === null || body.notice_period_days === '') {
            data.noticePeriodDays = null;
        } else {
            const days = Number(body.notice_period_days);
            if (!Number.isInteger(days) || days < 0 || days > 3650) {
                pushError(
                    errors,
                    'notice_period_days',
                    'notice_period_days must be a whole number of days between 0 and 3650.'
                );
            } else {
                data.noticePeriodDays = days;
            }
        }
    }

    if (body.auto_renew !== undefined) {
        const autoRenew = parseBoolean(body.auto_renew);
        if (autoRenew === null) {
            pushError(errors, 'auto_renew', 'auto_renew must be true or false.');
        } else {
            data.autoRenew = autoRenew;
        }
    }

    /* ------------------------------- Value -------------------------------- */

    if (body.contract_value !== undefined) {
        const value = parseMoney(body.contract_value);
        if (value === null) {
            pushError(errors, 'contract_value', 'contract_value must be a non-negative amount.');
        } else {
            data.contractValue = value;
        }
    }

    if (body.currency !== undefined) {
        const currency = normalizeString(body.currency).toUpperCase();
        data.currency = currency || null;
    }

    /* ------------------------------ Text fields ---------------------------- */

    const textFields = [
        ['title', 'title'],
        ['contract_ref', 'contractRef'],
        ['provider', 'provider'],
        ['provider_contact', 'providerContact'],
        ['provider_email', 'providerEmail'],
        ['provider_phone', 'providerPhone'],
        ['coverage_details', 'coverageDetails'],
        ['excluded_items', 'excludedItems'],
        ['payment_terms', 'paymentTerms'],
        ['remarks', 'remarks']
    ];

    for (const [field, key] of textFields) {
        if (body[field] === undefined) continue;
        const text = normalizeString(body[field]);
        data[key] = text || null;
    }

    /* ---------------------------- Field length caps ------------------------ */

    const caps = [
        ['title', 150, 'title'],
        ['contractRef', 100, 'contract_ref'],
        ['provider', 150, 'provider'],
        ['providerContact', 100, 'provider_contact'],
        ['providerEmail', 100, 'provider_email'],
        ['providerPhone', 50, 'provider_phone'],
        ['currency', 10, 'currency'],
        ['paymentTerms', 100, 'payment_terms'],
        ['cancellationReason', 255, 'cancellation_reason']
    ];

    for (const [key, max, field] of caps) {
        if (data[key] && data[key].length > max) {
            pushError(errors, field, `${field} must be ${max} characters or fewer.`);
        }
    }

    // A provider e-mail, when supplied, must look like one.
    if (data.providerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.providerEmail)) {
        pushError(errors, 'provider_email', 'provider_email must be a valid e-mail address.');
    }

    return { errors, data };
}


/**
 * Maps the controller's camelCase payload keys onto the database column names
 * the model expects.
 *
 * @param {object} data Output of validateWarrantyPayload.
 * @param {boolean} forInsert When true, the insert defaults are applied so the
 *        INSERT has a predictable shape.
 * @returns {object}
 */
function toColumns(data, forInsert = false) {
    const out = {};

    const set = (column, value) => {
        if (value !== undefined) out[column] = value;
    };

    set('asset_id', data.assetId);
    set('warranty_type', data.warrantyType);
    set('title', data.title);
    set('contract_ref', data.contractRef);
    set('provider', data.provider);
    set('provider_contact', data.providerContact);
    set('provider_email', data.providerEmail);
    set('provider_phone', data.providerPhone);
    set('start_date', data.startDate);
    set('expiry_date', data.expiryDate);
    set('notice_period_days', data.noticePeriodDays);
    set('auto_renew', data.autoRenew);
    set('coverage_details', data.coverageDetails);
    set('excluded_items', data.excludedItems);
    set('contract_value', data.contractValue);
    set('currency', data.currency);
    set('payment_terms', data.paymentTerms);
    set('status', data.status);
    set('cancelled_date', data.cancelledDate);
    set('cancellation_reason', data.cancellationReason);
    set('remarks', data.remarks);

    if (forInsert) {
        if (out.warranty_type === undefined) out.warranty_type = 'Asset Warranty';
        if (out.status === undefined) out.status = 'Active';
        if (out.contract_value === undefined) out.contract_value = 0;
        if (out.auto_renew === undefined) out.auto_renew = 0;
    }

    return out;
}


/* ========================================================================== */
/* Reads                                                                      */
/* ========================================================================== */

/**
 * GET /api/warranties
 * Lists warranties with search, filtering and pagination.
 *
 * The list merges stored warranty / contract rows with the warranty windows
 * carried on the asset register, so coverage captured at registration (§6) is
 * reported alongside explicitly recorded contracts.
 *
 * A Departmental User is scoped server-side to the assets assigned to them -
 * the same least-privilege posture used by the other lifecycle modules.
 *
 * Query parameters: search, status, warranty_type, provider, asset_id,
 * date_from, date_to, expiring_days, expired, include_derived, sort, order,
 * limit, offset.
 */
async function getAllWarranties(req, res) {
    const isPrivileged = READER_ROLES.includes(req.user.role);

    const status = normalizeString(req.query.status) || undefined;

    const options = {
        search: normalizeString(req.query.search) || undefined,
        status,
        warrantyType: normalizeString(req.query.warranty_type) || undefined,
        provider: normalizeString(req.query.provider) || undefined,
        assetId: parseId(req.query.asset_id) || undefined,
        dateFrom: normaliseDate(req.query.date_from) || undefined,
        dateTo: normaliseDate(req.query.date_to) || undefined,
        limit: req.query.limit,
        offset: req.query.offset,
        sort: normalizeString(req.query.sort) || undefined,
        order: normalizeString(req.query.order) || undefined,
        includeDerived: req.query.include_derived === undefined
            ? true
            : parseBoolean(req.query.include_derived) !== false
    };

    // §12: warranties expiring within a configurable period.
    if (req.query.expiring_days !== undefined && req.query.expiring_days !== '') {
        options.expiringDays = parseCount(
            req.query.expiring_days,
            DEFAULT_EXPIRING_DAYS,
            MAX_EXPIRING_DAYS
        );
    }

    const expired = parseBoolean(req.query.expired);
    if (expired === true) options.expiredOnly = true;

    // A Departmental User only sees cover on the assets in their custody.
    if (!isPrivileged) {
        options.assetIds = await assetsAssignedTo(req.user.id);
    }

    const { rows, total, derived } = await warrantyModel.findAll(options);

    return res.json(
        successResponse('Warranties retrieved successfully.', {
            warranties: rows,
            total,
            returned: rows.length,
            derived,
            limit: Number(options.limit) || 50,
            offset: Number(options.offset) || 0
        })
    );
}


/**
 * GET /api/warranties/stats
 * Aggregate warranty and contract figures for the dashboard (§12).
 *
 * Accepts ?days= so the "expiring within" window matches whatever the caller is
 * displaying.
 */
async function getWarrantyStats(req, res) {
    const days = parseCount(req.query.days, DEFAULT_EXPIRING_DAYS, MAX_EXPIRING_DAYS);
    const stats = await warrantyModel.getStats(days);

    return res.json(successResponse('Warranty statistics retrieved successfully.', stats));
}

/**
 * GET /api/warranties/meta
 * Reference data for the warranty forms: ENUM choices, the next reference and
 * the pick-lists the UI needs.
 */
async function getWarrantyMeta(req, res) {
    const nextRef = await generateWarrantyRef();

    let userList = [];
    let assetList = [];

    try {
        // userModel.findAll returns { users, total } - not a bare array.
        const users = await userModel.findAll({ limit: 500, isActive: true });
        userList = Array.isArray(users) ? users : users.users || [];
    } catch (err) {
        userList = [];
    }

    try {
        // assetModel.findAll returns { assets, total } - not a bare array.
        const assets = await assetModel.findAll({ limit: 500, excludeDisposed: true });
        assetList = Array.isArray(assets) ? assets : assets.assets || [];
    } catch (err) {
        assetList = [];
    }

    return res.json(
        successResponse('Warranty reference data retrieved successfully.', {
            warranty_types: [...WARRANTY_TYPES],
            contract_types: [...CONTRACT_TYPES],
            statuses: [...WARRANTY_STATUSES],
            open_statuses: [...OPEN_STATUSES],
            default_expiring_days: DEFAULT_EXPIRING_DAYS,
            max_expiring_days: MAX_EXPIRING_DAYS,
            next_ref: nextRef,
            users: userList.map((user) => ({
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role
            })),
            assets: assetList.map((asset) => ({
                id: asset.id,
                asset_id: asset.asset_id,
                asset_tag: asset.asset_tag,
                serial_number: asset.serial_number,
                status: asset.status,
                condition_status: asset.condition_status,
                location: asset.location,
                department: asset.department,
                warranty_provider: asset.warranty_provider,
                warranty_start: asset.warranty_start,
                warranty_end: asset.warranty_end,
                warranty_ref: asset.warranty_ref
            }))
        })
    );
}


/**
 * GET /api/warranties/expiring
 * The upcoming-expiry alert list (§5.6). ?days= makes the window configurable
 * (§12); the response also reports the window it used.
 */
async function getExpiringWarranties(req, res) {
    const days = parseCount(req.query.days, DEFAULT_EXPIRING_DAYS, MAX_EXPIRING_DAYS);
    const limit = parseCount(req.query.limit, 100, 500);

    const includeDerived = parseBoolean(req.query.include_derived) !== false;

    const assetIds = READER_ROLES.includes(req.user.role)
        ? undefined
        : await assetsAssignedTo(req.user.id);
    const stored = await warrantyModel.findExpiring(days, { limit, assetIds });
    const derivedRows = includeDerived
        ? await warrantyModel.findExpiringOnAssets(days, limit, assetIds)
        : [];

    // Merge and sort by urgency so the most imminent expiry is first.
    const rows = [...stored, ...derivedRows].sort((a, b) => {
        const left = new Date(a.expiry_date).getTime();
        const right = new Date(b.expiry_date).getTime();
        return left - right;
    });

    return res.json(
        successResponse('Warranties expiring soon retrieved successfully.', {
            warranties: rows,
            total: rows.length,
            returned: rows.length,
            expiring_days: days,
            derived: derivedRows.length
        })
    );
}

/**
 * GET /api/warranties/expired
 * Coverage that has already lapsed and was never closed off.
 */
async function getExpiredWarranties(req, res) {
    const limit = parseCount(req.query.limit, 100, 500);
    const assetIds = READER_ROLES.includes(req.user.role)
        ? undefined
        : await assetsAssignedTo(req.user.id);
    const rows = await warrantyModel.findExpired(limit, assetIds);

    return res.json(
        successResponse('Expired warranties retrieved successfully.', {
            warranties: rows,
            total: rows.length,
            returned: rows.length
        })
    );
}

/**
 * GET /api/warranties/recent
 * The most recently recorded warranties, for the dashboard panel.
 */
async function getRecentWarranties(req, res) {
    const limit = parseCount(req.query.limit, 10, 100);
    const assetIds = READER_ROLES.includes(req.user.role)
        ? undefined
        : await assetsAssignedTo(req.user.id);
    const rows = await warrantyModel.findRecent(limit, assetIds);

    return res.json(
        successResponse('Recent warranties retrieved successfully.', {
            warranties: rows,
            returned: rows.length
        })
    );
}

/**
 * GET /api/warranties/contracts
 * Support and maintenance contracts (§5.6), with the option to include those
 * that have already lapsed.
 */
async function getContracts(req, res) {
    const activeOnly = parseBoolean(req.query.active_only) !== false;
    const assetIds = READER_ROLES.includes(req.user.role)
        ? undefined
        : await assetsAssignedTo(req.user.id);
    const rows = await warrantyModel.findContracts({ activeOnly, assetIds });

    return res.json(
        successResponse('Support and maintenance contracts retrieved successfully.', {
            warranties: rows,
            contracts: rows,
            total: rows.length,
            returned: rows.length,
            active_only: activeOnly
        })
    );
}


/**
 * GET /api/warranties/asset/:assetId
 * Every warranty and contract recorded for one asset, plus the register's own
 * warranty window so the complete coverage position is visible in one call.
 */
async function getAssetWarranties(req, res) {
    const asset = await resolveAsset(req.params.assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }
    if (
        !READER_ROLES.includes(req.user.role) &&
        Number(asset.assigned_user_id) !== Number(req.user.id)
    ) {
        return res.status(404).json(errorResponse('Asset warranty not found.'));
    }

    const rows = await warrantyModel.findByAssetId(asset.id);
    const registerWarranty = buildDerivedWarranty(asset);

    const coveredByContract = rows.some((row) => OPEN_STATUSES.includes(row.status));

    return res.json(
        successResponse('Asset warranties retrieved successfully.', {
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
            warranties: rows,
            total: rows.length,
            register_warranty: registerWarranty,
            under_warranty: registerWarranty.status !== 'Expired' || coveredByContract
        })
    );
}

/**
 * GET /api/warranties/:id
 * Fetches one warranty by numeric id, WAR- reference or the derived
 * `asset-<id>` identifier.
 */
async function getWarrantyById(req, res) {
    const record = await resolveWarranty(req.params.id);
    if (!record) {
        return res.status(404).json(errorResponse('Warranty record not found.'));
    }
    if (!READER_ROLES.includes(req.user.role)) {
        const assetId = Number(record.asset_id);
        const asset = assetId ? await assetModel.findById(assetId) : null;
        if (!asset || Number(asset.assigned_user_id) !== Number(req.user.id)) {
            return res.status(404).json(errorResponse('Warranty record not found.'));
        }
    }

    return res.json(successResponse('Warranty retrieved successfully.', { warranty: record }));
}


/* ========================================================================== */
/* Writes                                                                     */
/* ========================================================================== */

/**
 * POST /api/warranties
 * Records a warranty, extended warranty or a support / maintenance contract
 * (§5.6).
 *
 * The record is validated against the register first so a bad asset id can
 * never reach the foreign key, and the reference is minted server-side.
 */
async function createWarranty(req, res) {
    const { errors, data } = validateWarrantyPayload(req.body, { isCreate: true });

    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    // A named asset must exist, and a disposed one is not worth covering.
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

        if (['Disposed', 'Retired'].includes(asset.status)) {
            return res.status(400).json(
                errorResponse(`A ${asset.status.toLowerCase()} asset cannot be covered.`, [
                    { field: 'asset_id', message: `The asset is ${asset.status}.` }
                ])
            );
        }
    }

    const ref = await generateWarrantyRef();

    const columns = toColumns(
        {
            ...data,
            status: data.status || 'Active'
        },
        true
    );
    columns.warranty_ref = ref;
    columns.created_by = req.user.id;

    const id = await warrantyModel.create(columns);
    const created = await warrantyModel.findById(id);

    await recordAudit(req, {
        action: 'CREATE',
        recordId: id,
        newValues: created
    });

    return res.status(201).json(
        successResponse('Warranty recorded successfully.', {
            warranty: created,
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
 * PUT / PATCH /api/warranties/:id
 * Corrects the descriptive details of a warranty or contract.
 *
 * Register-derived entries are read-only snapshots of the asset row; the caller
 * is told to edit the asset instead so the change is not silently discarded.
 */
async function updateWarranty(req, res) {
    const existing = await resolveWarranty(req.params.id);
    if (!existing) {
        return res.status(404).json(errorResponse('Warranty record not found.'));
    }

    if (isDerived(existing)) {
        return res.status(409).json(
            errorResponse(
                'This warranty comes from the asset register and cannot be edited here. Update the asset instead.'
            )
        );
    }

    if (existing.status === 'Cancelled') {
        return res.status(409).json(
            errorResponse('A cancelled warranty cannot be edited. Record a new one instead.')
        );
    }

    const { errors, data } = validateWarrantyPayload(req.body || {}, { isCreate: false });
    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    // Re-check the dates against whatever is already stored, so a partial update
    // supplying only one of them cannot create an invalid window.
    const nextStart = data.startDate !== undefined ? data.startDate : normaliseDate(existing.start_date);
    const nextExpiry = data.expiryDate !== undefined ? data.expiryDate : normaliseDate(existing.expiry_date);

    if (nextStart && nextExpiry && nextExpiry <= nextStart) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                { field: 'expiry_date', message: 'expiry_date must be later than start_date.' }
            ])
        );
    }

    // Moving the record to a different asset must reference a real one.
    if (data.assetId !== undefined && data.assetId !== null) {
        const asset = await assetModel.findById(data.assetId);
        if (!asset) {
            return res.status(404).json(
                errorResponse('Asset not found.', [
                    { field: 'asset_id', message: 'No such asset.' }
                ])
            );
        }
    }

    const columns = toColumns(data, false);

    if (!Object.keys(columns).length) {
        return res.status(400).json(errorResponse('No updatable fields were supplied.'));
    }

    await warrantyModel.update(existing.id, columns);
    const updated = await warrantyModel.findById(existing.id);

    await recordAudit(req, {
        action: 'UPDATE',
        recordId: existing.id,
        oldValues: existing,
        newValues: updated
    });

    return res.json(successResponse('Warranty updated successfully.', { warranty: updated }));
}

/**
 * PATCH /api/warranties/:id/status
 * Moves a warranty to any valid lifecycle status.
 *
 * The derived statuses ('Expiring Soon', 'Expired') are computed from the dates
 * by the reads; allowing them to be set explicitly lets an administrator
 * acknowledge an expiry they have already actioned.
 */
async function setWarrantyStatus(req, res) {
    const existing = await resolveWarranty(req.params.id);
    if (!existing) {
        return res.status(404).json(errorResponse('Warranty record not found.'));
    }

    if (isDerived(existing)) {
        return res.status(409).json(
            errorResponse(
                'This warranty comes from the asset register and has no separate status. Update the asset instead.'
            )
        );
    }

    const status = normalizeString(req.body && req.body.status);
    if (!WARRANTY_STATUSES.includes(status)) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                {
                    field: 'status',
                    message: `status must be one of: ${WARRANTY_STATUSES.join(', ')}.`
                }
            ])
        );
    }

    if (existing.status === 'Cancelled' && status !== 'Cancelled') {
        return res.status(409).json(
            errorResponse('A cancelled warranty cannot be reactivated. Record a new one instead.')
        );
    }

    const reason = normalizeString(req.body && req.body.reason);
    const columns = { status };

    if (status === 'Cancelled') {
        columns.cancelled_date = today();
        if (reason) columns.cancellation_reason = reason;
    }

    await warrantyModel.update(existing.id, columns);
    const updated = await warrantyModel.findById(existing.id);

    await recordAudit(req, {
        action: status === 'Cancelled' ? 'CANCEL' : 'STATUS_CHANGE',
        recordId: existing.id,
        oldValues: { status: existing.status },
        newValues: { status: updated.status, reason: reason || null }
    });

    return res.json(successResponse('Warranty status updated successfully.', { warranty: updated }));
}


/**
 * PATCH /api/warranties/:id/renew
 * Extends the cover (§5.6 "allow monitoring of support and maintenance
 * contracts" - renewals are the recurring activity on those).
 *
 * Renewal never overwrites the old record: the previous row is cancelled with a
 * link to its successor and a new row is inserted, so the coverage history and
 * the money spent on each period stay intact (§10).
 *
 * Accepts expiry_date (required), plus any other writable field to carry over
 * changed terms (provider, contract_value, notice_period_days, ...).
 */
async function renewWarranty(req, res) {
    const existing = await resolveWarranty(req.params.id);
    if (!existing) {
        return res.status(404).json(errorResponse('Warranty record not found.'));
    }

    if (isDerived(existing)) {
        return res.status(409).json(
            errorResponse(
                'This warranty comes from the asset register. Record a new warranty to extend it.'
            )
        );
    }

    if (existing.status === 'Cancelled') {
        return res.status(409).json(errorResponse('A cancelled warranty cannot be renewed.'));
    }

    const body = req.body || {};

    const newExpiry = normaliseDate(body.expiry_date);
    if (!newExpiry) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                {
                    field: 'expiry_date',
                    message: 'A new expiry_date (YYYY-MM-DD) is required to renew cover.'
                }
            ])
        );
    }

    // The renewed cover starts the day after the old one ended, unless the
    // caller states otherwise (e.g. cover bought early overlaps the old term).
    const oldStart = normaliseDate(existing.start_date);
    const oldExpiry = normaliseDate(existing.expiry_date);

    let newStart = normaliseDate(body.start_date);
    if (!newStart) {
        if (oldExpiry) {
            const next = new Date(`${oldExpiry}T00:00:00`);
            next.setDate(next.getDate() + 1);
            const pad = (n) => String(n).padStart(2, '0');
            newStart = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
        } else {
            newStart = today();
        }
    }

    if (newExpiry <= newStart) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                { field: 'expiry_date', message: 'expiry_date must be later than start_date.' }
            ])
        );
    }

    // Reuse the standard validator for the carried-over terms so the renewal
    // cannot smuggle in a value the create path would reject.
    const carry = { ...body };
    delete carry.expiry_date;
    delete carry.start_date;
    delete carry.status;
    delete carry.warranty_ref;

    const { errors, data } = validateWarrantyPayload(carry, { isCreate: false });
    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const ref = await generateWarrantyRef();


    const columns = toColumns(
        {
            ...data,
            // Inherit everything the caller did not restate.
            assetId: data.assetId !== undefined ? data.assetId : existing.asset_id,
            warrantyType: data.warrantyType || existing.warranty_type,
            title: data.title !== undefined ? data.title : existing.title,
            contractRef: data.contractRef !== undefined ? data.contractRef : existing.contract_ref,
            provider: data.provider !== undefined ? data.provider : existing.provider,
            providerContact:
                data.providerContact !== undefined ? data.providerContact : existing.provider_contact,
            providerEmail:
                data.providerEmail !== undefined ? data.providerEmail : existing.provider_email,
            providerPhone:
                data.providerPhone !== undefined ? data.providerPhone : existing.provider_phone,
            noticePeriodDays:
                data.noticePeriodDays !== undefined
                    ? data.noticePeriodDays
                    : existing.notice_period_days,
            autoRenew: data.autoRenew !== undefined ? data.autoRenew : !!existing.auto_renew,
            coverageDetails:
                data.coverageDetails !== undefined ? data.coverageDetails : existing.coverage_details,
            excludedItems:
                data.excludedItems !== undefined ? data.excludedItems : existing.excluded_items,
            contractValue:
                data.contractValue !== undefined ? data.contractValue : existing.contract_value,
            currency: data.currency !== undefined ? data.currency : existing.currency,
            paymentTerms:
                data.paymentTerms !== undefined ? data.paymentTerms : existing.payment_terms,
            remarks: data.remarks !== undefined ? data.remarks : existing.remarks,
            startDate: newStart,
            expiryDate: newExpiry,
            status: 'Active'
        },
        true
    );

    columns.warranty_ref = ref;
    columns.renewed_from = existing.id;
    columns.created_by = req.user.id;

    const id = await warrantyModel.create(columns);

    // Close the superseded period, pointing at its successor.
    await warrantyModel.update(existing.id, {
        status: 'Cancelled',
        cancelled_date: oldExpiry || today(),
        cancellation_reason: `Renewed as ${ref}${oldStart ? ` (previous cover to ${oldExpiry})` : ''}`
    });

    const created = await warrantyModel.findById(id);
    const closed = await warrantyModel.findById(existing.id);

    await recordAudit(req, {
        action: 'RENEW',
        recordId: id,
        oldValues: { id: existing.id, warranty_ref: existing.warranty_ref, expiry_date: oldExpiry },
        newValues: created
    });

    return res.status(201).json(
        successResponse('Warranty renewed successfully.', {
            warranty: created,
            previous: closed,
            previous_ref: existing.warranty_ref
        })
    );
}


/**
 * PATCH /api/warranties/:id/cancel
 * Retires a warranty that has been superseded or was recorded in error. The row
 * is kept so the coverage history stays complete (§10), but it no longer counts
 * as cover in force.
 */
async function cancelWarranty(req, res) {
    const existing = await resolveWarranty(req.params.id);
    if (!existing) {
        return res.status(404).json(errorResponse('Warranty record not found.'));
    }

    if (isDerived(existing)) {
        return res.status(409).json(
            errorResponse(
                'This warranty comes from the asset register and cannot be cancelled here. Clear the warranty dates on the asset instead.'
            )
        );
    }

    if (existing.status === 'Cancelled') {
        return res.status(409).json(errorResponse('This warranty has already been cancelled.'));
    }

    const reason = normalizeString(req.body && req.body.reason);
    const columns = {
        status: 'Cancelled',
        cancelled_date: normaliseDate(req.body && req.body.cancelled_date) || today()
    };

    if (reason) columns.cancellation_reason = reason;

    await warrantyModel.update(existing.id, columns);
    const updated = await warrantyModel.findById(existing.id);

    await recordAudit(req, {
        action: 'CANCEL',
        recordId: existing.id,
        oldValues: { status: existing.status },
        newValues: { status: 'Cancelled', reason: reason || null }
    });

    return res.json(successResponse('Warranty cancelled successfully.', { warranty: updated }));
}


/* ========================================================================== */
/* Exports                                                                    */
/* ========================================================================== */

module.exports = {
    // Reads
    getAllWarranties,
    getWarrantyStats,
    getWarrantyMeta,
    getExpiringWarranties,
    getExpiredWarranties,
    getRecentWarranties,
    getContracts,
    getAssetWarranties,
    getWarrantyById,

    // Writes
    createWarranty,
    updateWarranty,
    setWarrantyStatus,
    renewWarranty,
    cancelWarranty,

    // Exposed for the test suite and future modules
    WARRANTY_TYPES,
    WARRANTY_STATUSES,
    CONTRACT_TYPES,
    OPEN_STATUSES,
    DEFAULT_EXPIRING_DAYS,
    MAX_EXPIRING_DAYS
};
