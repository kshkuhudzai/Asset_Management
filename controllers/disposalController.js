'use strict';

const assetModel = require('../models/assetModel');
const disposalModel = require('../models/disposalModel');
const { auditLog } = require('../middleware/auditMiddleware');
const { getClientIp, successResponse, errorResponse } = require('../utils/helpers');

const METHODS = Object.freeze([
    'Sale',
    'Donation',
    'Recycling',
    'Destruction',
    'Return to Supplier',
    'Other'
]);
const CONDITIONS = Object.freeze(['Good', 'Fair', 'Damaged', 'Obsolete']);
const MAX_LIMIT = 200;

function parseId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

async function getMeta(req, res) {
    return res.json(successResponse('Disposal options retrieved.', {
        methods: METHODS,
        conditions: CONDITIONS
    }));
}

async function getStats(req, res) {
    const counts = await disposalModel.getStatusCounts();
    return res.json(successResponse('Disposal workflow counts retrieved.', {
        pendingApproval: counts['Pending Approval'] || 0,
        approved: counts.Approved || 0,
        rejected: counts.Rejected || 0,
        completed: counts.Completed || 0
    }));
}

async function list(req, res) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, MAX_LIMIT));
    const { rows, total } = await disposalModel.findAll({
        limit,
        offset: (page - 1) * limit
    });
    return res.json(successResponse('Disposal records retrieved.', {
        items: rows,
        pagination: {
            total,
            page,
            limit,
            total_pages: Math.max(1, Math.ceil(total / limit))
        }
    }));
}

async function getById(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid disposal id is required.'));
    const record = await disposalModel.findById(id);
    if (!record) return res.status(404).json(errorResponse('Disposal record not found.'));
    return res.json(successResponse('Disposal record retrieved.', record));
}

async function create(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const assetId = parseId(body.asset_id);
    const reason = String(body.reason || '').trim();
    const method = String(body.disposal_method || '').trim();
    const disposalDate = String(body.requested_disposal_date || '').trim();
    const condition = String(body.final_condition || '').trim();
    const dataDestroyed = body.data_destroyed === true || body.data_destroyed === 1 || body.data_destroyed === 'true';
    const dataDestroyedAt = body.data_destroyed_at ? String(body.data_destroyed_at).trim() : '';
    const errors = [];

    if (!assetId) errors.push({ field: 'asset_id', message: 'A valid asset id is required.' });
    if (!reason || reason.length > 1000) errors.push({ field: 'reason', message: 'Provide a reason of at most 1000 characters.' });
    if (!METHODS.includes(method)) errors.push({ field: 'disposal_method', message: `Choose one of: ${METHODS.join(', ')}.` });
    if (!validDate(disposalDate)) errors.push({ field: 'requested_disposal_date', message: 'Enter a valid YYYY-MM-DD date.' });
    if (!CONDITIONS.includes(condition)) errors.push({ field: 'final_condition', message: `Choose one of: ${CONDITIONS.join(', ')}.` });
    if (body.approval_reference && String(body.approval_reference).trim().length > 100) {
        errors.push({ field: 'approval_reference', message: 'Approval reference must be 100 characters or fewer.' });
    }
    if (body.data_destruction_reference && String(body.data_destruction_reference).trim().length > 100) {
        errors.push({ field: 'data_destruction_reference', message: 'Data destruction reference must be 100 characters or fewer.' });
    }
    if (body.notes && String(body.notes).trim().length > 2000) {
        errors.push({ field: 'notes', message: 'Notes must be 2000 characters or fewer.' });
    }
    if (dataDestroyed && dataDestroyedAt && !validDate(dataDestroyedAt)) {
        errors.push({ field: 'data_destroyed_at', message: 'Enter a valid YYYY-MM-DD date.' });
    }
    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const asset = await assetModel.findById(assetId);
    if (!asset) return res.status(404).json(errorResponse('Asset not found.'));
    if (['Disposed', 'Retired'].includes(asset.status)) {
        return res.status(409).json(errorResponse(`Asset ${asset.asset_tag} is already ${asset.status}.`));
    }
    if (asset.status === 'Under Repair') {
        return res.status(409).json(errorResponse('An asset under repair cannot be submitted for disposal.'));
    }

    const record = await disposalModel.create({
        asset_id: assetId,
        reason,
        disposal_method: method,
        requested_disposal_date: disposalDate,
        approval_reference: String(body.approval_reference || '').trim(),
        final_condition: condition,
        data_destroyed: dataDestroyed,
        data_destroyed_at: dataDestroyedAt || null,
        data_destruction_reference: String(body.data_destruction_reference || '').trim(),
        notes: String(body.notes || '').trim(),
        requested_by: req.user.id
    });
    if (!record) {
        return res.status(409).json(errorResponse(
            'This asset is no longer eligible for disposal or already has an open request.'
        ));
    }
    await auditLog({
        userId: req.user.id,
        action: 'REQUEST_DISPOSAL',
        tableName: 'asset_disposals',
        recordId: record.id,
        newValues: record,
        ipAddress: getClientIp(req)
    });
    return res.status(201).json(successResponse('Disposal request submitted for approval.', record));
}

async function approve(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid disposal id is required.'));
    const record = await disposalModel.findById(id);
    if (!record) return res.status(404).json(errorResponse('Disposal record not found.'));
    if (record.status !== 'Pending Approval') {
        return res.status(409).json(errorResponse('Only pending disposal requests can be approved.'));
    }
    if (Number(record.requested_by) === Number(req.user.id)) {
        return res.status(403).json(errorResponse('A disposal request must be approved by a different user.'));
    }
    const updated = await disposalModel.approve(id, req.user.id);
    if (!updated) return res.status(409).json(errorResponse('The disposal request has already changed.'));
    await auditLog({
        userId: req.user.id,
        action: 'APPROVE_DISPOSAL',
        tableName: 'asset_disposals',
        recordId: id,
        oldValues: { status: record.status },
        newValues: { status: 'Approved' },
        ipAddress: getClientIp(req)
    });
    return res.json(successResponse('Disposal request approved.', await disposalModel.findById(id)));
}

async function reject(req, res) {
    const id = parseId(req.params.id);
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!id) return res.status(400).json(errorResponse('A valid disposal id is required.'));
    if (!reason || reason.length > 1000) {
        return res.status(400).json(errorResponse('A rejection reason of at most 1000 characters is required.'));
    }
    const record = await disposalModel.findById(id);
    if (!record) return res.status(404).json(errorResponse('Disposal record not found.'));
    if (record.status !== 'Pending Approval') {
        return res.status(409).json(errorResponse('Only pending disposal requests can be rejected.'));
    }
    if (Number(record.requested_by) === Number(req.user.id)) {
        return res.status(403).json(errorResponse('A disposal request must be rejected by a different user.'));
    }
    const updated = await disposalModel.reject(id, req.user.id, reason);
    if (!updated) return res.status(409).json(errorResponse('The disposal request has already changed.'));
    await auditLog({
        userId: req.user.id,
        action: 'REJECT_DISPOSAL',
        tableName: 'asset_disposals',
        recordId: id,
        oldValues: { status: record.status },
        newValues: { status: 'Rejected', rejection_reason: reason },
        ipAddress: getClientIp(req)
    });
    return res.json(successResponse('Disposal request rejected.', await disposalModel.findById(id)));
}

async function complete(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid disposal id is required.'));
    const record = await disposalModel.findById(id);
    if (!record) return res.status(404).json(errorResponse('Disposal record not found.'));
    if (record.status !== 'Approved') {
        return res.status(409).json(errorResponse('Only approved disposal requests can be completed.'));
    }
    const completed = await disposalModel.complete(id, req.user.id);
    if (!completed) return res.status(409).json(errorResponse('The asset or disposal record has already changed.'));
    const updated = await disposalModel.findById(id);
    await auditLog({
        userId: req.user.id,
        action: 'COMPLETE_DISPOSAL',
        tableName: 'asset_disposals',
        recordId: id,
        oldValues: { status: record.status, asset_status: record.asset_status },
        newValues: { status: updated.status, asset_status: updated.asset_status },
        ipAddress: getClientIp(req)
    });
    return res.json(successResponse('Asset disposal completed and recorded.', updated));
}

module.exports = { METHODS, CONDITIONS, getMeta, getStats, list, getById, create, approve, reject, complete };