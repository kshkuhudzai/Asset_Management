'use strict';

// controllers/transferController.js
// Asset transfer and movement (§5.4 of the requirements): moving an asset
// between users, departments and locations while keeping a permanent history.
//
// Endpoints
//   GET    /api/transfers                          - list / search / filter + page
//   GET    /api/transfers/stats                    - aggregate movement counts
//   GET    /api/transfers/meta                     - ENUM choices + pick-lists
//   GET    /api/transfers/recent                   - latest movements
//   GET    /api/transfers/unacknowledged           - completed but unsigned
//   GET    /api/transfers/user/:userId             - a custodian's movements
//   GET    /api/transfers/asset/:assetId/history   - permanent movement history
//   GET    /api/transfers/asset/:assetId/latest    - the asset's last movement
//   GET    /api/transfers/:id                      - fetch one transfer
//   POST   /api/transfers                          - record a transfer
//   PUT    /api/transfers/:id                      - correct the details of one
//   PATCH  /api/transfers/:id/acknowledge          - receiving party confirms
//   PATCH  /api/transfers/:id/approve             - independently approve pending
//   PATCH  /api/transfers/:id/cancel               - withdraw a mistaken record
//   PATCH  /api/transfers/:id/reverse              - reverse a movement in place
//
// Conventions (mirrors assetAssignmentController):
//   * Handlers are async; Express 5 forwards rejected promises to the global
//     error handler, so no try/catch wrapper is needed for unexpected errors.
//   * Responses always use the shared { status, message, data } envelope.
//   * Transfer rows are never deleted - the movement trail is permanent.
//   * Every mutating handler writes an audit_logs row explicitly.
//
// Roles
//   * Reads        - every authenticated role; Departmental Users are scoped to
//                    movements they were part of.
//   * Record / correct / acknowledge - Administrator, HISO, ICT Officer.
//   * Cancel / reverse the record - Administrator and HISO only, because these
//     alter the movement trail rather than recording a new movement.

const transferModel = require('../models/transferModel');
const assignmentModel = require('../models/assetAssignmentModel');
const assetModel = require('../models/assetModel');
const userModel = require('../models/userModel');
const { auditLog } = require('../middleware/auditMiddleware');
const { ROLES } = require('../middleware/rbacMiddleware');
const {
    formatDateTime,
    getClientIp,
    normalizeString,
    successResponse,
    errorResponse
} = require('../utils/helpers');

// Table name as it appears in audit_logs.table_name.
const TRANSFER_TABLE = 'transfers';

// ENUM values from the transfers schema. Kept here so validation and the
// /meta endpoint share a single source of truth.
const TRANSFER_STATUSES = Object.freeze(['Completed', 'Pending', 'Cancelled', 'Reversed']);

const TRANSFER_TYPES = Object.freeze(['User', 'Department', 'Location', 'Stock', 'Other']);

// Statuses that mean the movement is no longer in force. A cancelled or
// reversed transfer can still be read (history is permanent) but may not be
// acknowledged or reversed again.
const CLOSED_TRANSFER_STATUSES = Object.freeze(['Cancelled', 'Reversed']);

// Asset condition ENUM from the `assets` table - a transfer records the
// condition the asset was in on both sides of the movement.
const ASSET_CONDITIONS = Object.freeze(['Good', 'Fair', 'Damaged', 'Obsolete']);

// Reference prefix for the human-quotable transfer reference (TRF-000001).
const TRANSFER_REF_PREFIX = 'TRF-';


// Maximum lengths taken from the column definitions above, so validation and
// the schema cannot drift apart.
const MAX_LENGTHS = Object.freeze({
    transferRef: 50,
    custodianName: 100,
    department: 100,
    location: 100,
    reason: 255,
    responsibleOfficer: 100,
    receivingPartyName: 100
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
 * Normalises a nullable date field: '' / null / undefined -> null.
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
 * Reduces a MySQL DATE / DATETIME value (or a YYYY-MM-DD string) to a plain
 * `YYYY-MM-DD` day string.
 *
 * mysql2 returns DATE columns as Date objects anchored at LOCAL midnight, so a
 * naive `String(value).slice(0,10)` comparison could shift the day by one when
 * the process timezone is behind UTC. Reading the local calendar fields keeps
 * the comparison consistent with what was stored.
 *
 * @param {*} value A Date, ISO string, YYYY-MM-DD string or null.
 * @returns {string|null}
 */
function toDayString(value) {
    if (value === undefined || value === null || value === '') return null;

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
 * Today's date as YYYY-MM-DD (used for the default transfer date).
 *
 * @returns {string}
 */
function today() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

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
 * Mints the next transfer reference (TRF-000001) by reading the highest
 * existing suffix. A tiny race is possible between two simultaneous creates;
 * the UNIQUE index on `transfer_ref` turns that into a clean duplicate-key
 * error rather than a silently duplicated reference.
 *
 * @returns {Promise<string>}
 */
async function generateTransferRef() {
    try {
        const max = await transferModel.findMaxRefSuffix(TRANSFER_REF_PREFIX);
        return `${TRANSFER_REF_PREFIX}${String(max + 1).padStart(6, '0')}`;
    } catch (err) {
        // Never let reference generation block a legitimate transfer.
        return `${TRANSFER_REF_PREFIX}${Date.now()}`;
    }
}


/**
 * Validates and normalises a transfer payload.
 *
 * `isCreate` toggles the rules: on create the asset, transfer date and a
 * destination are mandatory; on update every field is optional and only the
 * supplied keys are returned.
 *
 * A "destination" is deliberately flexible because §5.4 requires movements
 * between users, departments AND locations: the caller must supply at least one
 * of `to_user_id` / `to_custodian_name` / `to_department` / `to_location`, and
 * `transfer_type` says which kind of move this is.
 *
 * @param {object} body Raw req.body.
 * @param {object} [options]
 * @param {boolean} [options.isCreate=false]
 * @returns {{errors: object[], data: object}}
 */
function validateTransferPayload(body, { isCreate = false } = {}) {
    const errors = [];
    const data = {};

    /* --------------------------- Destination user ------------------------- */

    if (body.to_user_id !== undefined) {
        if (body.to_user_id === null || body.to_user_id === '') {
            data.toUserId = null;
        } else {
            const userId = parseId(body.to_user_id);
            if (userId === null) {
                pushError(errors, 'to_user_id', 'to_user_id must be a positive integer.');
            } else {
                data.toUserId = userId;
            }
        }
    }

    if (body.from_user_id !== undefined) {
        if (body.from_user_id === null || body.from_user_id === '') {
            data.fromUserId = null;
        } else {
            const userId = parseId(body.from_user_id);
            if (userId === null) {
                pushError(errors, 'from_user_id', 'from_user_id must be a positive integer.');
            } else {
                data.fromUserId = userId;
            }
        }
    }

    /* ------------------------------ Free text ----------------------------- */

    const textFields = [
        ['to_custodian_name', 'toCustodianName', MAX_LENGTHS.custodianName],
        ['from_custodian_name', 'fromCustodianName', MAX_LENGTHS.custodianName],
        ['to_department', 'toDepartment', MAX_LENGTHS.department],
        ['from_department', 'fromDepartment', MAX_LENGTHS.department],
        ['to_location', 'toLocation', MAX_LENGTHS.location],
        ['from_location', 'fromLocation', MAX_LENGTHS.location],
        ['reason', 'reason', MAX_LENGTHS.reason],
        ['responsible_officer', 'responsibleOfficer', MAX_LENGTHS.responsibleOfficer],
        ['receiving_party_name', 'receivingPartyName', MAX_LENGTHS.receivingPartyName]
    ];

    for (const [field, key, max] of textFields) {
        if (body[field] === undefined) continue;

        const value = normalizeOptionalString(body[field]);
        if (value && value.length > max) {
            pushError(errors, field, `${field} must be ${max} characters or fewer.`);
        } else {
            data[key] = value;
        }
    }

    if (body.remarks !== undefined) {
        // TEXT column - only a sanity cap so a runaway payload is rejected
        // instead of being stored.
        const remarks = normalizeOptionalString(body.remarks);
        if (remarks && remarks.length > 2000) {
            pushError(errors, 'remarks', 'remarks must be 2000 characters or fewer.');
        } else {
            data.remarks = remarks;
        }
    }

    /* ------------------------------- Enums -------------------------------- */

    const enumFields = [
        ['transfer_type', 'transferType', TRANSFER_TYPES],
        ['status', 'status', TRANSFER_STATUSES],
        ['from_condition', 'fromCondition', ASSET_CONDITIONS],
        ['to_condition', 'toCondition', ASSET_CONDITIONS]
    ];

    for (const [field, key, allowed] of enumFields) {
        if (body[field] === undefined) continue;

        const value = normalizeOptionalString(body[field]);
        if (value === null) {
            data[key] = null;
        } else if (!allowed.includes(value)) {
            pushError(errors, field, `${field} must be one of: ${allowed.join(', ')}.`);
        } else {
            data[key] = value;
        }
    }

    /* ------------------------------- Dates -------------------------------- */

    if (body.transfer_date !== undefined) {
        const value = normalizeDate(body.transfer_date);
        if (value === null) {
            pushError(errors, 'transfer_date', 'transfer_date cannot be empty.');
        } else if (!isValidDate(value)) {
            pushError(
                errors,
                'transfer_date',
                'transfer_date must be a valid date in YYYY-MM-DD format.'
            );
        } else {
            data.transferDate = value;
        }
    }

    /* ---------------------------- Cross-field ----------------------------- */

    if (isCreate) {
        const hasDestination =
            data.toUserId ||
            data.toCustodianName ||
            data.toDepartment ||
            data.toLocation;

        if (!hasDestination) {
            pushError(
                errors,
                'to_user_id',
                'A destination is required: supply to_user_id, to_custodian_name, to_department or to_location.'
            );
        }
    }

    return { errors, data };
}


/* ========================================================================== */
/* GET /api/transfers                                                         */
/* ========================================================================== */

/**
 * Lists transfers with search, filtering and pagination.
 *
 * Query: ?search= &asset_id= &from_user_id= &to_user_id= &transfer_type=
 *        &status= &department= &location= &date_from= &date_to=
 *        &sort_by= &sort_dir= &limit= &offset=
 *
 * A Departmental User only ever sees movements they were part of; oversight
 * roles see everything.
 */
async function getAllTransfers(req, res) {
    const query = req.query || {};
    const scopedUserId =
        req.user && req.user.role === ROLES.DEPARTMENTAL_USER ? Number(req.user.id) : null;

    // A Departmental User's scope cannot be widened by supplying filters, so
    // their own id overrides whatever was asked for.
    const fromUserId = parseId(query.from_user_id) || undefined;
    const toUserId = parseId(query.to_user_id) || undefined;

    const { transfers, total } = await transferModel.findAll({
        search: normalizeString(query.search) || undefined,
        assetId: parseId(query.asset_id) || undefined,
        userId: scopedUserId || undefined,
        fromUserId,
        toUserId,
        transferType: normalizeString(query.transfer_type) || undefined,
        status: normalizeString(query.status) || undefined,
        department: normalizeString(query.department) || undefined,
        location: normalizeString(query.location) || undefined,
        dateFrom: normalizeString(query.date_from) || undefined,
        dateTo: normalizeString(query.date_to) || undefined,
        sortBy: normalizeString(query.sort_by) || 'transfer_date',
        sortDir: normalizeString(query.sort_dir) || 'desc',
        limit: Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 500),
        offset: Math.max(parseInt(query.offset, 10) || 0, 0)
    });

    return res.status(200).json(
        successResponse('Transfers retrieved successfully.', {
            transfers,
            total,
            returned: transfers.length
        })
    );
}

/* ========================================================================== */
/* GET /api/transfers/stats                                                   */
/* ========================================================================== */

/**
 * Aggregate movement counts for the summary tiles: how many transfers exist,
 * how they break down by status, type and month, and which departments received
 * the most assets.
 */
async function getTransferStats(req, res) {
    const scopedUserId =
        req.user && req.user.role === ROLES.DEPARTMENTAL_USER ? Number(req.user.id) : null;

    const stats = await transferModel.getStats({ userId: scopedUserId });

    return res
        .status(200)
        .json(successResponse('Transfer statistics retrieved successfully.', stats));
}


/* ========================================================================== */
/* GET /api/transfers/meta                                                    */
/* ========================================================================== */

/**
 * Reference data for building the transfer UI: the status / type / condition
 * ENUMs, plus the custodian pick-list.
 *
 * Query: ?active_users=false includes deactivated accounts too.
 */
async function getTransferMeta(req, res) {
    const query = req.query || {};
    const activeOnly = !['false', '0', 'no'].includes(
        String(query.active_users === undefined ? 'true' : query.active_users).toLowerCase()
    );

    const { users } = await userModel.findAll({
        isActive: activeOnly ? true : undefined,
        limit: 500
    });

    return res.status(200).json(
        successResponse('Transfer reference data retrieved successfully.', {
            statuses: [...TRANSFER_STATUSES],
            transfer_types: [...TRANSFER_TYPES],
            conditions: [...ASSET_CONDITIONS],
            users: users.map((user) => ({
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role,
                is_active: !!user.is_active
            })),
            next_transfer_ref: await generateTransferRef()
        })
    );
}

/* ========================================================================== */
/* GET /api/transfers/recent | /unacknowledged                                */
/* ========================================================================== */

/**
 * The most recent movements, newest first - drives the dashboard's "Recent
 * Transfers" panel.
 */
async function getRecentTransfers(req, res) {
    const query = req.query || {};
    const scopedUserId =
        req.user && req.user.role === ROLES.DEPARTMENTAL_USER ? Number(req.user.id) : null;

    const { transfers, total } = await transferModel.findAll({
        userId: scopedUserId || undefined,
        limit: Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100),
        offset: 0,
        sortBy: 'transfer_date',
        sortDir: 'desc'
    });

    return res.status(200).json(
        successResponse('Recent transfers retrieved successfully.', {
            transfers,
            total,
            returned: transfers.length
        })
    );
}

/**
 * Completed transfers whose receiving party has not yet signed for the asset.
 * Drives the "awaiting receipt confirmation" follow-up list.
 */
async function getUnacknowledgedTransfers(req, res) {
    const query = req.query || {};
    const scopedUserId =
        req.user && req.user.role === ROLES.DEPARTMENTAL_USER ? Number(req.user.id) : null;

    const { transfers, total } = await transferModel.findAll({
        toUserId: scopedUserId || undefined,
        status: 'Completed',
        limit: Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 500),
        offset: Math.max(parseInt(query.offset, 10) || 0, 0)
    });

    const pending = transfers.filter((row) => !row.receiving_party_acknowledged_at);

    return res.status(200).json(
        successResponse('Transfers awaiting receipt confirmation retrieved successfully.', {
            transfers: pending,
            total,
            pending: pending.length
        })
    );
}


/* ========================================================================== */
/* GET /api/transfers/user/:userId  (+ ?direction=in|out|both)                */
/* ========================================================================== */

/**
 * A custodian's movement records. A Departmental User may only request their
 * own; oversight roles may request any custodian's.
 */
async function getTransfersByUser(req, res) {
    const userId = parseId(req.params.userId);
    if (userId === null) {
        return res.status(400).json(errorResponse('A valid numeric user id is required.'));
    }

    if (
        req.user &&
        req.user.role === ROLES.DEPARTMENTAL_USER &&
        userId !== Number(req.user.id)
    ) {
        return res
            .status(403)
            .json(errorResponse('Access denied. You may only view your own transfers.'));
    }

    const user = await userModel.findById(userId);
    if (!user) {
        return res.status(404).json(errorResponse('User not found.'));
    }

    const rawDirection = normalizeString((req.query || {}).direction).toLowerCase();
    const direction = ['in', 'out', 'both'].includes(rawDirection) ? rawDirection : 'both';

    const transfers = await transferModel.findByUserId(userId, { direction });

    return res.status(200).json(
        successResponse('Custodian transfers retrieved successfully.', {
            user: {
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role,
                department: user.department || null
            },
            direction,
            transfers,
            total: transfers.length
        })
    );
}

/* ========================================================================== */
/* GET /api/transfers/asset/:assetId/history | /latest                        */
/* ========================================================================== */

/**
 * The permanent movement history of one asset, newest first. Every transfer is
 * retained, which is what makes "transfers do not erase previous ownership or
 * location history" verifiable.
 */
async function getAssetTransferHistory(req, res) {
    const asset = await resolveAsset(req.params.assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const userId = req.user && req.user.role === ROLES.DEPARTMENTAL_USER
        ? Number(req.user.id)
        : null;
    const transfers = await transferModel.findHistoryByAssetId(asset.id, userId);
    if (userId !== null && !transfers.length) {
        return res.status(404).json(errorResponse('Asset transfer history not found.'));
    }

    return res.status(200).json(
        successResponse('Asset transfer history retrieved successfully.', {
            asset: {
                id: asset.id,
                asset_id: asset.asset_id,
                asset_tag: asset.asset_tag,
                serial_number: asset.serial_number,
                status: asset.status
            },
            transfers,
            total: transfers.length
        })
    );
}

/**
 * The asset's most recent movement (or null when it has never moved).
 */
async function getLatestAssetTransfer(req, res) {
    const asset = await resolveAsset(req.params.assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const userId = req.user && req.user.role === ROLES.DEPARTMENTAL_USER
        ? Number(req.user.id)
        : null;
    const transfers = await transferModel.findHistoryByAssetId(asset.id, userId);
    if (userId !== null && !transfers.length) {
        return res.status(404).json(errorResponse('Asset transfer history not found.'));
    }
    const latest = transfers.length ? transfers[0] : null;

    return res.status(200).json(
        successResponse('Latest asset transfer retrieved successfully.', {
            asset: {
                id: asset.id,
                asset_id: asset.asset_id,
                asset_tag: asset.asset_tag
            },
            transfer: latest,
            total: transfers.length
        })
    );
}

/* ========================================================================== */
/* GET /api/transfers/:id                                                     */
/* ========================================================================== */

/**
 * Fetches a single transfer by numeric id or by its TRF- reference.
 */
async function getTransferById(req, res) {
    const raw = normalizeString(req.params.id);

    const transfer = /^\d+$/.test(raw)
        ? await transferModel.findById(raw)
        : await transferModel.findByRef(raw);

    if (!transfer) {
        return res.status(404).json(errorResponse('Transfer not found.'));
    }
    if (
        req.user &&
        req.user.role === ROLES.DEPARTMENTAL_USER &&
        Number(transfer.from_user_id) !== Number(req.user.id) &&
        Number(transfer.to_user_id) !== Number(req.user.id)
    ) {
        return res.status(404).json(errorResponse('Transfer not found.'));
    }

    return res
        .status(200)
        .json(successResponse('Transfer retrieved successfully.', { transfer }));
}


/* ========================================================================== */
/* POST /api/transfers                                                        */
/* ========================================================================== */

/**
 * True when a movement type means the asset is going into stores rather than
 * into someone's hands.
 *
 * @param {string} transferType
 * @returns {boolean}
 */
function isStockMovement(transferType) {
    return ['Stock', 'Location', 'Department'].includes(transferType);
}

/**
 * Derives the movement type when the caller did not name one, so the recorded
 * category always reflects what actually changed.
 *
 * @param {object} context
 * @returns {string} One of TRANSFER_TYPES.
 */
function deriveTransferType({
    toUserId,
    toCustodianName,
    hasCurrentCustody,
    toDepartment,
    fromDepartment,
    toLocation,
    fromLocation
}) {
    if (toUserId || (toCustodianName && hasCurrentCustody)) return 'User';
    if (toDepartment && fromDepartment && toDepartment !== fromDepartment) return 'Department';
    if (toLocation && fromLocation && toLocation !== fromLocation) return 'Location';
    if (toDepartment === null || toLocation === null) return 'Stock';
    return 'User';
}

/**
 * Records an asset transfer (§5.4).
 *
 * This is the module's central operation and it keeps three things in step:
 *   1. `transfers` - the immutable movement record (old/new custodian,
 *      department, location, condition, reason, date and officers).
 *   2. `asset_assignments` - the current custodian's open row is closed with
 *      status 'Transferred' and a new open row is created for the receiver, so
 *      assignment history is preserved rather than overwritten.
 *   3. `assets` - the register mirrors the asset's new custodian, department,
 *      location and condition.
 *
 * Body:
 *   asset_id (required), to_user_id / to_custodian_name / to_department /
 *   to_location (at least one required), transfer_date (defaults to today),
 *   transfer_type, from_* (defaulted from the asset's current custody),
 *   reason, remarks, from_condition, to_condition, responsible_officer,
 *   receiving_party_name, status.
 */
async function createTransfer(req, res) {
    const body = req.body || {};

    /* ----------------------------- The asset ------------------------------ */

    const assetKey = body.asset_id !== undefined ? body.asset_id : body.assetId;
    const asset = await resolveAsset(assetKey);

    if (!asset) {
        return res
            .status(404)
            .json(errorResponse('Asset not found. Supply a valid asset id, code or tag.'));
    }

    const { errors, data } = validateTransferPayload(body, { isCreate: true });

    /* ------------------------- Resolve the people ------------------------- */

    let toUser = null;
    if (data.toUserId) {
        toUser = await userModel.findById(data.toUserId);
        if (!toUser) {
            pushError(errors, 'to_user_id', 'The receiving user account does not exist.');
        } else if (!toUser.is_active) {
            pushError(errors, 'to_user_id', 'The receiving user account has been deactivated.');
        }
    }

    let fromUser = null;
    if (data.fromUserId) {
        fromUser = await userModel.findById(data.fromUserId);
        if (!fromUser) {
            pushError(errors, 'from_user_id', 'The releasing user account does not exist.');
        }
    }

    /* --------------------- The asset's current custody -------------------- */

    // Read the open assignment so the "from" side of the snapshot is accurate
    // even when the caller only supplies the destination.
    const currentAssignment = await assignmentModel.findActiveByAssetId(asset.id);

    if (!data.fromUserId) {
        const currentUserId =
            (currentAssignment && currentAssignment.assigned_user_id) || asset.assigned_user_id;
        if (currentUserId) {
            data.fromUserId = Number(currentUserId);
            if (!fromUser) fromUser = await userModel.findById(data.fromUserId);
        }
    }

    // Handing an asset back to the person who already holds it is a no-op - but
    // only when nothing else about the custody changes. §5.4 requires transfers
    // between departments and locations too, and those legitimately keep the
    // same custodian while moving the asset, so they must be allowed through.
    const sameCustodian =
        !!data.toUserId &&
        !!currentAssignment &&
        !!currentAssignment.assigned_user_id &&
        Number(data.toUserId) === Number(currentAssignment.assigned_user_id);

    if (sameCustodian) {
        const departmentChanges =
            data.toDepartment !== undefined &&
            data.toDepartment !== null &&
            data.toDepartment !== currentAssignment.department;

        const locationChanges =
            data.toLocation !== undefined &&
            data.toLocation !== null &&
            data.toLocation !== currentAssignment.location;

        const conditionChanges =
            !!data.toCondition && data.toCondition !== currentAssignment.asset_condition;

        if (!departmentChanges && !locationChanges && !conditionChanges) {
            pushError(
                errors,
                'to_user_id',
                'The asset is already held by this custodian in this location; there is nothing to transfer.'
            );
        }
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }


    /* --------------------------- Defaults --------------------------------- */

    const transferDate = data.transferDate || today();

    // Snapshot both sides. Anything the caller omitted for the "from" side is
    // taken from the live record so the history is never blank.
    const fromCustodianName =
        data.fromCustodianName ||
        (currentAssignment ? currentAssignment.assigned_to_name : null) ||
        (fromUser ? fromUser.full_name : null) ||
        null;

    const fromDepartment =
        data.fromDepartment !== undefined
            ? data.fromDepartment
            : (currentAssignment && currentAssignment.department) || asset.department || null;

    const fromLocation =
        data.fromLocation !== undefined
            ? data.fromLocation
            : (currentAssignment && currentAssignment.location) || asset.location || null;

    const toCustodianName = data.toCustodianName || (toUser ? toUser.full_name : null);
    const toDepartment =
        data.toDepartment !== undefined ? data.toDepartment : asset.department || null;
    const toLocation = data.toLocation !== undefined ? data.toLocation : asset.location || null;

    const transferType =
        data.transferType ||
        deriveTransferType({
            toUserId: data.toUserId,
            toCustodianName,
            hasCurrentCustody: !!currentAssignment,
            toDepartment,
            fromDepartment,
            toLocation,
            fromLocation
        });

    const transferRef = await generateTransferRef();

    /* ------------------- 1. The permanent movement record ----------------- */

    const transfer = await transferModel.create({
        transferRef,
        assetId: asset.id,
        fromUserId: data.fromUserId ?? null,
        fromCustodianName,
        fromDepartment,
        fromLocation,
        fromCondition: data.fromCondition ?? asset.condition_status ?? null,
        toUserId: data.toUserId ?? null,
        toCustodianName,
        toDepartment,
        toLocation,
        toCondition: data.toCondition ?? data.fromCondition ?? asset.condition_status ?? null,
        transferType,
        transferDate,
        reason: data.reason ?? null,
        remarks: data.remarks ?? null,
        initiatedBy: req.user ? req.user.id : null,
        responsibleOfficer:
            data.responsibleOfficer ||
            (currentAssignment ? currentAssignment.responsible_officer : null) ||
            asset.responsible_officer ||
            null,
        status: data.status || 'Completed',
        approvedBy: data.status === 'Pending' ? null : (req.user ? req.user.id : null),
        receivingPartyName: data.receivingPartyName || null
    });


    /* ------------- 2. Close the old custody row, open the new ------------- */

    let previousAssignment = null;
    let newAssignment = null;

    let updatedAsset = asset;

    if (transfer.status !== 'Pending') {
        if (currentAssignment) {
            previousAssignment = await assignmentModel.release(currentAssignment.id, {
                releasedAt: formatDateTime(new Date()),
                releasedBy: req.user ? req.user.id : null,
                releaseReason: data.reason || `Transferred (${transferRef})`,
                status: 'Transferred'
            });
        }

        const opensNewCustody = !!data.toUserId || !currentAssignment;

        if (opensNewCustody) {
            newAssignment = await assignmentModel.create({
                assetId: asset.id,
                assignedUserId: data.toUserId ?? null,
                assignedToName: toCustodianName,
                department: toDepartment,
                location: toLocation,
                responsibleOfficer:
                    data.responsibleOfficer ||
                    (currentAssignment ? currentAssignment.responsible_officer : null) ||
                    null,
                assignmentDate: transferDate,
                purpose: (currentAssignment ? currentAssignment.purpose : null) || 'Transferred',
                remarks: data.remarks ?? null,
                status: 'Active',
                assignedBy: req.user ? req.user.id : null
            });
        } else {
            newAssignment = await assignmentModel.update(currentAssignment.id, {
                department: toDepartment,
                location: toLocation,
                remarks: data.remarks ?? currentAssignment.remarks
            });
        }

        if (newAssignment) {
            await transferModel.update(transfer.id, { assignmentId: newAssignment.id });
        }

        const assetUpdates = {};
        if (data.toUserId !== undefined) assetUpdates.assignedUserId = data.toUserId;
        if (toDepartment !== null && toDepartment !== undefined) {
            assetUpdates.department = toDepartment;
        }
        if (toLocation !== null && toLocation !== undefined) assetUpdates.location = toLocation;
        if (data.toCondition) assetUpdates.conditionStatus = data.toCondition;

        if (data.toUserId) {
            assetUpdates.status = 'In Use';
        } else if (isStockMovement(transferType)) {
            assetUpdates.status = 'In Stock';
        }

        updatedAsset = Object.keys(assetUpdates).length
            ? await assetModel.update(asset.id, assetUpdates)
            : asset;
    }

    /* ------------------------------ Audit -------------------------------- */

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: transfer.status === 'Pending' ? 'TRANSFER_REQUEST' : 'TRANSFER',
        tableName: TRANSFER_TABLE,
        recordId: transfer.id,
        oldValues: {
            asset_id: asset.asset_id,
            custodian: fromCustodianName,
            department: fromDepartment,
            location: fromLocation,
            condition: data.fromCondition ?? asset.condition_status ?? null
        },
        newValues: {
            transfer_ref: transferRef,
            asset_id: asset.asset_id,
            custodian: toCustodianName,
            department: toDepartment,
            location: toLocation,
            condition: data.toCondition ?? null,
            transfer_type: transferType,
            transfer_date: transferDate,
            status: transfer.status
        },
        ipAddress: getClientIp(req)
    });

    const saved = await transferModel.findById(transfer.id);

    return res.status(201).json(
        successResponse(
            transfer.status === 'Pending'
                ? 'Transfer request submitted. Asset custody will update after approval.'
                : 'Asset transferred successfully.',
            {
                transfer: saved,
                previous_assignment: previousAssignment,
                assignment: newAssignment,
                asset: updatedAsset
            }
        )
    );
}


/* ========================================================================== */
/* PUT / PATCH /api/transfers/:id                                             */
/* ========================================================================== */

/**
 * Corrects the descriptive details of a recorded transfer - a typo in the
 * reason, a missing signature name, a corrected condition. The movement itself
 * (who had it, who got it, when) is not rewritten, because that would destroy
 * the audit trail.
 *
 * Body: descriptive fields only; workflow status is changed by dedicated actions.
 */
async function updateTransfer(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric transfer id is required.'));
    }

    const existing = await transferModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Transfer not found.'));
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) {
        return res.status(400).json(
            errorResponse('Transfer status must be changed through its workflow action.')
        );
    }

    // `isCreate: false` makes every field optional.
    const { errors, data } = validateTransferPayload(req.body || {}, { isCreate: false });

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    // Only the descriptive columns may be corrected - never the movement's
    // endpoints, dates or asset, which are historical facts.
    const allowed = {};
    const editable = [
        'reason',
        'remarks',
        'responsibleOfficer',
        'receivingPartyName',
        'fromCondition',
        'toCondition'
    ];
    for (const key of editable) {
        if (data[key] !== undefined) allowed[key] = data[key];
    }

    if (!Object.keys(allowed).length) {
        return res
            .status(400)
            .json(
                errorResponse('No editable fields were supplied.', [
                    {
                        field: 'body',
                        message: `Supply at least one of: ${editable.join(', ')}.`
                    }
                ])
            );
    }

    const updated = await transferModel.update(id, allowed);

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'UPDATE',
        tableName: TRANSFER_TABLE,
        recordId: id,
        oldValues: existing,
        newValues: updated,
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('Transfer details updated successfully.', { transfer: updated }));
}

/* ========================================================================== */
/* PATCH /api/transfers/:id/acknowledge                                       */
/* ========================================================================== */

/**
 * The receiving party confirms they have taken delivery of the asset - the
 * signature block on the printed transfer form.
 *
 * Because a transfer has no "custody owner" the way an assignment does, the
 * role check lives in the route (Administrator / HISO / ICT Officer, the staff
 * who handle handovers) and the caller is recorded as the acknowledging user.
 *
 * Body (optional): { receiving_party_name, remarks }
 */
async function acknowledgeTransfer(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric transfer id is required.'));
    }

    const existing = await transferModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Transfer not found.'));
    }

    if (existing.status !== 'Completed') {
        return res.status(409).json(errorResponse('Only completed transfers can be acknowledged.'));
    }
    if (existing.receiving_party_acknowledged_at) {
        return res
            .status(409)
            .json(errorResponse('This transfer has already been acknowledged.'));
    }



    const body = req.body || {};
    const receivingPartyName =
        normalizeOptionalString(body.receiving_party_name) ||
        existing.receiving_party_name ||
        existing.to_custodian_name ||
        null;

    const updated = await transferModel.acknowledgeReceipt(id, {
        acknowledgedAt: formatDateTime(new Date()),
        acknowledgedBy: req.user ? req.user.id : null,
        receivingPartyName
    });

    if (!updated) {
        return res.status(409).json(errorResponse('This transfer could not be acknowledged.'));
    }

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'ACKNOWLEDGE',
        tableName: TRANSFER_TABLE,
        recordId: id,
        oldValues: { receiving_party_acknowledged_at: existing.receiving_party_acknowledged_at },
        newValues: { receiving_party_acknowledged_at: updated.receiving_party_acknowledged_at },
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('Transfer receipt acknowledged successfully.', { transfer: updated }));
}


/* ========================================================================== */
/* PATCH /api/transfers/:id/cancel                                            */
/* ========================================================================== */

/**
 * Withdraws a transfer that should never have been recorded - a wrong asset
 * scanned, a duplicate entry. Restricted to Administrators and HISO because it
 * alters the movement trail rather than recording a new movement.
 *
 * The row is retained with status 'Cancelled' (never deleted) so the mistake
 * and its correction both remain visible to the Auditor. The asset's custody is
 * deliberately left untouched: cancelling the paperwork does not move an asset
 * back, and silently rewinding custody would contradict the register.
 *
 * Body (optional): { reason }
 */
async function cancelTransfer(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric transfer id is required.'));
    }

    const existing = await transferModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Transfer not found.'));
    }

    if (CLOSED_TRANSFER_STATUSES.includes(existing.status)) {
        return res
            .status(409)
            .json(errorResponse(`This transfer has already been ${String(existing.status).toLowerCase()}.`));
    }

    const reason = normalizeOptionalString((req.body || {}).reason);
    const updated = await transferModel.update(id, {
        status: 'Cancelled',
        reason: reason || existing.reason || 'Cancelled by an authorised officer.'
    });

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'CANCEL',
        tableName: TRANSFER_TABLE,
        recordId: id,
        oldValues: { status: existing.status, reason: existing.reason },
        newValues: { status: 'Cancelled', reason: updated.reason },
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('Transfer cancelled successfully.', { transfer: updated }));
}

async function approveTransfer(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric transfer id is required.'));
    }

    const existing = await transferModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Transfer not found.'));
    }
    if (existing.status !== 'Pending') {
        return res.status(409).json(errorResponse('Only pending transfers can be approved.'));
    }
    if (Number(existing.initiated_by) === Number(req.user.id)) {
        return res.status(409).json(errorResponse('A different authorised officer must approve this transfer.'));
    }

    const updated = await transferModel.approvePending(id, req.user.id);
    if (!updated) {
        return res.status(409).json(
            errorResponse(
                'The transfer is no longer pending or the asset custody changed after it was submitted.'
            )
        );
    }

    await auditLog({
        userId: req.user.id,
        action: 'APPROVE',
        tableName: TRANSFER_TABLE,
        recordId: id,
        oldValues: { status: existing.status, approved_by: existing.approved_by },
        newValues: { status: updated.status, approved_by: updated.approved_by },
        ipAddress: getClientIp(req)
    });

    return res.status(200).json(
        successResponse('Transfer approved successfully.', { transfer: updated })
    );
}

/* ========================================================================== */
/* PATCH /api/transfers/:id/reverse                                           */
/* ========================================================================== */

/**
 * Marks a recorded movement as reversed, recording WHO reversed it and why.
 *
 * The movement row is kept (status 'Reversed') so the original record survives.
 * A reversal is a bookkeeping statement about the record, so - deliberately -
 * this endpoint does not silently move the asset back. If the asset is
 * physically back with the previous custodian, that is recorded as a new
 * transfer, which keeps the trail linear and auditable.
 *
 * Restricted to Administrators and HISO.
 *
 * Body (optional): { reason }
 */
async function reverseTransfer(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric transfer id is required.'));
    }

    const existing = await transferModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Transfer not found.'));
    }

    if (existing.status !== 'Completed') {
        return res
            .status(409)
            .json(errorResponse('Only completed transfers can be reversed.'));
    }

    const reason =
        normalizeOptionalString((req.body || {}).reason) ||
        `Reversed by an authorised officer (original reason: ${existing.reason || 'none given'}).`;

    const updated = await transferModel.update(id, {
        status: 'Reversed',
        reason
    });

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'REVERSE',
        tableName: TRANSFER_TABLE,
        recordId: id,
        oldValues: { status: existing.status, reason: existing.reason },
        newValues: { status: 'Reversed', reason: updated.reason },
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('Transfer reversed successfully.', { transfer: updated }));
}

/* ========================================================================== */

module.exports = {
    // Reads
    getAllTransfers,
    getTransferStats,
    getTransferMeta,
    getRecentTransfers,
    getUnacknowledgedTransfers,
    getTransfersByUser,
    getAssetTransferHistory,
    getLatestAssetTransfer,
    getTransferById,

    // Writes
    createTransfer,
    updateTransfer,
    acknowledgeTransfer,
    approveTransfer,
    cancelTransfer,
    reverseTransfer,

    // Exported for unit testing / reuse by other modules.
    TRANSFER_STATUSES,
    TRANSFER_TYPES,
    CLOSED_TRANSFER_STATUSES,
    ASSET_CONDITIONS,
    TRANSFER_REF_PREFIX,
    validateTransferPayload,
    deriveTransferType,
    isStockMovement,
    isValidDate,
    toDayString,
    resolveAsset,
    generateTransferRef,
    today
};
