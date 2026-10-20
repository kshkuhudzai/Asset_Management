'use strict';

﻿// controllers/maintenanceController.js
// Maintenance and repairs (Â§5.5 of the requirements): recording faults, service
// requests and maintenance activities, tracking the technician/vendor, dates,
// cost, parts and resolution, and keeping the asset register in step while an
// asset is under repair.
//
// Endpoints
//   GET    /api/maintenance                        - list / search / filter + page
//   GET    /api/maintenance/stats                  - aggregate maintenance figures
//   GET    /api/maintenance/meta                   - ENUM choices + pick-lists
//   GET    /api/maintenance/recent                 - latest reported faults
//   GET    /api/maintenance/open                   - assets currently under repair
//   GET    /api/maintenance/overdue                - open jobs past their date
//   GET    /api/maintenance/asset/:assetId/history - the asset's repair history
//   GET    /api/maintenance/asset/:assetId/open    - open jobs for one asset
//   GET    /api/maintenance/user/:userId           - jobs raised by one user
//   GET    /api/maintenance/:id                    - fetch one record
//   POST   /api/maintenance                        - report a fault / book a service
//   PUT    /api/maintenance/:id                    - correct the record
//   PATCH  /api/maintenance/:id/status             - advance the workflow
//   PATCH  /api/maintenance/:id/start              - begin the work
//   PATCH  /api/maintenance/:id/complete           - finish the job
//   PATCH  /api/maintenance/:id/cancel             - withdraw a mistaken record
//
// Conventions (mirrors transferController):
//   * Handlers are async; Express 5 forwards rejected promises to the global
//     error handler, so no try/catch wrapper is needed for unexpected errors.
//   * Responses always use the shared { status, message, data } envelope.
//   * Records are never deleted - the repair history is permanent.
//   * Every mutating handler writes an audit_logs row explicitly.
//
// Business rule (Â§5.5 "Track assets currently under repair")
//   * Recording an open job (Pending / In Progress / On Hold) moves the asset
//     to status 'Under Repair'.
//   * Completing or cancelling the last open job restores the asset to 'In Use'
//     when it still has a custodian, otherwise 'In Stock'. The asset's
//     condition is also refreshed from `condition_after` when supplied.

const maintenanceModel = require('../models/maintenanceModel');
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
const MAINTENANCE_TABLE = 'maintenance_records';

// ENUM values from the maintenance_records schema. Kept here so validation and
// the /meta endpoint share a single source of truth.
const MAINTENANCE_TYPES = Object.freeze([
    'Repair',
    'Service',
    'Inspection',
    'Upgrade',
    'Warranty Claim',
    'Other'
]);

const PRIORITIES = Object.freeze(['Low', 'Medium', 'High', 'Critical']);

const MAINTENANCE_STATUSES = Object.freeze([
    'Pending',
    'In Progress',
    'Completed',
    'On Hold',
    'Cancelled'
]);

// Statuses that mean the asset is still out of service.
const OPEN_STATUSES = Object.freeze(['Pending', 'In Progress', 'On Hold']);

// Statuses that mean the job is finished. A cancelled record may still be read
// (history is permanent) but may not be advanced again.
const CLOSED_STATUSES = Object.freeze(['Completed', 'Cancelled']);

// Asset condition ENUM from the `assets` table.
const ASSET_CONDITIONS = Object.freeze(['Good', 'Fair', 'Damaged', 'Obsolete']);

// Reference prefix for the human-quotable job reference (MNT-000001).
const MAINTENANCE_REF_PREFIX = 'MNT-';

// Roles that may read the full maintenance picture.
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
 * True when the string is a real calendar date in YYYY-MM-DD form.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00`);
    return !Number.isNaN(parsed.getTime());
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
 * Today's date as YYYY-MM-DD (used for the default reported date).
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
 * Resolves a maintenance record from a numeric id or a MNT- reference, so a
 * paper job card can be looked up directly.
 *
 * @param {*} value
 * @returns {Promise<object|null>}
 */
async function resolveRecord(value) {
    const key = normalizeString(value);
    if (!key) return null;

    if (/^\d+$/.test(key)) return maintenanceModel.findById(key);

    const ref = key.toUpperCase();
    return maintenanceModel.findByRef(ref);
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
 * Mints the next maintenance reference (MNT-000001) by reading the highest
 * existing suffix. A tiny race is possible between two simultaneous creates;
 * the UNIQUE index on `maintenance_ref` turns that into a clean duplicate-key
 * error rather than a silently duplicated reference.
 *
 * @returns {Promise<string>}
 */
async function generateMaintenanceRef() {
    try {
        const max = await maintenanceModel.findMaxRefSuffix(MAINTENANCE_REF_PREFIX);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const candidate = `${MAINTENANCE_REF_PREFIX}${String(max + 1 + attempt).padStart(6, '0')}`;
            if (!(await maintenanceModel.maintenanceRefExists(candidate))) return candidate;
        }
        return `${MAINTENANCE_REF_PREFIX}${max + 6}`;
    } catch (err) {
        // Never let reference generation block a legitimate record.
        return `${MAINTENANCE_REF_PREFIX}${Date.now()}`;
    }
}

/**
 * Records a maintenance audit entry, never throwing.
 *
 * @param {import('express').Request} req
 * @param {object} payload
 * @returns {Promise<void>}
 */
async function recordAudit(req, payload) {
    await auditLog({
        userId: req.user ? req.user.id : payload.userId ?? null,
        action: payload.action,
        tableName: MAINTENANCE_TABLE,
        recordId: payload.recordId ?? 0,
        oldValues: payload.oldValues ?? null,
        newValues: payload.newValues ?? null,
        ipAddress: getClientIp(req)
    });
}

/**
 * Keeps `assets.status` / `assets.condition_status` in step with the open
 * maintenance records for an asset (Â§5.5 "track assets currently under
 * repair").
 *
 * When `forceStatus` is supplied (i.e. right after a status transition) it is
 * applied directly; otherwise the status is derived from whether any open
 * record remains. Terminal asset states ('Retired', 'Disposed') and 'Missing'
 * are never overwritten - a repair record must not resurrect a written-off
 * asset.
 *
 * @param {object} asset
 * @param {object} [options]
 * @param {string} [options.condition] New condition, when the job recorded one.
 * @param {string} [options.forceStatus] Status to apply instead of deriving it.
 * @returns {Promise<void>}
 */
async function syncAssetState(asset, { condition = null, forceStatus = null } = {}) {
    if (!asset) return;

    const updates = {};

    if (condition && ASSET_CONDITIONS.includes(condition)) {
        updates.conditionStatus = condition;
    }

    const PROTECTED = ['Retired', 'Disposed', 'Missing'];

    if (!PROTECTED.includes(asset.status)) {
        let nextStatus = forceStatus;

        if (!nextStatus) {
            const stillOpen = await maintenanceModel.countByAssetId(asset.id, [...OPEN_STATUSES]);
            nextStatus = stillOpen > 0 ? 'Under Repair' : asset.assigned_user_id ? 'In Use' : 'In Stock';
        }

        if (nextStatus && nextStatus !== asset.status) {
            updates.status = nextStatus;
        }
    }

    if (Object.keys(updates).length) {
        await assetModel.update(asset.id, updates);
    }
}

/* ========================================================================== */
/* Validation                                                                 */
/* ========================================================================== */

/**
 * Validates and normalises a maintenance payload.
 *
 * `isCreate` toggles the rules: on create the asset, reported date and a fault
 * description (for a Repair) are mandatory; on update every field is optional
 * and only the supplied keys are returned.
 *
 * @param {object} body Raw req.body.
 * @param {object} [options]
 * @param {boolean} [options.isCreate=false]
 * @returns {{errors: object[], data: object}}
 */
function validateMaintenancePayload(body, { isCreate = false } = {}) {
    const errors = [];
    const data = {};

    /* ------------------------------- Asset -------------------------------- */

    if (body.asset_id !== undefined) {
        const assetId = parseId(body.asset_id);
        if (assetId === null) {
            pushError(errors, 'asset_id', 'asset_id must reference a registered asset.');
        } else {
            data.assetId = assetId;
        }
    } else if (isCreate) {
        pushError(errors, 'asset_id', 'The asset is required.');
    }

    /* ------------------------------- Type --------------------------------- */

    if (body.maintenance_type !== undefined) {
        const type = normalizeString(body.maintenance_type);
        if (!MAINTENANCE_TYPES.includes(type)) {
            pushError(
                errors,
                'maintenance_type',
                `maintenance_type must be one of: ${MAINTENANCE_TYPES.join(', ')}.`
            );
        } else {
            data.maintenanceType = type;
        }
    }

    /* ------------------------------ Priority ------------------------------ */

    if (body.priority !== undefined) {
        const priority = normalizeString(body.priority);
        if (!PRIORITIES.includes(priority)) {
            pushError(errors, 'priority', `priority must be one of: ${PRIORITIES.join(', ')}.`);
        } else {
            data.priority = priority;
        }
    }

    /* ------------------------------ Status -------------------------------- */

    if (body.status !== undefined) {
        const status = normalizeString(body.status);
        if (!MAINTENANCE_STATUSES.includes(status)) {
            pushError(
                errors,
                'status',
                `status must be one of: ${MAINTENANCE_STATUSES.join(', ')}.`
            );
        } else {
            data.status = status;
        }
    }

    /* ------------------------------ Dates --------------------------------- */

    const dateFields = [
        ['reported_date', 'reportedDate'],
        ['scheduled_date', 'scheduledDate'],
        ['start_date', 'startDate'],
        ['completion_date', 'completionDate']
    ];

    for (const [field, key] of dateFields) {
        if (body[field] === undefined) continue;

        if (body[field] === null || body[field] === '') {
            // reported_date is NOT NULL, so only allow clearing the others.
            if (field === 'reported_date') continue;
            data[key] = null;
            continue;
        }

        const parsed = normaliseDate(body[field]);
        if (!parsed) {
            pushError(errors, field, `${field} must be a valid date (YYYY-MM-DD).`);
        } else {
            data[key] = parsed;
        }
    }

    if (isCreate && !data.reportedDate) {
        data.reportedDate = today();
    }

    // A completion date without a completion status is almost always a mistake.
    if (data.completionDate && data.status && !CLOSED_STATUSES.includes(data.status)) {
        pushError(
            errors,
            'completion_date',
            'A completion date may only be set when the record is Completed or Cancelled.'
        );
    }

    /* ------------------------------- Cost --------------------------------- */

    if (body.cost !== undefined) {
        const cost = parseMoney(body.cost);
        if (cost === null) {
            pushError(errors, 'cost', 'cost must be a non-negative amount.');
        } else {
            data.cost = cost;
        }
    }

    /* --------------------------- Warranty claim --------------------------- */

    if (body.warranty_claim !== undefined) {
        const claim = parseBoolean(body.warranty_claim);
        if (claim === null) {
            pushError(errors, 'warranty_claim', 'warranty_claim must be true or false.');
        } else {
            data.warrantyClaim = claim;
        }
    }

    /* ----------------------------- Condition ------------------------------ */

    if (body.condition_after !== undefined) {
        if (body.condition_after === null || body.condition_after === '') {
            data.conditionAfter = null;
        } else {
            const condition = normalizeString(body.condition_after);
            if (!ASSET_CONDITIONS.includes(condition)) {
                pushError(
                    errors,
                    'condition_after',
                    `condition_after must be one of: ${ASSET_CONDITIONS.join(', ')}.`
                );
            } else {
                data.conditionAfter = condition;
            }
        }
    }

    /* ------------------------------ Text fields ---------------------------- */

    const textFields = [
        ['fault_description', 'faultDescription'],
        ['technician_name', 'technicianName'],
        ['vendor', 'vendor'],
        ['work_performed', 'workPerformed'],
        ['parts_used', 'partsUsed'],
        ['resolution', 'resolution'],
        ['remarks', 'remarks']
    ];

    for (const [field, key] of textFields) {
        if (body[field] === undefined) continue;
        const text = normalizeString(body[field]);
        data[key] = text || null;
    }

    // A repair with no described fault is unactionable.
    if (isCreate) {
        const type = data.maintenanceType || 'Repair';
        if (type === 'Repair' && !data.faultDescription) {
            pushError(errors, 'fault_description', 'Describe the fault being reported.');
        }
    }

    /* ------------------------------- People -------------------------------- */

    if (body.reported_by !== undefined) {
        if (body.reported_by === null || body.reported_by === '') {
            data.reportedBy = null;
        } else {
            const reportedBy = parseId(body.reported_by);
            if (reportedBy === null) {
                pushError(errors, 'reported_by', 'reported_by must be a valid user id.');
            } else {
                data.reportedBy = reportedBy;
            }
        }
    }

    /* --------------------------- Field length caps ------------------------- */

    const caps = [
        ['technicianName', 100, 'technician_name'],
        ['vendor', 150, 'vendor'],
        ['resolution', 255, 'resolution']
    ];

    for (const [key, max, field] of caps) {
        if (data[key] && data[key].length > max) {
            pushError(errors, field, `${field} must be ${max} characters or fewer.`);
        }
    }

    return { errors, data };
}

/**
 * Maps the controller's camelCase payload keys onto the database column names
 * the model expects.
 *
 * @param {object} data Output of validateMaintenancePayload.
 * @param {boolean} forInsert When true, every insertable column is provided so
 *        the INSERT has a fixed arity.
 * @returns {object}
 */
function toColumns(data, forInsert = false) {
    const out = {};

    const set = (column, value) => {
        if (value !== undefined) out[column] = value;
    };

    set('asset_id', data.assetId);
    set('maintenance_type', data.maintenanceType);
    set('priority', data.priority);
    set('reported_by', data.reportedBy);
    set('reported_date', data.reportedDate);
    set('fault_description', data.faultDescription);
    set('technician_name', data.technicianName);
    set('vendor', data.vendor);
    set('work_performed', data.workPerformed);
    set('parts_used', data.partsUsed);
    set('resolution', data.resolution);
    set('scheduled_date', data.scheduledDate);
    set('start_date', data.startDate);
    set('completion_date', data.completionDate);
    set('warranty_claim', data.warrantyClaim);
    set('cost', data.cost);
    set('condition_after', data.conditionAfter);
    set('status', data.status);
    set('remarks', data.remarks);

    if (forInsert) {
        if (out.maintenance_type === undefined) out.maintenance_type = 'Repair';
        if (out.priority === undefined) out.priority = 'Medium';
        if (out.status === undefined) out.status = 'Pending';
        if (out.cost === undefined) out.cost = 0;
        if (out.warranty_claim === undefined) out.warranty_claim = 0;
    }

    return out;
}

/* ========================================================================== */
/* Reads                                                                      */
/* ========================================================================== */

/**
 * GET /api/maintenance
 * Lists maintenance records with search, filtering and pagination.
 *
 * A Departmental User is scoped server-side to records they raised - the same
 * least-privilege posture used by the transfer and assignment modules.
 */
async function getAllMaintenance(req, res) {
    const isPrivileged = READER_ROLES.includes(req.user.role);

    const options = {
        search: normalizeString(req.query.search) || undefined,
        status: normalizeString(req.query.status) || undefined,
        maintenanceType: normalizeString(req.query.maintenance_type) || undefined,
        priority: normalizeString(req.query.priority) || undefined,
        assetId: parseId(req.query.asset_id) || undefined,
        dateFrom: normaliseDate(req.query.date_from) || undefined,
        dateTo: normaliseDate(req.query.date_to) || undefined,
        limit: req.query.limit,
        offset: req.query.offset,
        sort: normalizeString(req.query.sort) || undefined,
        order: normalizeString(req.query.order) || undefined
    };

    const claim = parseBoolean(req.query.warranty_claim);
    if (claim !== null) options.warrantyClaim = claim;

    if (!isPrivileged) {
        options.reportedBy = req.user.id;
    } else if (req.query.reported_by !== undefined) {
        options.reportedBy = parseId(req.query.reported_by) || undefined;
    }

    const { rows, total } = await maintenanceModel.findAll(options);

    return res.json(
        successResponse('Maintenance records retrieved successfully.', {
            maintenance: rows,
            total,
            returned: rows.length,
            limit: Number(options.limit) || 50,
            offset: Number(options.offset) || 0
        })
    );
}

/**
 * GET /api/maintenance/stats
 * Aggregate maintenance figures for the dashboard (Â§12).
 */
async function getMaintenanceStats(req, res) {
    const stats = await maintenanceModel.getStats();
    return res.json(successResponse('Maintenance statistics retrieved successfully.', stats));
}

/**
 * GET /api/maintenance/meta
 * Reference data for the maintenance forms: ENUM choices, the next reference
 * and the pick-lists the UI needs.
 */
async function getMaintenanceMeta(req, res) {
    const nextRef = await generateMaintenanceRef();

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
        const assets = await assetModel.findAll({ limit: 500 });
        assetList = Array.isArray(assets) ? assets : assets.assets || [];
    } catch (err) {
        assetList = [];
    }

    return res.json(
        successResponse('Maintenance reference data retrieved successfully.', {
            maintenance_types: [...MAINTENANCE_TYPES],
            priorities: [...PRIORITIES],
            statuses: [...MAINTENANCE_STATUSES],
            open_statuses: [...OPEN_STATUSES],
            conditions: [...ASSET_CONDITIONS],
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
                department: asset.department
            }))
        })
    );
}

/**
 * GET /api/maintenance/recent
 * The latest reported faults, for the dashboard panel.
 */
async function getRecentMaintenance(req, res) {
    const limit = parseId(req.query.limit) || 10;
    const reportedBy = READER_ROLES.includes(req.user.role) ? null : req.user.id;
    const rows = await maintenanceModel.findRecent(limit, reportedBy);
    return res.json(
        successResponse('Recent maintenance records retrieved successfully.', {
            maintenance: rows,
            returned: rows.length
        })
    );
}

/**
 * GET /api/maintenance/open
 * Every record still in progress - the "assets currently under repair" view.
 */
async function getOpenMaintenance(req, res) {
    const { rows, total } = await maintenanceModel.findAll({
        status: 'Open',
        reportedBy: READER_ROLES.includes(req.user.role) ? undefined : req.user.id,
        limit: req.query.limit || 100,
        offset: req.query.offset || 0,
        sort: 'reported_date',
        order: 'DESC'
    });

    return res.json(
        successResponse('Open maintenance records retrieved successfully.', {
            maintenance: rows,
            total,
            returned: rows.length
        })
    );
}

/**
 * GET /api/maintenance/overdue
 * Open records whose scheduled date has passed (Â§12 "overdue maintenance").
 */
async function getOverdueMaintenance(req, res) {
    const reportedBy = READER_ROLES.includes(req.user.role) ? null : req.user.id;
    const rows = await maintenanceModel.findOverdue(reportedBy);
    return res.json(
        successResponse('Overdue maintenance records retrieved successfully.', {
            maintenance: rows,
            returned: rows.length
        })
    );
}

/**
 * GET /api/maintenance/asset/:assetId/history
 * The complete repair history of one asset (Â§5.5).
 */
async function getAssetMaintenanceHistory(req, res) {
    const asset = await resolveAsset(req.params.assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const reportedBy = READER_ROLES.includes(req.user.role) ? null : req.user.id;
    const rows = await maintenanceModel.findByAssetId(asset.id, reportedBy);
    if (reportedBy !== null && rows.length === 0) {
        return res.status(404).json(errorResponse('Maintenance history not found.'));
    }
    const openRows = rows.filter((row) => OPEN_STATUSES.includes(row.status));

    return res.json(
        successResponse('Asset maintenance history retrieved successfully.', {
            asset: {
                id: asset.id,
                asset_id: asset.asset_id,
                asset_tag: asset.asset_tag,
                status: asset.status,
                condition_status: asset.condition_status
            },
            maintenance: rows,
            history: rows,
            total: rows.length,
            open: openRows.length,
            under_repair: openRows.length > 0
        })
    );
}

/**
 * GET /api/maintenance/asset/:assetId/open
 * The open jobs for one asset.
 */
async function getAssetOpenMaintenance(req, res) {
    const asset = await resolveAsset(req.params.assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const reportedBy = READER_ROLES.includes(req.user.role) ? null : req.user.id;
    const rows = await maintenanceModel.findOpenByAssetId(asset.id, reportedBy);
    if (reportedBy !== null && rows.length === 0) {
        return res.status(404).json(errorResponse('Open maintenance records not found.'));
    }
    return res.json(
        successResponse('Open maintenance records for the asset retrieved successfully.', {
            maintenance: rows,
            returned: rows.length,
            under_repair: rows.length > 0
        })
    );
}

/**
 * GET /api/maintenance/user/:userId
 * Records raised by one user. A Departmental User may only read their own.
 */
async function getMaintenanceByUser(req, res) {
    const userId = parseId(req.params.userId);
    if (userId === null) {
        return res.status(400).json(errorResponse('A valid user id is required.'));
    }

    const isPrivileged = READER_ROLES.includes(req.user.role);
    if (!isPrivileged && userId !== Number(req.user.id)) {
        return res
            .status(403)
            .json(errorResponse('Access denied. You may only view your own reported faults.'));
    }

    const user = await userModel.findById(userId);
    if (!user) {
        return res.status(404).json(errorResponse('User not found.'));
    }

    const rows = await maintenanceModel.findByReporterId(userId);
    return res.json(
        successResponse('Maintenance records for the user retrieved successfully.', {
            maintenance: rows,
            history: rows,
            total: rows.length
        })
    );
}

/**
 * GET /api/maintenance/:id
 * Fetches one record by numeric id or MNT- reference.
 */
async function getMaintenanceById(req, res) {
    const record = await resolveRecord(req.params.id);
    if (!record) {
        return res.status(404).json(errorResponse('Maintenance record not found.'));
    }
    if (!READER_ROLES.includes(req.user.role) && Number(record.reported_by) !== Number(req.user.id)) {
        return res.status(404).json(errorResponse('Maintenance record not found.'));
    }

    return res.json(
        successResponse('Maintenance record retrieved successfully.', { maintenance: record })
    );
}

/* ========================================================================== */
/* Writes                                                                     */
/* ========================================================================== */

/**
 * POST /api/maintenance
 * Reports a fault or books a service / inspection (Â§5.5).
 *
 * Recording an open job also moves the asset to 'Under Repair' so the register
 * reflects reality immediately.
 */
async function createMaintenance(req, res) {
    const { errors, data } = validateMaintenancePayload(req.body, { isCreate: true });

    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const asset = await assetModel.findById(data.assetId);
    if (!asset) {
        return res
            .status(404)
            .json(errorResponse('Asset not found.', [{ field: 'asset_id', message: 'No such asset.' }]));
    }

    if (['Disposed', 'Retired'].includes(asset.status)) {
        return res.status(400).json(
            errorResponse(`A ${asset.status.toLowerCase()} asset cannot be sent for repair.`, [
                { field: 'asset_id', message: `The asset is ${asset.status}.` }
            ])
        );
    }

    // A user who does not exist would break the FK - check before inserting.
    if (data.reportedBy) {
        const reporter = await resolveUser(data.reportedBy);
        if (!reporter) {
            return res.status(400).json(
                errorResponse('Please correct the highlighted fields.', [
                    { field: 'reported_by', message: 'No such user.' }
                ])
            );
        }
    }

    const ref = await generateMaintenanceRef();

    const columns = toColumns(
        {
            ...data,
            // Default the reporter to the officer raising the record.
            reportedBy: data.reportedBy || req.user.id,
            status: data.status || 'Pending'
        },
        true
    );
    columns.maintenance_ref = ref;
    columns.performed_by = req.user.id;

    const id = await maintenanceModel.create(columns);

    // Keep the asset register in step (Â§5.5).
    if (OPEN_STATUSES.includes(columns.status)) {
        await syncAssetState(asset, { forceStatus: 'Under Repair' });
    }

    const record = await maintenanceModel.findById(id);

    await recordAudit(req, {
        action: 'CREATE',
        recordId: id,
        newValues: record
    });

    return res
        .status(201)
        .json(successResponse('Maintenance record created successfully.', { maintenance: record }));
}

/**
 * PUT / PATCH /api/maintenance/:id
 * Corrects the descriptive details of a record. Workflow transitions should go
 * through the dedicated /status, /start and /complete endpoints so the asset
 * register side-effects always run.
 */
async function updateMaintenance(req, res) {
    const existing = await resolveRecord(req.params.id);
    if (!existing) {
        return res.status(404).json(errorResponse('Maintenance record not found.'));
    }

    if (existing.status === 'Completed' && req.user.role !== ROLES.ADMIN && req.user.role !== ROLES.HISO) {
        return res
            .status(409)
            .json(errorResponse('A completed maintenance record can only be corrected by an Administrator or HISO.'));
    }

    const { errors, data } = validateMaintenancePayload(req.body, { isCreate: false });

    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    // Guard the status transition: going open -> closed here must still stamp a
    // completion date, and closed -> open is not a supported correction.
    if (data.status && CLOSED_STATUSES.includes(existing.status) && !CLOSED_STATUSES.includes(data.status)) {
        return res
            .status(409)
            .json(
                errorResponse(
                    'A closed maintenance record cannot be reopened. Raise a new record instead.'
                )
            );
    }

    const columns = toColumns(data, false);

    if (columns.status && CLOSED_STATUSES.includes(columns.status) && !columns.completion_date && !existing.completion_date) {
        columns.completion_date = today();
    }

    if (!Object.keys(columns).length) {
        return res
            .status(400)
            .json(errorResponse('No updatable fields were supplied.'));
    }

    await maintenanceModel.update(existing.id, columns);

    const updated = await maintenanceModel.findById(existing.id);

    // Reflect any status / condition change on the asset.
    const asset = await assetModel.findById(existing.asset_id);
    if (asset && (columns.status || columns.condition_after !== undefined)) {
        await syncAssetState(asset, {
            condition: columns.condition_after || null,
            forceStatus: columns.status && !CLOSED_STATUSES.includes(columns.status) ? 'Under Repair' : null
        });
    }

    await recordAudit(req, {
        action: 'UPDATE',
        recordId: existing.id,
        oldValues: existing,
        newValues: updated
    });

    return res.json(
        successResponse('Maintenance record updated successfully.', { maintenance: updated })
    );
}

/**
 * Internal helper shared by the workflow transition handlers.
 *
 * Applies a status change, stamps the dates that go with it, keeps the asset
 * register in step and writes the audit entry.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} nextStatus
 * @param {object} [options]
 * @param {string} [options.action] Audit action name.
 * @param {string} [options.successMessage]
 * @returns {Promise<import('express').Response>}
 */
async function transition(req, res, nextStatus, { action, successMessage } = {}) {
    const existing = await resolveRecord(req.params.id);
    if (!existing) {
        return res.status(404).json(errorResponse('Maintenance record not found.'));
    }

    if (CLOSED_STATUSES.includes(existing.status)) {
        return res
            .status(409)
            .json(
                errorResponse(
                    `This record is already ${existing.status.toLowerCase()} and cannot be changed.`
                )
            );
    }

    // Validate the optional detail fields the caller may supply alongside the
    // transition (technician, work done, cost, condition, dates...).
    const { errors, data } = validateMaintenancePayload(req.body || {}, { isCreate: false });
    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const columns = toColumns(data, false);
    columns.status = nextStatus;

    if (nextStatus === 'In Progress') {
        if (!columns.start_date && !existing.start_date) columns.start_date = today();
    }

    if (CLOSED_STATUSES.includes(nextStatus)) {
        if (!columns.completion_date && !existing.completion_date) columns.completion_date = today();
    }

    await maintenanceModel.update(existing.id, columns);

    const updated = await maintenanceModel.findById(existing.id);

    const asset = await assetModel.findById(existing.asset_id);
    if (asset) {
        if (CLOSED_STATUSES.includes(nextStatus)) {
            // Derive from whatever open records remain (there may be others).
            await syncAssetState(asset, { condition: columns.condition_after || null });
        } else {
            await syncAssetState(asset, {
                condition: columns.condition_after || null,
                forceStatus: 'Under Repair'
            });
        }
    }

    await recordAudit(req, {
        action: action || 'STATUS_CHANGE',
        recordId: existing.id,
        oldValues: { status: existing.status },
        newValues: updated
    });

    const refreshedAsset = asset ? await assetModel.findById(existing.asset_id) : null;

    return res.json(
        successResponse(successMessage || 'Maintenance record updated successfully.', {
            maintenance: updated,
            asset: refreshedAsset
                ? {
                      id: refreshedAsset.id,
                      asset_tag: refreshedAsset.asset_tag,
                      status: refreshedAsset.status,
                      condition_status: refreshedAsset.condition_status
                  }
                : null
        })
    );
}

/**
 * PATCH /api/maintenance/:id/status
 * Moves a record to any valid workflow status (e.g. On Hold).
 */
async function setMaintenanceStatus(req, res) {
    const raw = normalizeString(req.body && req.body.status);
    if (!MAINTENANCE_STATUSES.includes(raw)) {
        return res.status(400).json(
            errorResponse('Please correct the highlighted fields.', [
                {
                    field: 'status',
                    message: `status must be one of: ${MAINTENANCE_STATUSES.join(', ')}.`
                }
            ])
        );
    }

    return transition(req, res, raw, { action: 'STATUS_CHANGE' });
}

/**
 * PATCH /api/maintenance/:id/start
 * Marks the work as begun, recording who is doing it.
 */
async function startMaintenance(req, res) {
    return transition(req, res, 'In Progress', {
        action: 'START_MAINTENANCE',
        successMessage: 'Maintenance work marked as in progress.'
    });
}

/**
 * PATCH /api/maintenance/:id/complete
 * Finishes the job, recording the resolution, cost and resulting condition.
 * When the last open job on the asset closes, the asset returns to service.
 */
async function completeMaintenance(req, res) {
    return transition(req, res, 'Completed', {
        action: 'COMPLETE_MAINTENANCE',
        successMessage: 'Maintenance record completed successfully.'
    });
}

/**
 * PATCH /api/maintenance/:id/cancel
 * Withdraws a record raised in error. The row is kept so the history stays
 * complete, but it no longer counts as an open repair.
 */
async function cancelMaintenance(req, res) {
    const existing = await resolveRecord(req.params.id);
    if (!existing) {
        return res.status(404).json(errorResponse('Maintenance record not found.'));
    }

    if (existing.status === 'Cancelled') {
        return res.status(409).json(errorResponse('This record has already been cancelled.'));
    }

    const reason = normalizeString(req.body && req.body.reason);
    const columns = { status: 'Cancelled' };

    if (reason) columns.remarks = reason;

    await maintenanceModel.update(existing.id, columns);

    const updated = await maintenanceModel.findById(existing.id);

    const asset = await assetModel.findById(existing.asset_id);
    if (asset) {
        await syncAssetState(asset);
    }

    await recordAudit(req, {
        action: 'CANCEL',
        recordId: existing.id,
        oldValues: { status: existing.status },
        newValues: { status: 'Cancelled', reason: reason || null }
    });

    return res.json(
        successResponse('Maintenance record cancelled successfully.', { maintenance: updated })
    );
}

/* ========================================================================== */
/* Exports                                                                    */
/* ========================================================================== */

module.exports = {
    // Reads
    getAllMaintenance,
    getMaintenanceStats,
    getMaintenanceMeta,
    getRecentMaintenance,
    getOpenMaintenance,
    getOverdueMaintenance,
    getAssetMaintenanceHistory,
    getAssetOpenMaintenance,
    getMaintenanceByUser,
    getMaintenanceById,

    // Writes
    createMaintenance,
    updateMaintenance,
    setMaintenanceStatus,
    startMaintenance,
    completeMaintenance,
    cancelMaintenance,

    // Exposed for the test suite and future modules
    MAINTENANCE_TYPES,
    PRIORITIES,
    MAINTENANCE_STATUSES,
    OPEN_STATUSES,
    CLOSED_STATUSES,
    ASSET_CONDITIONS
};
