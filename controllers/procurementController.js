'use strict';

const crypto = require('crypto');
const procurementModel = require('../models/procurementModel');
const assetModel = require('../models/assetModel');
const assetController = require('./assetController');
const { getClientIp, successResponse, errorResponse } = require('../utils/helpers');

const MAX_LINES = 100;
const MAX_QUANTITY = 1000000;
const RECEIPT_FIELDS = new Set([
    'receipt_reference', 'supplier', 'purchase_order', 'received_date', 'notes', 'lines'
]);
const ASSET_FIELDS = new Set([
    'asset_tag', 'asset_id', 'serial_number', 'category_id', 'category_name',
    'manufacturer', 'model', 'purchase_date', 'purchase_cost', 'supplier',
    'po_invoice_ref', 'warranty_provider', 'warranty_start', 'warranty_end',
    'warranty_ref', 'location', 'department', 'assigned_user_id',
    'responsible_officer', 'status', 'condition_status', 'last_inspection_date',
    'qr_code_value'
]);
const CONSUMABLE_FIELDS = new Set([
    'type', 'stock_item_id', 'item_name', 'part_code', 'category', 'unit_of_measure',
    'store_location', 'bin_location', 'department', 'quantity', 'unit_cost',
    'minimum_level', 'maximum_level', 'currency', 'supplier', 'supplier_contact',
    'remarks'
]);

function addError(errors, field, message) {
    errors.push({ field, message });
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkFields(value, allowed, field, errors) {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) addError(errors, `${field}${field ? '.' : ''}${key}`, 'Unknown field.');
    }
}

function text(value, field, max, errors, { required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) addError(errors, field, `${field} is required.`);
        return null;
    }
    if (typeof value !== 'string') {
        addError(errors, field, `${field} must be a string.`);
        return null;
    }
    const normal = value.trim();
    if (required && !normal) addError(errors, field, `${field} is required.`);
    if (normal.length > max) addError(errors, field, `${field} must be ${max} characters or fewer.`);
    return normal || null;
}

function positiveInt(value, field, errors, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = typeof value === 'number'
        ? value
        : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
        addError(errors, field, `${field} must be a positive whole number no greater than ${maximum}.`);
        return null;
    }
    return parsed;
}

function nonNegativeInt(value, field, errors, maximum = Number.MAX_SAFE_INTEGER) {
    const parsed = typeof value === 'number'
        ? value
        : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
        addError(errors, field, `${field} must be a whole number between 0 and ${maximum}.`);
        return null;
    }
    return parsed;
}

function money(value, field, errors, { optional = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (!optional) addError(errors, field, `${field} is required.`);
        return optional ? 0 : null;
    }
    if (
        (typeof value !== 'number' && typeof value !== 'string') ||
        !/^\d{1,13}(?:\.\d{1,2})?$/.test(String(value).trim())
    ) {
        addError(errors, field, `${field} must be a non-negative amount with at most two decimal places.`);
        return null;
    }
    const result = Number(value);
    if (!Number.isFinite(result) || result > 9999999999999.99) {
        addError(errors, field, `${field} is too large.`);
        return null;
    }
    return Number(result.toFixed(2));
}

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

function today() {
    const date = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function validateAsset(raw, lineNumber, receipt, errors) {
    if (!isObject(raw)) {
        addError(errors, `lines[${lineNumber}].asset`, 'asset must be an object.');
        return null;
    }
    checkFields(raw, ASSET_FIELDS, `lines[${lineNumber}].asset`, errors);

    const asset = { ...raw };
    if (asset.supplier === undefined && receipt.supplier) asset.supplier = receipt.supplier;
    if (asset.po_invoice_ref === undefined) {
        asset.po_invoice_ref = receipt.receiptReference || receipt.purchaseOrder || undefined;
    }
    if (asset.status !== undefined && asset.status !== 'In Stock') {
        addError(errors, `lines[${lineNumber}].asset.status`, 'Newly received assets must have status In Stock.');
    }
    if (asset.assigned_user_id !== undefined && asset.assigned_user_id !== null && asset.assigned_user_id !== '') {
        addError(errors, `lines[${lineNumber}].asset.assigned_user_id`, 'A received asset cannot be assigned during receiving.');
    }
    if (asset.purchase_cost !== undefined && asset.purchase_cost !== null && asset.purchase_cost !== '') {
        asset.purchase_cost = money(
            asset.purchase_cost,
            `lines[${lineNumber}].asset.purchase_cost`,
            errors,
            { optional: false }
        );
    }

    let category = null;
    if (asset.category_id !== undefined && asset.category_id !== null && asset.category_id !== '') {
        if (!/^\d+$/.test(String(asset.category_id)) || Number(asset.category_id) <= 0) {
            addError(errors, `lines[${lineNumber}].asset.category_id`, 'category_id must be a positive integer.');
        } else {
            category = await assetModel.findCategoryById(Number(asset.category_id));
            if (!category) {
                addError(errors, `lines[${lineNumber}].asset.category_id`, 'The selected asset category does not exist.');
            }
        }
    } else if (asset.category_name !== undefined) {
        if (typeof asset.category_name !== 'string' || !asset.category_name.trim()) {
            addError(errors, `lines[${lineNumber}].asset.category_name`, 'category_name must name an existing category.');
        } else {
            category = await assetModel.findCategoryByName(asset.category_name.trim());
            if (!category) {
                addError(errors, `lines[${lineNumber}].asset.category_name`, 'The supplied asset category does not exist.');
            }
        }
    }

    const { errors: assetErrors, data } = assetController.validateAssetPayload(asset, {
        isCreate: true,
        category
    });
    for (const entry of assetErrors) {
        addError(errors, `lines[${lineNumber}].asset.${entry.field}`, entry.message);
    }
    if (data.purchaseCost === undefined) data.purchaseCost = 0;
    if (data.assignedUserId === undefined) data.assignedUserId = null;
    if (data.status === undefined) data.status = 'In Stock';
    if (data.conditionStatus === undefined) data.conditionStatus = 'Good';
    if (data.categoryId === undefined) data.categoryId = category ? category.id : null;
    data.categoryName = category ? category.name : null;
    return data;
}

async function normalizeReceipt(body) {
    const errors = [];
    if (!isObject(body)) {
        return { errors: [{ field: 'body', message: 'Request body must be an object.' }] };
    }
    checkFields(body, RECEIPT_FIELDS, '', errors);
    const receipt = {
        receiptReference: text(body.receipt_reference, 'receipt_reference', 100, errors),
        supplier: text(body.supplier, 'supplier', 150, errors),
        purchaseOrder: text(body.purchase_order, 'purchase_order', 100, errors),
        receivedDate: body.received_date === undefined
            ? today()
            : body.received_date,
        notes: text(body.notes, 'notes', 2000, errors)
    };
    if (!validDate(receipt.receivedDate)) {
        addError(errors, 'received_date', 'received_date must be a real date in YYYY-MM-DD format.');
    }
    if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > MAX_LINES) {
        addError(errors, 'lines', `lines must contain between 1 and ${MAX_LINES} entries.`);
    }
    const rawLines = Array.isArray(body.lines) ? body.lines : [];
    receipt.lines = [];
    for (let index = 0; index < rawLines.length && index < MAX_LINES; index += 1) {
        const raw = rawLines[index];
        if (!isObject(raw)) {
            addError(errors, `lines[${index}]`, 'Each receipt line must be an object.');
            continue;
        }
        if (raw.type === 'serialized') {
            checkFields(raw, new Set(['type', 'asset']), `lines[${index}]`, errors);
            const asset = await validateAsset(raw.asset, index, receipt, errors);
            receipt.lines.push({ type: 'serialized', asset });
            continue;
        }
        if (raw.type !== 'consumable') {
            addError(errors, `lines[${index}].type`, 'type must be serialized or consumable.');
            continue;
        }
        checkFields(raw, CONSUMABLE_FIELDS, `lines[${index}]`, errors);
        const line = {
            type: 'consumable',
            stockItemId: raw.stock_item_id === undefined || raw.stock_item_id === null || raw.stock_item_id === ''
                ? null
                : positiveInt(raw.stock_item_id, `lines[${index}].stock_item_id`, errors),
            itemName: text(raw.item_name, `lines[${index}].item_name`, 150, errors, {
                required: raw.stock_item_id === undefined || raw.stock_item_id === null || raw.stock_item_id === ''
            }),
            partCode: text(raw.part_code, `lines[${index}].part_code`, 100, errors),
            category: text(raw.category, `lines[${index}].category`, 100, errors),
            unitOfMeasure: text(raw.unit_of_measure, `lines[${index}].unit_of_measure`, 30, errors) || 'Unit',
            storeLocation: text(raw.store_location, `lines[${index}].store_location`, 100, errors),
            binLocation: text(raw.bin_location, `lines[${index}].bin_location`, 50, errors),
            department: text(raw.department, `lines[${index}].department`, 100, errors),
            quantity: positiveInt(raw.quantity, `lines[${index}].quantity`, errors, MAX_QUANTITY),
            unitCost: money(raw.unit_cost, `lines[${index}].unit_cost`, errors),
            minimumLevel: raw.minimum_level === undefined || raw.minimum_level === null || raw.minimum_level === ''
                ? 0
                : nonNegativeInt(raw.minimum_level, `lines[${index}].minimum_level`, errors, MAX_QUANTITY),
            maximumLevel: raw.maximum_level === undefined || raw.maximum_level === null || raw.maximum_level === ''
                ? null
                : nonNegativeInt(raw.maximum_level, `lines[${index}].maximum_level`, errors, MAX_QUANTITY),
            currency: (text(raw.currency, `lines[${index}].currency`, 10, errors) || 'USD').toUpperCase(),
            supplier: text(raw.supplier, `lines[${index}].supplier`, 150, errors) || receipt.supplier,
            supplierContact: text(raw.supplier_contact, `lines[${index}].supplier_contact`, 100, errors),
            remarks: text(raw.remarks, `lines[${index}].remarks`, 1000, errors)
        };
        if (line.currency && !/^[A-Za-z]{3,10}$/.test(line.currency)) {
            addError(errors, `lines[${index}].currency`, 'currency must contain 3-10 letters.');
        }
        if (line.maximumLevel !== null && line.maximumLevel < line.minimumLevel) {
            addError(errors, `lines[${index}].maximum_level`, 'maximum_level cannot be below minimum_level.');
        }
        if (line.quantity && line.unitCost !== null &&
            line.quantity * line.unitCost > 9999999999999.99) {
            addError(errors, `lines[${index}].unit_cost`, 'The line total is too large.');
        }
        receipt.lines.push(line);
    }
    return { errors, receipt };
}

async function listReceipts(req, res) {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? 25 : Number(req.query.limit);
    if (!Number.isSafeInteger(page) || page < 1 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger((page - 1) * limit)) {
        return res.status(400).json(errorResponse('page and limit must be positive integers; limit cannot exceed 100.'));
    }
    const result = await procurementModel.findAll({ limit, offset: (page - 1) * limit });
    return res.status(200).json(successResponse('Procurement receipts retrieved successfully.', {
        ...result,
        page,
        limit
    }));
}

async function getReceipt(req, res) {
    const receipt = await procurementModel.findByKey(req.params.id);
    if (!receipt) return res.status(404).json(errorResponse('Procurement receipt not found.'));
    return res.status(200).json(successResponse('Procurement receipt retrieved successfully.', { receipt }));
}

async function receive(req, res) {
    const { errors, receipt } = await normalizeReceipt(req.body);
    if (errors.length) return res.status(400).json(errorResponse('Validation failed.', errors));

    const providedKey = req.get('Idempotency-Key');
    const rawKey = providedKey || (receipt.receiptReference ? `reference:${receipt.receiptReference}` : '');
    if (!rawKey || rawKey.length > 150 || !/^[\x21-\x7E]+$/.test(rawKey)) {
        return res.status(400).json(errorResponse(
            'Provide an Idempotency-Key header (1-150 printable ASCII characters) or receipt_reference.'
        ));
    }
    const idempotencyKey = providedKey
        ? `key:${crypto.createHash('sha256').update(rawKey).digest('hex')}`
        : `reference:${receipt.receiptReference}`;
    const hashPayload = {
        ...receipt,
        receivedDate: req.body.received_date === undefined ? null : receipt.receivedDate
    };
    const requestHash = crypto.createHash('sha256')
        .update(JSON.stringify(hashPayload))
        .digest('hex');

    try {
        const result = await procurementModel.receive({
            idempotencyKey,
            requestHash,
            receipt,
            userId: req.user.id,
            ipAddress: getClientIp(req)
        });
        return res.status(result.replayed ? 200 : 201).json(
            successResponse(
                result.replayed ? 'This procurement receipt was already recorded.' : 'Procurement receipt recorded successfully.',
                { ...result, idempotent_replay: result.replayed }
            )
        );
    } catch (error) {
        if (error.status) return res.status(error.status).json(errorResponse(error.message));
        throw error;
    }
}

module.exports = { listReceipts, getReceipt, receive, normalizeReceipt };
