'use strict';

// controllers/assetAssignmentController.js
// Asset assignment and custody (§5.3 of the requirements): who holds which
// asset, since when, and the acknowledgement trail that proves receipt.
//
// Endpoints
//   GET    /api/assignments                    - list / search / filter + page
//   GET    /api/assignments/stats              - aggregate custody counts
//   GET    /api/assignments/meta               - ENUM choices for the UI
//   GET    /api/assignments/active             - every currently-held asset
//   GET    /api/assignments/overdue            - open assignments past return
//   GET    /api/assignments/pending            - active but not acknowledged
//   GET    /api/assignments/user/:userId       - a custodian's holdings
//   GET    /api/assignments/user/:userId/active- a custodian's current holdings
//   GET    /api/assignments/asset/:assetId/history - full custody history
//   GET    /api/assignments/asset/:assetId     - the asset's current custody
//   GET    /api/assignments/:id                - fetch one assignment
//   POST   /api/assignments                    - assign an asset to a custodian
//   PUT    /api/assignments/:id                - correct the details of one
//   PATCH  /api/assignments/:id/acknowledge    - confirm receipt
//   PATCH  /api/assignments/:id/return         - close custody (asset back)
//   PATCH  /api/assignments/:id/transfer       - hand over to another custodian
//   PATCH  /api/assignments/:id/cancel         - withdraw a mistaken assignment
//
// Conventions (mirrors assetController):
//   * Handlers are async; Express 5 forwards rejected promises to the global
//     error handler, so no try/catch wrapper is needed for unexpected errors.
//   * Responses always use the shared { status, message, data } envelope.
//   * Custody rows are never deleted - releasing closes the row and a
//     transfer opens a new one, so "previous ownership history" survives.
//   * Every mutating handler writes an audit_logs row explicitly.
//
// Roles
//   * Reads        - every authenticated role.
//   * Assign / return / transfer - Administrator, HISO, ICT Officer.
//   * Acknowledge  - the custodian themself, or Administrator / HISO.
//   * Cancel       - Administrator and HISO only.

const assignmentModel = require('../models/assetAssignmentModel');
const assetModel = require('../models/assetModel');
const userModel = require('../models/userModel');
const auditModel = require('../models/auditModel');
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
const ASSIGNMENT_TABLE = 'asset_assignments';

// ENUM values from the asset_assignments schema. Kept here so validation and
// the /meta endpoint share a single source of truth.
const ASSIGNMENT_STATUSES = Object.freeze(['Active', 'Returned', 'Transferred', 'Cancelled']);

// Statuses that mean "custody has ended" - such a row can still be read but
// never released or transferred again.
const CLOSED_STATUSES = Object.freeze(['Returned', 'Transferred', 'Cancelled']);

// Statuses an ACTIVE assignment may be cancelled from.
const CANCELLABLE_STATUSES = Object.freeze(['Active']);

// Asset condition ENUM from the `assets` table. Returning an asset records the
// condition it came back in, so the register reflects physical reality.
const ASSET_CONDITIONS = Object.freeze(['Good', 'Fair', 'Damaged', 'Obsolete']);

// Longest value each VARCHAR column accepts - validated up-front so MySQL
// never silently truncates (or 1406-errors on) user input.
const MAX_LENGTHS = Object.freeze({
    assignedToName: 100,
    department: 100,
    location: 100,
    responsibleOfficer: 100,
    purpose: 255,
    acknowledgedRemarks: 255,
    releaseReason: 255
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
 * Today's date as YYYY-MM-DD (used for the default assignment date).
 *
 * @returns {string}
 */
function today() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Validates and normalises an assignment payload.
 *
 * `isCreate` toggles the rules: on create the asset, custodian and assignment
 * date are mandatory; on update every field is optional and only the supplied
 * keys are returned.
 *
 * `assigned_user_id` and `assigned_to_name` are complementary: the id links
 * the custody to a system account while the name is what appears on the printed
 * acknowledgement form. At least one must be present on create.
 *
 * @param {object} body Raw req.body.
 * @param {object} [options]
 * @param {boolean} [options.isCreate=false]
 * @param {string|null} [options.existingAssignmentDate] The stored assignment
 *        date, used to cross-check `expected_return_date` on update.
 * @returns {{errors: object[], data: object}}
 */
function validateAssignmentPayload(
    body,
    { isCreate = false, existingAssignmentDate = null } = {}
) {
    const errors = [];
    const data = {};

    /* --------------------------- Custodian -------------------------------- */

    if (body.assigned_user_id !== undefined) {
        if (body.assigned_user_id === null || body.assigned_user_id === '') {
            data.assignedUserId = null;
        } else {
            const userId = parseId(body.assigned_user_id);
            if (userId === null) {
                pushError(
                    errors,
                    'assigned_user_id',
                    'assigned_user_id must be a positive integer.'
                );
            } else {
                data.assignedUserId = userId;
            }
        }
    }

    if (body.assigned_to_name !== undefined) {
        const name = normalizeOptionalString(body.assigned_to_name);
        if (name && name.length > MAX_LENGTHS.assignedToName) {
            pushError(
                errors,
                'assigned_to_name',
                `assigned_to_name must be ${MAX_LENGTHS.assignedToName} characters or fewer.`
            );
        } else {
            data.assignedToName = name;
        }
    }

    if (isCreate && !data.assignedUserId && !data.assignedToName) {
        pushError(
            errors,
            'assigned_user_id',
            'A custodian is required: supply assigned_user_id and/or assigned_to_name.'
        );
    }

    /* ------------------------- Location details --------------------------- */

    const textFields = [
        ['department', 'department', MAX_LENGTHS.department],
        ['location', 'location', MAX_LENGTHS.location],
        ['responsible_officer', 'responsibleOfficer', MAX_LENGTHS.responsibleOfficer],
        ['purpose', 'purpose', MAX_LENGTHS.purpose]
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

    /* ----------------------------- Dates ---------------------------------- */

    if (body.assignment_date !== undefined) {
        const value = normalizeDate(body.assignment_date);
        if (value === null) {
            pushError(errors, 'assignment_date', 'assignment_date cannot be empty.');
        } else if (!isValidDate(value)) {
            pushError(
                errors,
                'assignment_date',
                'assignment_date must be a valid date in YYYY-MM-DD format.'
            );
        } else {
            data.assignmentDate = value;
        }
    }

    if (body.expected_return_date !== undefined) {
        const value = normalizeDate(body.expected_return_date);
        if (value !== null && !isValidDate(value)) {
            pushError(
                errors,
                'expected_return_date',
                'expected_return_date must be a valid date in YYYY-MM-DD format.'
            );
        } else {
            data.expectedReturnDate = value;
        }
    }

    // An expected return date may not precede the assignment date. The stored
    // assignment_date arrives as a MySQL DATE/DATETIME value (possibly a Date
    // object), so both sides are reduced to a plain YYYY-MM-DD before comparing.
    const startDate = toDayString(data.assignmentDate ?? existingAssignmentDate);
    if (data.expectedReturnDate && startDate && data.expectedReturnDate < startDate) {
        pushError(
            errors,
            'expected_return_date',
            'expected_return_date cannot be earlier than assignment_date.'
        );
    }

    /* ---------------------------- Status ---------------------------------- */

    if (body.status !== undefined) {
        const status = normalizeString(body.status);
        if (!ASSIGNMENT_STATUSES.includes(status)) {
            pushError(
                errors,
                'status',
                `status must be one of: ${ASSIGNMENT_STATUSES.join(', ')}.`
            );
        } else {
            data.status = status;
        }
    }

    return { errors, data };
}

/* ========================================================================== */
/* GET /api/assignments                                                       */
/* ========================================================================== */

/**
 * Lists custody records with search, filters, sorting and pagination.
 *
 * Query: ?search=&asset_id=&assigned_user_id=&status=&active_only=true
 *        &department=&location=&pending_acknowledgement=true
 *        &date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 *        &sort_by=&sort_dir=&limit=&offset=
 *
 * A Departmental User only ever sees their own holdings; oversight roles see
 * the whole organisation.
 */
async function getAllAssignments(req, res) {
    const errors = [];
    const query = req.query || {};

    const assetId = query.asset_id ? parseId(query.asset_id) : null;
    if (query.asset_id && assetId === null) {
        pushError(errors, 'asset_id', 'asset_id must be a positive integer.');
    }

    let assignedUserId = query.assigned_user_id ? parseId(query.assigned_user_id) : null;
    if (query.assigned_user_id && assignedUserId === null) {
        pushError(errors, 'assigned_user_id', 'assigned_user_id must be a positive integer.');
    }

    const status = normalizeString(query.status) || undefined;
    if (status && !ASSIGNMENT_STATUSES.includes(status)) {
        pushError(errors, 'status', `status must be one of: ${ASSIGNMENT_STATUSES.join(', ')}.`);
    }

    const dateFrom = normalizeString(query.date_from) || undefined;
    if (dateFrom && !isValidDate(dateFrom)) {
        pushError(errors, 'date_from', 'date_from must be a valid date in YYYY-MM-DD format.');
    }

    const dateTo = normalizeString(query.date_to) || undefined;
    if (dateTo && !isValidDate(dateTo)) {
        pushError(errors, 'date_to', 'date_to must be a valid date in YYYY-MM-DD format.');
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    // Departmental Users are scoped to their own custody records.
    if (req.user && req.user.role === ROLES.DEPARTMENTAL_USER) {
        if (assignedUserId && assignedUserId !== Number(req.user.id)) {
            return res
                .status(403)
                .json(errorResponse('Access denied. You may only view your own assignments.'));
        }
        assignedUserId = Number(req.user.id);
    }

    const truthy = (value) => ['true', '1', 'yes'].includes(String(value || '').toLowerCase());

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 500);
    const offset = Math.max(parseInt(query.offset, 10) || 0, 0);

    const { assignments, total } = await assignmentModel.findAll({
        search: normalizeString(query.search) || undefined,
        assetId,
        assignedUserId,
        status,
        activeOnly: truthy(query.active_only),
        department: normalizeString(query.department) || undefined,
        location: normalizeString(query.location) || undefined,
        pendingAcknowledgement: truthy(query.pending_acknowledgement),
        dateFrom,
        dateTo,
        sortBy: normalizeString(query.sort_by) || 'assignment_date',
        sortDir: normalizeString(query.sort_dir) || 'desc',
        limit,
        offset
    });

    return res.status(200).json(
        successResponse('Assignments retrieved successfully.', {
            assignments,
            pagination: {
                total,
                limit,
                offset,
                returned: assignments.length
            }
        })
    );
}

/* ========================================================================== */
/* GET /api/assignments/stats                                                 */
/* ========================================================================== */

/**
 * Aggregate custody counts used by the summary tiles. A Departmental User is
 * scoped to their own holdings.
 */
async function getAssignmentStats(req, res) {
    const scopedUserId =
        req.user && req.user.role === ROLES.DEPARTMENTAL_USER ? Number(req.user.id) : null;

    const stats = await assignmentModel.getStats({ assignedUserId: scopedUserId });

    return res
        .status(200)
        .json(successResponse('Assignment statistics retrieved successfully.', stats));
}

/* ========================================================================== */
/* GET /api/assignments/meta                                                  */
/* ========================================================================== */

/**
 * Reference data for building the assignment UI: the status ENUM and the list
 * of custodian accounts an asset may be handed to.
 *
 * Query: ?active_users=false includes deactivated accounts too.
 */
async function getAssignmentMeta(req, res) {
    const activeOnly = !['false', '0', 'no'].includes(
        String(((req.query || {}).active_users) || 'true').toLowerCase()
    );

    const { users } = await userModel.findAll({
        isActive: activeOnly ? true : undefined,
        limit: 500
    });

    return res.status(200).json(
        successResponse('Assignment reference data retrieved successfully.', {
            statuses: [...ASSIGNMENT_STATUSES],
            users: users.map((user) => ({
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role,
                is_active: !!user.is_active
            }))
        })
    );
}

/* ========================================================================== */
/* GET /api/assignments/active | /overdue | /pending                          */
/* ========================================================================== */

/**
 * Every assignment that is currently open (`released_at IS NULL`) - i.e. the
 * list of assets physically out with a custodian right now.
 */
async function getActiveAssignments(req, res) {
    const query = req.query || {};
    const scopedUserId =
        req.user && req.user.role === ROLES.DEPARTMENTAL_USER ? Number(req.user.id) : null;

    const { assignments, total } = await assignmentModel.findAll({
        activeOnly: true,
        assignedUserId: scopedUserId,
        department: normalizeString(query.department) || undefined,
        location: normalizeString(query.location) || undefined,
        limit: Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 500),
        offset: Math.max(parseInt(query.offset, 10) || 0, 0)
    });

    return res.status(200).json(
        successResponse('Active assignments retrieved successfully.', {
            assignments,
            total,
            returned: assignments.length
        })
    );
}

/**
 * Open assignments whose expected return date has already passed. Drives the
 * "overdue custody" follow-up list.
 */
async function getOverdueAssignments(req, res) {
    const query = req.query || {};
    const scopedUserId =
        req.user && req.user.role === ROLES.DEPARTMENTAL_USER ? Number(req.user.id) : null;

    const { assignments, total } = await assignmentModel.findAll({
        activeOnly: true,
        assignedUserId: scopedUserId,
        limit: Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 500),
        offset: Math.max(parseInt(query.offset, 10) || 0, 0)
    });

    const asOf = today();
    const overdue = assignments.filter((row) => {
        const due = toDayString(row.expected_return_date);
        return !!due && due < asOf;
    });

    return res.status(200).json(
        successResponse('Overdue assignments retrieved successfully.', {
            assignments: overdue,
            as_of: asOf,
            total,
            overdue: overdue.length
        })
    );
}

/**
 * Open assignments that the custodian has not yet acknowledged.
 */
async function getPendingAcknowledgements(req, res) {
    const query = req.query || {};
    const scopedUserId =
        req.user && req.user.role === ROLES.DEPARTMENTAL_USER ? Number(req.user.id) : null;

    const { assignments, total } = await assignmentModel.findAll({
        pendingAcknowledgement: true,
        assignedUserId: scopedUserId,
        limit: Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 500),
        offset: Math.max(parseInt(query.offset, 10) || 0, 0)
    });

    return res.status(200).json(
        successResponse('Assignments awaiting acknowledgement retrieved successfully.', {
            assignments,
            total,
            pending: assignments.length
        })
    );
}

/* ========================================================================== */
/* GET /api/assignments/user/:userId  (+ ?active_only=true)                    */
/* ========================================================================== */

/**
 * A custodian's custody records. A Departmental User may only request their own
 * holdings; oversight roles may request any custodian's.
 */
async function getAssignmentsByUser(req, res) {
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
            .json(errorResponse('Access denied. You may only view your own assignments.'));
    }

    const user = await userModel.findById(userId);
    if (!user) {
        return res.status(404).json(errorResponse('User not found.'));
    }

    const activeOnly = ['true', '1', 'yes'].includes(
        String(((req.query || {}).active_only) || '').toLowerCase()
    );

    const assignments = await assignmentModel.findByUserId(userId, { activeOnly });

    return res.status(200).json(
        successResponse('Custodian assignments retrieved successfully.', {
            user: {
                id: user.id,
                username: user.username,
                full_name: user.full_name,
                role: user.role
            },
            assignments,
            total: assignments.length,
            active: assignments.filter((row) => !row.released_at).length
        })
    );
}

/* ========================================================================== */
/* GET /api/assignments/asset/:assetId  (+ /history)                          */
/* ========================================================================== */

/**
 * The current custody of an asset, or an empty result when it is not assigned.
 * Accepts a numeric id, a generated asset code or a physical asset tag.
 */
async function getAssetAssignment(req, res) {
    const asset = await resolveAsset(req.params.assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const assignment = await assignmentModel.findActiveByAssetId(asset.id);
    if (
        req.user &&
        req.user.role === ROLES.DEPARTMENTAL_USER &&
        (!assignment || Number(assignment.assigned_user_id) !== Number(req.user.id))
    ) {
        return res.status(404).json(errorResponse('Asset assignment not found.'));
    }

    return res.status(200).json(
        successResponse(
            assignment
                ? 'Asset assignment retrieved successfully.'
                : 'This asset is not currently assigned to a custodian.',
            {
                asset: {
                    id: asset.id,
                    asset_id: asset.asset_id,
                    asset_tag: asset.asset_tag,
                    status: asset.status,
                    location: asset.location,
                    department: asset.department
                },
                assignment,
                assigned: !!assignment
            }
        )
    );
}

/**
 * The complete custody history for an asset, newest first. Because released
 * rows are retained, this is the "previous assignment history" the business
 * rules require when an asset changes custodian.
 */
async function getAssetAssignmentHistory(req, res) {
    const asset = await resolveAsset(req.params.assetId);
    if (!asset) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    const allHistory = await assignmentModel.findHistoryByAssetId(asset.id);
    const history = req.user && req.user.role === ROLES.DEPARTMENTAL_USER
        ? allHistory.filter((row) => Number(row.assigned_user_id) === Number(req.user.id))
        : allHistory;
    if (req.user && req.user.role === ROLES.DEPARTMENTAL_USER && !history.length) {
        return res.status(404).json(errorResponse('Asset assignment history not found.'));
    }
    const active = history.find((row) => !row.released_at) || null;

    return res.status(200).json(
        successResponse('Asset custody history retrieved successfully.', {
            asset_id: asset.id,
            asset_code: asset.asset_id,
            asset_tag: asset.asset_tag,
            current_assignment_id: active ? active.id : null,
            history,
            total: history.length
        })
    );
}

/* ========================================================================== */
/* GET /api/assignments/:id                                                   */
/* ========================================================================== */

/**
 * Fetches a single assignment by its numeric id.
 */
async function getAssignmentById(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric assignment id is required.'));
    }

    const assignment = await assignmentModel.findById(id);
    if (!assignment) {
        return res.status(404).json(errorResponse('Assignment not found.'));
    }

    // A Departmental User may only read their own custody records.
    if (
        req.user &&
        req.user.role === ROLES.DEPARTMENTAL_USER &&
        Number(assignment.assigned_user_id) !== Number(req.user.id)
    ) {
        return res
            .status(403)
            .json(errorResponse('Access denied. You may only view your own assignments.'));
    }

    return res
        .status(200)
        .json(successResponse('Assignment retrieved successfully.', { assignment }));
}

/* ========================================================================== */
/* POST /api/assignments                                                      */
/* ========================================================================== */

/**
 * Assigns an asset to a custodian.
 *
 * Body:
 *   asset_id | asset_code | asset_tag  (one of them; identifies the asset)
 *   assigned_user_id                   (system account, optional if a name is given)
 *   assigned_to_name                   (printed name, optional if an id is given)
 *   department, location, responsible_officer, purpose, remarks,
 *   assignment_date (defaults to today), expected_return_date
 *
 * Rules
 *   * An asset already held by someone cannot be assigned again - the caller
 *     must transfer or return it first, otherwise the custody chain would have
 *     two open rows.
 *   * A disposed asset cannot be assigned.
 *   * Assigning flips the asset to 'In Use' and mirrors the custodian, location
 *     and department onto the register row so the two stay consistent.
 */
async function createAssignment(req, res) {
    const body = req.body || {};

    const asset = await resolveAsset(body.asset_code || body.asset_tag || body.asset_id);
    if (!asset) {
        return res
            .status(404)
            .json(errorResponse('Asset not found. Check the asset id or tag and try again.'));
    }

    if (asset.status === 'Disposed' || asset.status === 'Retired') {
        return res
            .status(409)
            .json(
                errorResponse(
                    `This asset is marked '${asset.status}' and can no longer be assigned to a custodian.`
                )
            );
    }

    const { errors, data } = validateAssignmentPayload(body, { isCreate: true });

    // Resolve the custodian account when one was supplied.
    let custodian = null;
    if (data.assignedUserId) {
        custodian = await userModel.findById(data.assignedUserId);
        if (!custodian) {
            errors.push({
                field: 'assigned_user_id',
                message: 'The selected custodian account does not exist.'
            });
        } else if (!custodian.is_active) {
            errors.push({
                field: 'assigned_user_id',
                message: 'The selected custodian account has been deactivated.'
            });
        }
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    // Only one open assignment may exist per asset.
    const existing = await assignmentModel.findActiveByAssetId(asset.id);
    if (existing) {
        return res.status(409).json(
            errorResponse(
                'This asset is already assigned. Return or transfer the current assignment first.',
                [
                    {
                        field: 'asset_id',
                        message: `Assignment #${existing.id} is still open (custodian: ${
                            existing.assigned_full_name || existing.assigned_to_name || 'unknown'
                        }).`
                    }
                ]
            )
        );
    }

    const assignmentDate = data.assignmentDate || today();

    const created = await assignmentModel.create({
        assetId: asset.id,
        assignedUserId: data.assignedUserId ?? null,
        // Fall back to the account's full name so the acknowledgement form is
        // never blank when the caller only supplied an id.
        assignedToName: data.assignedToName ?? (custodian ? custodian.full_name : null),
        department: data.department ?? asset.department ?? null,
        location: data.location ?? asset.location ?? null,
        responsibleOfficer: data.responsibleOfficer ?? null,
        assignmentDate,
        expectedReturnDate: data.expectedReturnDate ?? null,
        purpose: data.purpose ?? null,
        remarks: data.remarks ?? null,
        status: data.status || 'Active',
        assignedBy: req.user ? req.user.id : null
    });

    // Mirror custody onto the register so the asset list stays accurate.
    const assetUpdates = { status: 'In Use' };
    if (data.assignedUserId) assetUpdates.assignedUserId = data.assignedUserId;
    if (data.department) assetUpdates.department = data.department;
    if (data.location) assetUpdates.location = data.location;
    if (data.responsibleOfficer) assetUpdates.responsibleOfficer = data.responsibleOfficer;

    const updatedAsset = await assetModel.update(asset.id, assetUpdates);

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'ASSIGN',
        tableName: ASSIGNMENT_TABLE,
        recordId: created.id,
        oldValues: null,
        newValues: created,
        ipAddress: getClientIp(req)
    });

    if (updatedAsset) {
        await auditLog({
            userId: req.user ? req.user.id : null,
            action: 'UPDATE',
            tableName: 'assets',
            recordId: asset.id,
            oldValues: asset,
            newValues: updatedAsset,
            ipAddress: getClientIp(req)
        });
    }

    return res.status(201).json(
        successResponse('Asset assigned successfully.', {
            assignment: created,
            asset: updatedAsset,
            acknowledged: !!created.acknowledged_at
        })
    );
}

/* ========================================================================== */
/* PUT / PATCH /api/assignments/:id                                           */
/* ========================================================================== */

/**
 * Corrects the details of an assignment record - a mistyped department, a
 * revised expected return date, additional remarks.
 *
 * The custody chain itself (the asset, the custodian and the date the row was
 * opened) is immutable: changing the custodian here would silently rewrite
 * history, so a hand-over must go through `PATCH /:id/transfer` which closes
 * this row and opens a new one.
 */
async function updateAssignment(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric assignment id is required.'));
    }

    const existing = await assignmentModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Assignment not found.'));
    }

    const body = { ...(req.body || {}) };

    // Immutable identity fields.
    if (
        body.asset_id !== undefined ||
        body.asset_code !== undefined ||
        body.asset_tag !== undefined
    ) {
        return res.status(400).json(
            errorResponse('Validation failed.', [
                {
                    field: 'asset_id',
                    message:
                        'The asset of an assignment cannot be changed. Cancel this assignment and create a new one instead.'
                }
            ])
        );
    }

    if (
        body.assigned_user_id !== undefined &&
        Number(body.assigned_user_id) !== Number(existing.assigned_user_id)
    ) {
        return res.status(400).json(
            errorResponse('Validation failed.', [
                {
                    field: 'assigned_user_id',
                    message:
                        'The custodian cannot be changed here. Use PATCH /:id/transfer to hand the asset over without losing history.'
                }
            ])
        );
    }

    delete body.assigned_user_id;

    const { errors, data } = validateAssignmentPayload(body, {
        existingAssignmentDate: existing.assignment_date
    });

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    if (!Object.keys(data).length) {
        return res.status(400).json(errorResponse('No updatable fields were supplied.'));
    }

    // A closed row may only have its descriptive fields corrected.
    if (existing.released_at && data.status === 'Active') {
        return res.status(409).json(
            errorResponse('This assignment has been closed and cannot be reopened as Active.')
        );
    }

    const updated = await assignmentModel.update(id, data);

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'UPDATE',
        tableName: ASSIGNMENT_TABLE,
        recordId: id,
        oldValues: existing,
        newValues: updated,
        ipAddress: getClientIp(req)
    });

    const changedFields = Object.keys(data).filter(
        (key) => String(existing[key] ?? '') !== String(updated[key] ?? '')
    );

    return res.status(200).json(
        successResponse('Assignment updated successfully.', {
            assignment: updated,
            changed_fields: changedFields
        })
    );
}

/* ========================================================================== */
/* PATCH /api/assignments/:id/acknowledge                                     */
/* ========================================================================== */

/**
 * Records confirmation of receipt. §5.3 requires an acknowledgement of the
 * hand-over, and §9 gives Departmental Users the right to acknowledge their own
 * assets - so a Departmental User may only acknowledge an assignment made to
 * themselves. Administrators and HISO may acknowledge on a custodian's behalf
 * (for example when a signed form is filed later).
 *
 * Body (all optional): { remarks }
 */
async function acknowledgeAssignment(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric assignment id is required.'));
    }

    const existing = await assignmentModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Assignment not found.'));
    }

    if (existing.released_at) {
        return res.status(409).json(
            errorResponse('This assignment has already been closed and cannot be acknowledged.')
        );
    }

    const isOversight = req.user && [ROLES.ADMIN, ROLES.HISO].includes(req.user.role);
    const isCustodian = req.user && Number(existing.assigned_user_id) === Number(req.user.id);

    if (!isOversight && !isCustodian) {
        return res.status(403).json(
            errorResponse(
                'Access denied. Only the custodian, a System Administrator or HISO may acknowledge receipt.'
            )
        );
    }

    if (existing.acknowledged_at) {
        return res
            .status(409)
            .json(errorResponse('This assignment has already been acknowledged.'));
    }

    const remarks = normalizeOptionalString((req.body || {}).remarks);
    if (remarks && remarks.length > MAX_LENGTHS.acknowledgedRemarks) {
        return res.status(400).json(
            errorResponse('Validation failed.', [
                {
                    field: 'remarks',
                    message: `remarks must be ${MAX_LENGTHS.acknowledgedRemarks} characters or fewer.`
                }
            ])
        );
    }

    const acknowledged = await assignmentModel.acknowledge(id, {
        acknowledgedAt: formatDateTime(new Date()),
        acknowledgedBy: req.user ? req.user.id : null,
        acknowledgedRemarks: remarks
    });

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'ACKNOWLEDGE',
        tableName: ASSIGNMENT_TABLE,
        recordId: id,
        oldValues: existing,
        newValues: acknowledged,
        ipAddress: getClientIp(req)
    });

    return res
        .status(200)
        .json(successResponse('Receipt acknowledged successfully.', { assignment: acknowledged }));
}

/* ========================================================================== */
/* PATCH /api/assignments/:id/return                                          */
/* ========================================================================== */

/**
 * Closes the custody: the asset comes back into ICT stores. The assignment row
 * is retained (marked 'Returned') rather than deleted, so the history of who
 * held the asset and for how long survives permanently.
 *
 * Body (all optional):
 *   condition_status  ('Good' | 'Fair' | 'Damaged' | 'Obsolete')
 *   location          where the asset is being stored now
 *   department        receiving department
 *   release_reason    free text, e.g. 'Staff member left the organisation'
 */
async function returnAssignment(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric assignment id is required.'));
    }

    const existing = await assignmentModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Assignment not found.'));
    }

    if (existing.released_at) {
        return res.status(409).json(errorResponse('This assignment has already been closed.'));
    }

    const body = req.body || {};

    const conditionStatus = normalizeString(body.condition_status);
    if (conditionStatus && !ASSET_CONDITIONS.includes(conditionStatus)) {
        return res.status(400).json(
            errorResponse('Validation failed.', [
                {
                    field: 'condition_status',
                    message: `condition_status must be one of: ${ASSET_CONDITIONS.join(', ')}.`
                }
            ])
        );
    }

    const releaseReason = normalizeOptionalString(body.release_reason);
    if (releaseReason && releaseReason.length > MAX_LENGTHS.releaseReason) {
        return res.status(400).json(
            errorResponse('Validation failed.', [
                {
                    field: 'release_reason',
                    message: `release_reason must be ${MAX_LENGTHS.releaseReason} characters or fewer.`
                }
            ])
        );
    }

    const released = await assignmentModel.release(id, {
        releasedAt: formatDateTime(new Date()),
        releasedBy: req.user ? req.user.id : null,
        releaseReason: releaseReason || 'Returned to ICT stores',
        status: 'Returned'
    });

    if (!released) {
        return res
            .status(409)
            .json(errorResponse('This assignment could not be closed. It may already be closed.'));
    }

    // The register row follows the custody: released custodian, back in stock.
    const assetUpdates = {
        status: 'In Stock',
        assignedUserId: null,
        location: normalizeOptionalString(body.location) ?? released.location ?? null
    };
    if (conditionStatus) assetUpdates.conditionStatus = conditionStatus;
    if (normalizeString(body.department)) {
        assetUpdates.department = normalizeString(body.department);
    }

    const updatedAsset = await assetModel.update(released.asset_id, assetUpdates);

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'RETURN',
        tableName: ASSIGNMENT_TABLE,
        recordId: id,
        oldValues: existing,
        newValues: released,
        ipAddress: getClientIp(req)
    });

    if (updatedAsset) {
        await auditLog({
            userId: req.user ? req.user.id : null,
            action: 'UPDATE',
            tableName: 'assets',
            recordId: updatedAsset.id,
            oldValues: {
                status: existing.asset_status,
                assigned_user_id: existing.assigned_user_id,
                location: existing.location
            },
            newValues: updatedAsset,
            ipAddress: getClientIp(req)
        });
    }

    return res.status(200).json(
        successResponse('Asset returned to ICT stores successfully.', {
            assignment: released,
            asset: updatedAsset
        })
    );
}


/* ========================================================================== */
/* PATCH /api/assignments/:id/transfer                                        */
/* ========================================================================== */

/**
 * Hands an asset straight from one custodian to another.
 *
 * This is deliberately a two-step, history-preserving operation:
 *   1. the current row is closed with status 'Transferred' (it keeps its
 *      custodian, dates and release reason), and
 *   2. a brand-new open row is created for the receiving custodian.
 *
 * The old row is never overwritten, which is exactly what the business rule
 * "Transfers must not erase previous ownership or location history" demands.
 *
 * Body:
 *   assigned_user_id | assigned_to_name   (the receiving custodian - required)
 *   department, location, responsible_officer, purpose, remarks,
 *   transfer_date (defaults to today), expected_return_date, release_reason
 */
async function transferAssignment(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric assignment id is required.'));
    }

    const existing = await assignmentModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Assignment not found.'));
    }

    if (existing.released_at) {
        return res.status(409).json(
            errorResponse(
                'This assignment has already been closed. Assign the asset to the new custodian directly instead.'
            )
        );
    }

    const body = req.body || {};

    // The receiving custodian is mandatory - otherwise the new row would open
    // with nobody accountable for the asset.
    const { errors, data } = validateAssignmentPayload(body, { isCreate: true });

    let custodian = null;
    if (data.assignedUserId) {
        custodian = await userModel.findById(data.assignedUserId);
        if (!custodian) {
            errors.push({
                field: 'assigned_user_id',
                message: 'The selected custodian account does not exist.'
            });
        } else if (!custodian.is_active) {
            errors.push({
                field: 'assigned_user_id',
                message: 'The selected custodian account has been deactivated.'
            });
        } else if (Number(custodian.id) === Number(existing.assigned_user_id)) {
            errors.push({
                field: 'assigned_user_id',
                message: 'The asset is already held by this custodian.'
            });
        }
    }

    if (errors.length) {
        return res.status(400).json(errorResponse('Validation failed.', errors));
    }

    const transferDate = data.assignmentDate || today();
    const releaseReason =
        normalizeOptionalString(body.release_reason) ||
        `Transferred to ${data.assignedToName || (custodian ? custodian.full_name : 'another custodian')}`;

    const released = await assignmentModel.release(id, {
        releasedAt: formatDateTime(new Date()),
        releasedBy: req.user ? req.user.id : null,
        releaseReason,
        status: 'Transferred'
    });

    if (!released) {
        return res
            .status(409)
            .json(errorResponse('This assignment could not be closed. It may already be closed.'));
    }

    const created = await assignmentModel.create({
        assetId: existing.asset_id,
        assignedUserId: data.assignedUserId ?? null,
        assignedToName: data.assignedToName ?? (custodian ? custodian.full_name : null),
        department: data.department ?? released.department ?? null,
        location: data.location ?? released.location ?? null,
        responsibleOfficer: data.responsibleOfficer ?? released.responsible_officer ?? null,
        assignmentDate: transferDate,
        expectedReturnDate: data.expectedReturnDate ?? null,
        purpose: data.purpose ?? released.purpose ?? null,
        remarks: data.remarks ?? null,
        status: 'Active',
        assignedBy: req.user ? req.user.id : null
    });

    // Mirror the new custodian onto the register.
    const assetUpdates = { status: 'In Use' };
    if (data.assignedUserId) assetUpdates.assignedUserId = data.assignedUserId;
    if (data.department ?? released.department) {
        assetUpdates.department = data.department ?? released.department;
    }
    if (data.location ?? released.location) {
        assetUpdates.location = data.location ?? released.location;
    }
    if (data.responsibleOfficer ?? released.responsible_officer) {
        assetUpdates.responsibleOfficer = data.responsibleOfficer ?? released.responsible_officer;
    }

    const updatedAsset = await assetModel.update(existing.asset_id, assetUpdates);

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'TRANSFER',
        tableName: ASSIGNMENT_TABLE,
        recordId: created.id,
        oldValues: existing,
        newValues: created,
        ipAddress: getClientIp(req)
    });

    return res.status(201).json(
        successResponse('Asset transferred successfully.', {
            previous_assignment: released,
            assignment: created,
            asset: updatedAsset
        })
    );
}


/* ========================================================================== */
/* PATCH /api/assignments/:id/cancel                                          */
/* ========================================================================== */

/**
 * Withdraws an assignment that should never have been recorded - a wrong asset
 * scanned, a duplicate entry. Restricted to Administrators and HISO because it
 * is a correction of the record rather than a custody event.
 *
 * The row is retained with status 'Cancelled' (never deleted) so the mistake
 * and its correction both remain visible to the Auditor.
 *
 * Body (optional): { release_reason }
 */
async function cancelAssignment(req, res) {
    const id = parseId(req.params.id);
    if (id === null) {
        return res.status(400).json(errorResponse('A valid numeric assignment id is required.'));
    }

    const existing = await assignmentModel.findById(id);
    if (!existing) {
        return res.status(404).json(errorResponse('Assignment not found.'));
    }

    if (existing.released_at) {
        return res.status(409).json(errorResponse('This assignment has already been closed.'));
    }

    const releaseReason =
        normalizeOptionalString((req.body || {}).release_reason) ||
        'Cancelled - recorded in error';

    if (releaseReason.length > MAX_LENGTHS.releaseReason) {
        return res.status(400).json(
            errorResponse('Validation failed.', [
                {
                    field: 'release_reason',
                    message: `release_reason must be ${MAX_LENGTHS.releaseReason} characters or fewer.`
                }
            ])
        );
    }

    const cancelled = await assignmentModel.release(id, {
        releasedAt: formatDateTime(new Date()),
        releasedBy: req.user ? req.user.id : null,
        releaseReason,
        status: 'Cancelled'
    });

    if (!cancelled) {
        return res
            .status(409)
            .json(errorResponse('This assignment could not be cancelled. It may already be closed.'));
    }

    // The asset never really left ICT stores, so release it back to stock.
    const updatedAsset = await assetModel.update(cancelled.asset_id, {
        status: 'In Stock',
        assignedUserId: null
    });

    await auditLog({
        userId: req.user ? req.user.id : null,
        action: 'CANCEL',
        tableName: ASSIGNMENT_TABLE,
        recordId: id,
        oldValues: existing,
        newValues: cancelled,
        ipAddress: getClientIp(req)
    });

    return res.status(200).json(
        successResponse('Assignment cancelled successfully.', {
            assignment: cancelled,
            asset: updatedAsset
        })
    );
}

/* ========================================================================== */

module.exports = {
    // Reads
    getAllAssignments,
    getAssignmentStats,
    getAssignmentMeta,
    getActiveAssignments,
    getOverdueAssignments,
    getPendingAcknowledgements,
    getAssignmentsByUser,
    getAssetAssignment,
    getAssetAssignmentHistory,
    getAssignmentById,

    // Writes
    createAssignment,
    updateAssignment,
    acknowledgeAssignment,
    returnAssignment,
    transferAssignment,
    cancelAssignment,

    // Exported for unit testing / reuse by other modules.
    ASSIGNMENT_STATUSES,
    CLOSED_STATUSES,
    CANCELLABLE_STATUSES,
    ASSET_CONDITIONS,
    validateAssignmentPayload,
    isValidDate,
    toDayString,
    resolveAsset,
    today
};

