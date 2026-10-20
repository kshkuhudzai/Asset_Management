'use strict';

const db = require('../config/db');
const verificationModel = require('../models/verificationModel');
const { auditLog } = require('../middleware/auditMiddleware');
const { getClientIp, successResponse, errorResponse } = require('../utils/helpers');

const RESULTS = Object.freeze([
    'Pending',
    'Verified',
    'Missing',
    'Damaged',
    'Incorrect Location'
]);
const MAX_LIMIT = 200;

function parseId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

async function getMeta(req, res) {
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
    return res.json(successResponse('Verification reference data retrieved.', {
        results: RESULTS,
        categories,
        departments: departments.map((row) => row.department),
        locations: locations.map((row) => row.location)
    }));
}

async function list(req, res) {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, MAX_LIMIT));
    const { rows, total } = await verificationModel.findAll({
        limit,
        offset: (page - 1) * limit
    });
    return res.json(successResponse('Verification exercises retrieved.', {
        items: rows,
        pagination: {
            total,
            page,
            limit,
            total_pages: Math.max(1, Math.ceil(total / limit))
        }
    }));
}

async function create(req, res) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = String(body.name || '').trim();
    const errors = [];
    if (!name) errors.push({ field: 'name', message: 'Exercise name is required.' });
    if (name.length > 150) errors.push({ field: 'name', message: 'Name must be 150 characters or fewer.' });

    for (const field of ['department', 'location', 'notes']) {
        if (body[field] !== undefined && String(body[field]).trim().length > (field === 'notes' ? 2000 : 100)) {
            errors.push({ field, message: `${field} is too long.` });
        }
    }
    const categoryId = body.category_id ? parseId(body.category_id) : null;
    if (body.category_id && !categoryId) {
        errors.push({ field: 'category_id', message: 'Select a valid asset category.' });
    }
    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const exercise = await verificationModel.create({
        name,
        department: String(body.department || '').trim(),
        location: String(body.location || '').trim(),
        category_id: categoryId,
        notes: String(body.notes || '').trim(),
        created_by: req.user.id
    });
    if (!exercise) {
        return res.status(400).json(errorResponse('No active assets matched these filters.'));
    }
    await auditLog({
        userId: req.user.id,
        action: 'CREATE',
        tableName: 'asset_verifications',
        recordId: exercise.id,
        newValues: { ...exercise, name },
        ipAddress: getClientIp(req)
    });
    const created = await verificationModel.findById(exercise.id);
    return res.status(201).json(successResponse('Verification exercise created.', created));
}

async function getById(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid verification id is required.'));
    const exercise = await verificationModel.findById(id);
    if (!exercise) return res.status(404).json(errorResponse('Verification exercise not found.'));
    const items = await verificationModel.findItems(id);
    return res.json(successResponse('Verification exercise retrieved.', { ...exercise, items }));
}

async function getExceptions(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid verification id is required.'));
    const exercise = await verificationModel.findById(id);
    if (!exercise) return res.status(404).json(errorResponse('Verification exercise not found.'));
    const items = await verificationModel.findItems(id, { exceptionsOnly: true });
    return res.json(successResponse('Verification exceptions retrieved.', {
        verification: exercise,
        items,
        total: items.length
    }));
}

async function updateItem(req, res) {
    const id = parseId(req.params.id);
    const itemId = parseId(req.params.itemId);
    if (!id || !itemId) {
        return res.status(400).json(errorResponse('Valid verification and item ids are required.'));
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = String(body.result || '').trim();
    const errors = [];
    if (!RESULTS.includes(result) || result === 'Pending') {
        errors.push({ field: 'result', message: `Result must be one of: ${RESULTS.slice(1).join(', ')}.` });
    }
    const actualLocation = String(body.actual_location || '').trim();
    const notes = String(body.notes || '').trim();
    if (actualLocation.length > 100) {
        errors.push({ field: 'actual_location', message: 'Actual location must be 100 characters or fewer.' });
    }
    if (notes.length > 2000) {
        errors.push({ field: 'notes', message: 'Notes must be 2000 characters or fewer.' });
    }
    if (errors.length) {
        return res.status(400).json(errorResponse('Please correct the highlighted fields.', errors));
    }

    const updated = await verificationModel.updateItem(id, itemId, {
        result,
        actual_location: actualLocation,
        notes,
        verified_by: req.user.id
    });
    if (!updated) {
        return res.status(404).json(errorResponse('An open verification item was not found.'));
    }
    await auditLog({
        userId: req.user.id,
        action: 'UPDATE',
        tableName: 'asset_verification_items',
        recordId: itemId,
        newValues: { verification_id: id, result, actual_location: actualLocation, notes },
        ipAddress: getClientIp(req)
    });
    const items = await verificationModel.findItems(id);
    return res.json(successResponse('Verification result recorded.', items.find((item) => Number(item.id) === itemId)));
}

async function complete(req, res) {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json(errorResponse('A valid verification id is required.'));
    const exercise = await verificationModel.findById(id);
    if (!exercise) return res.status(404).json(errorResponse('Verification exercise not found.'));
    if (exercise.status !== 'In Progress') {
        return res.status(409).json(errorResponse('Only an in-progress exercise can be completed.'));
    }
    const outcome = await verificationModel.complete(id);
    if (outcome.pending) {
        return res.status(409).json(errorResponse(
            `Record a result for all assets before completing. ${outcome.pending} remain pending.`
        ));
    }
    if (!outcome.completed) {
        return res.status(409).json(errorResponse('Verification exercise could not be completed.'));
    }
    await auditLog({
        userId: req.user.id,
        action: 'COMPLETE',
        tableName: 'asset_verifications',
        recordId: id,
        oldValues: { status: exercise.status },
        newValues: { status: 'Completed' },
        ipAddress: getClientIp(req)
    });
    return res.json(successResponse('Verification exercise completed.', await verificationModel.findById(id)));
}

module.exports = { RESULTS, getMeta, list, create, getById, getExceptions, updateItem, complete };