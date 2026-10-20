'use strict';

const assetModel = require('../models/assetModel');
const licenceModel = require('../models/licenceModel');
const db = require('../config/db');
const { auditLog } = require('../middleware/auditMiddleware');
const { getClientIp, successResponse, errorResponse } = require('../utils/helpers');

const TYPES = Object.freeze(['Per User', 'Per Device', 'Concurrent', 'Subscription', 'Perpetual', 'Other']);
const STATUSES = Object.freeze(['Active', 'Suspended', 'Expired', 'Retired']);
const MAX_LIMIT = 200;
const MAX_EXPIRY_DAYS = 3650;

function parseId(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function isDate(value, optional = false) {
    if ((value === '' || value === null || value === undefined) && optional) return true;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function clean(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function validate(body, partial = false) {
    const errors = [];
    const values = {};
    const lengths = {
        software_name: 150,
        publisher: 150,
        purchase_reference: 100,
        currency: 10,
        notes: 2000
    };
    for (const [field, max] of Object.entries(lengths)) {
        if (body[field] !== undefined) {
            const value = clean(body[field]);
            if (value.length > max) errors.push({ field, message: `${field} must be ${max} characters or fewer.` });
            else values[field] = value || null;
        }
    }

    if (!partial || body.licence_type !== undefined) {
        const type = clean(body.licence_type) || 'Per User';
        if (!TYPES.includes(type)) errors.push({ field: 'licence_type', message: `Choose one of: ${TYPES.join(', ')}.` });
        else values.licence_type = type;
    }
    if (!partial || body.purchased_quantity !== undefined) {
        const quantity = Number(body.purchased_quantity);
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) {
            errors.push({ field: 'purchased_quantity', message: 'Purchased quantity must be a whole number between 1 and 1,000,000.' });
        } else values.purchased_quantity = quantity;
    }
    if (!partial || body.unit_cost !== undefined) {
        const cost = body.unit_cost === '' || body.unit_cost === null || body.unit_cost === undefined
            ? 0
            : Number(body.unit_cost);
        if (!Number.isFinite(cost) || cost < 0 || cost > 9999999999999) {
            errors.push({ field: 'unit_cost', message: 'Unit cost must be a valid non-negative amount.' });
        } else values.unit_cost = cost;
    }
    for (const field of ['purchased_date', 'expiry_date']) {
        if (body[field] !== undefined) {
            if (!isDate(body[field], true)) errors.push({ field, message: 'Enter a valid YYYY-MM-DD date.' });
            else values[field] = clean(body[field]) || null;
        } else if (!partial) values[field] = null;
    }
    if (values.purchased_date && values.expiry_date && values.expiry_date < values.purchased_date) {
        errors.push({ field: 'expiry_date', message: 'Expiry date cannot be before the purchase date.' });
    }
    if (body.status !== undefined) {
        const status = clean(body.status);
        if (!STATUSES.includes(status)) errors.push({ field: 'status', message: `Choose one of: ${STATUSES.join(', ')}.` });
        else values.status = status;
    }
    if (!partial && !values.software_name) {
        errors.push({ field: 'software_name', message: 'Software name is required.' });
    }
    if (partial && !Object.keys(values).length) {
        errors.push({ field: 'licence', message: 'At least one editable field is required.' });
    }
    return { errors, values };
}

function safeLicence(record) {
    if (!record) return record;
    return { ...record };
}

async function getMeta(req, res) {
    return res.json(successResponse('Licence options retrieved.', { types: TYPES, statuses: STATUSES }));
}

async function list(req, res) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, MAX_LIMIT));
    const status = clean(req.query.status);
    if (status && !STATUSES.includes(status)) {
        return res.status(400).json(errorResponse(`Status must be one of: ${STATUSES.join(', ')}.`));
    }
    const { rows, total } = await licenceModel.findAll({
        search: clean(req.query.search),
        status: status || undefined,
        limit,
        offset: (page - 1) * limit
    });
    return res.json(successResponse('Software licences retrieved.', {
        items: rows.map(safeLicence),
        pagination: { total, page, limit, total_pages: Math.max(1, Math.ceil(total / limit)) }
    }));
}

async function stats(req, res) {
    return res.json(successResponse('Licence statistics retrieved.', await licenceModel.getStats()));
}

async function expiring(req, res) {
    const days = req.query.days === undefined ? 90 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 0 || days > MAX_EXPIRY_DAYS) {
        return res.status(400).json(errorResponse(`days must be a whole number between 0 and ${MAX_EXPIRY_DAYS}.`));
    }
    const rows = await licenceModel.findExpiring(days);
    return res.json(successResponse('Expiring licences retrieved.', {
        days,
        items: rows.map(safeLicence),
        total: rows.length
    }));
}

async function getById(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid licence id is required.'));
    const record = await licenceModel.findById(id);
    if (!record) return res.status(404).json(errorResponse('Licence not found.'));
    const allocations = await licenceModel.findAllocations(id);
    return res.json(successResponse('Licence retrieved.', {
        ...safeLicence(record),
        allocations
    }));
}

async function create(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { errors, values } = validate(body);
    if (errors.length) return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    const record = await licenceModel.create({
        ...values,
        currency: values.currency || 'USD',
        created_by: req.user.id
    });
    await auditLog({
        userId: req.user.id,
        action: 'CREATE',
        tableName: 'software_licences',
        recordId: record.id,
        newValues: safeLicence(record),
        ipAddress: getClientIp(req)
    });
    return res.status(201).json(successResponse('Software licence recorded.', safeLicence(record)));
}

async function update(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid licence id is required.'));
    const existing = await licenceModel.findById(id);
    if (!existing) return res.status(404).json(errorResponse('Licence not found.'));
    const { errors, values } = validate(req.body || {}, true);
    if (values.status !== undefined) {
        errors.push({ field: 'status', message: 'Use the status endpoint to change licence status.' });
    }
    if (errors.length) return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    const result = await licenceModel.updateDetails(id, values);
    if (result === -1) {
        return res.status(409).json(errorResponse('Purchased quantity cannot be less than the number of currently allocated licences.'));
    }
    if (!result) return res.status(404).json(errorResponse('Licence not found.'));
    const updated = await licenceModel.findById(id);
    await auditLog({
        userId: req.user.id,
        action: 'UPDATE',
        tableName: 'software_licences',
        recordId: id,
        oldValues: safeLicence(existing),
        newValues: values,
        ipAddress: getClientIp(req)
    });
    return res.json(successResponse('Software licence updated.', safeLicence(updated)));
}

async function setStatus(req, res) {
    const id = parseId(req.params.id);
    const status = clean(req.body && req.body.status);
    if (!id) return res.status(400).json(errorResponse('A valid licence id is required.'));
    if (!STATUSES.includes(status)) return res.status(400).json(errorResponse(`Status must be one of: ${STATUSES.join(', ')}.`));
    const existing = await licenceModel.findById(id);
    if (!existing) return res.status(404).json(errorResponse('Licence not found.'));
    const updated = await licenceModel.setStatus(id, status);
    if (updated === -1) {
        return res.status(409).json(errorResponse('Release all active allocations before retiring this licence.'));
    }
    if (!updated) return res.status(404).json(errorResponse('Licence not found.'));
    await auditLog({
        userId: req.user.id,
        action: 'STATUS',
        tableName: 'software_licences',
        recordId: id,
        oldValues: { status: existing.status },
        newValues: { status },
        ipAddress: getClientIp(req)
    });
    return res.json(successResponse('Licence status updated.', safeLicence(await licenceModel.findById(id))));
}

async function allocate(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid licence id is required.'));
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const assetId = body.asset_id ? parseId(body.asset_id) : null;
    const userId = body.user_id ? parseId(body.user_id) : null;
    const quantity = Number(body.quantity);
    const errors = [];
    if ((!assetId && !userId) || (body.asset_id && !assetId) || (body.user_id && !userId)) {
        errors.push({ field: 'assignee', message: 'Choose a valid asset or user.' });
    }
    if (assetId && userId) errors.push({ field: 'assignee', message: 'Allocate to either one asset or one user, not both.' });
    if (!Number.isInteger(quantity) || quantity < 1) errors.push({ field: 'quantity', message: 'Quantity must be a positive whole number.' });
    const notes = clean(body.notes);
    if (notes.length > 1000) errors.push({ field: 'notes', message: 'Notes must be 1000 characters or fewer.' });
    if (errors.length) return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));

    if (assetId && !await assetModel.findById(assetId)) return res.status(404).json(errorResponse('Asset not found.'));
    if (userId) {
        const [users] = await db.query(
            'SELECT id FROM users WHERE id = ? AND is_active = 1 LIMIT 1',
            [userId]
        );
        if (!users.length) return res.status(404).json(errorResponse('Active user not found.'));
    }

    const result = await licenceModel.allocate(id, {
        asset_id: assetId,
        user_id: userId,
        quantity,
        notes,
        allocated_by: req.user.id
    });
    if (result.error) return res.status(409).json(errorResponse(result.error));
    await auditLog({
        userId: req.user.id,
        action: 'ALLOCATE',
        tableName: 'software_licence_allocations',
        recordId: result.allocation.id,
        newValues: result.allocation,
        ipAddress: getClientIp(req)
    });
    return res.status(201).json(successResponse('Licence allocation recorded.', result.allocation));
}

async function release(req, res) {
    const id = parseId(req.params.id);
    const allocationId = parseId(req.params.allocationId);
    if (!id || !allocationId) {
        return res.status(400).json(errorResponse('Valid licence and allocation ids are required.'));
    }
    const rows = await licenceModel.findAllocations(id);
    const allocation = rows.find((row) => Number(row.id) === allocationId);
    if (!allocation) return res.status(404).json(errorResponse('Allocation not found.'));
    if (allocation.status !== 'Active') return res.status(409).json(errorResponse('Allocation is already released.'));
    const changed = await licenceModel.release(id, allocationId, req.user.id);
    if (!changed) return res.status(409).json(errorResponse('Allocation has already changed.'));
    await auditLog({
        userId: req.user.id,
        action: 'RELEASE',
        tableName: 'software_licence_allocations',
        recordId: allocationId,
        oldValues: { status: allocation.status },
        newValues: { status: 'Released' },
        ipAddress: getClientIp(req)
    });
    return res.json(successResponse('Licence allocation released.', await licenceModel.findById(id)));
}

module.exports = { TYPES, STATUSES, getMeta, list, stats, expiring, getById, create, update, setStatus, allocate, release };