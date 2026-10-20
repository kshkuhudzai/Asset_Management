'use strict';

const referenceDataModel = require('../models/referenceDataModel');
const { auditLog } = require('../middleware/auditMiddleware');
const { getClientIp, successResponse, errorResponse } = require('../utils/helpers');

const TYPES = Object.freeze({
    departments: 'departments',
    locations: 'locations'
});

function parseId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getType(value) {
    return Object.prototype.hasOwnProperty.call(TYPES, value) ? TYPES[value] : null;
}

async function list(req, res) {
    const includeInactive = req.user.role === 'System Administrator' || req.user.role === 'HISO';
    const [departments, locations] = await Promise.all([
        referenceDataModel.list('departments', includeInactive),
        referenceDataModel.list('locations', includeInactive)
    ]);
    return res.json(successResponse('Reference data loaded.', { departments, locations }));
}

async function create(req, res) {
    const type = getType(req.params.type);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!type) return res.status(404).json(errorResponse('Reference data type not found.'));
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
        return res.status(400).json(errorResponse('Name must contain 1 to 100 printable characters.'));
    }

    let record;
    try {
        record = await referenceDataModel.create(type, name);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json(errorResponse('That name already exists for this reference type.'));
        }
        throw error;
    }
    await auditLog({
        userId: req.user.id,
        action: 'CREATE',
        tableName: type,
        recordId: record.id,
        newValues: { name: record.name, is_active: true },
        ipAddress: getClientIp(req)
    });
    return res.status(201).json(successResponse('Reference value created.', record));
}

async function setStatus(req, res) {
    const type = getType(req.params.type);
    const id = parseId(req.params.id);
    if (!type) return res.status(404).json(errorResponse('Reference data type not found.'));
    if (!id) return res.status(400).json(errorResponse('A valid reference value ID is required.'));
    if (typeof req.body.is_active !== 'boolean') {
        return res.status(400).json(errorResponse('is_active must be true or false.'));
    }

    const existing = await referenceDataModel.findById(type, id);
    if (!existing) return res.status(404).json(errorResponse('Reference value not found.'));
    await referenceDataModel.setActive(type, id, req.body.is_active);
    const updated = Object.assign({}, existing, { is_active: req.body.is_active ? 1 : 0 });
    await auditLog({
        userId: req.user.id,
        action: req.body.is_active ? 'ACTIVATE' : 'DEACTIVATE',
        tableName: type,
        recordId: id,
        oldValues: { name: existing.name, is_active: existing.is_active },
        newValues: { name: updated.name, is_active: updated.is_active },
        ipAddress: getClientIp(req)
    });
    return res.json(successResponse('Reference value status updated.', updated));
}

module.exports = { list, create, setStatus };
