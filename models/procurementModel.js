'use strict';

const db = require('../config/db');
const stockModel = require('./stockModel');
const assetModel = require('./assetModel');
const assetController = require('../controllers/assetController');

const RECEIPT_DDL = `
    CREATE TABLE IF NOT EXISTS procurement_receipts (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        idempotency_key VARCHAR(150) NOT NULL UNIQUE,
        request_hash CHAR(64) NOT NULL,
        receipt_reference VARCHAR(100) NULL UNIQUE,
        supplier VARCHAR(150) NULL,
        purchase_order VARCHAR(100) NULL,
        received_date DATE NOT NULL,
        notes TEXT NULL,
        received_by INT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL,
        CHECK (idempotency_key <> ''),
        INDEX idx_procurement_receipts_created (created_at)
    )
`;

const LINE_DDL = `
    CREATE TABLE IF NOT EXISTS procurement_receipt_lines (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        receipt_id BIGINT UNSIGNED NOT NULL,
        line_number INT NOT NULL,
        line_type ENUM('Serialized Asset', 'Consumable') NOT NULL,
        item_name VARCHAR(150) NOT NULL,
        quantity INT NOT NULL,
        unit_cost DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
        total_cost DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
        asset_id INT NULL,
        stock_item_id INT NULL,
        stock_movement_id INT NULL,
        details JSON NULL,
        UNIQUE KEY uq_procurement_receipt_line (receipt_id, line_number),
        CHECK (line_number > 0),
        CHECK (quantity > 0 AND quantity <= 1000000),
        CHECK (unit_cost >= 0),
        CHECK (total_cost >= 0),
        CHECK (
            (line_type = 'Serialized Asset' AND quantity = 1
                AND stock_item_id IS NULL AND stock_movement_id IS NULL)
            OR
            (line_type = 'Consumable' AND asset_id IS NULL)
        ),
        FOREIGN KEY (receipt_id) REFERENCES procurement_receipts(id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
        FOREIGN KEY (stock_item_id) REFERENCES stock_items(id) ON DELETE SET NULL,
        FOREIGN KEY (stock_movement_id) REFERENCES stock_movements(id) ON DELETE SET NULL,
        INDEX idx_procurement_lines_asset (asset_id),
        INDEX idx_procurement_lines_item (stock_item_id)
    )
`;

let ensurePromise = null;

async function ensureTable() {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await stockModel.ensureTable();
            await db.query(RECEIPT_DDL);
            await db.query(LINE_DDL);
        })().catch((error) => {
            ensurePromise = null;
            throw error;
        });
    }
    return ensurePromise;
}

function jsonValue(value) {
    return JSON.stringify(value === undefined ? null : value);
}

async function writeAudit(connection, { userId, action, tableName, recordId, newValues, ipAddress }) {
    await connection.query(
        `INSERT INTO audit_logs
            (user_id, action, table_name, record_id, old_values, new_values, ip_address)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        [userId, action, tableName, Number(recordId) || 0, jsonValue(newValues), ipAddress || null]
    );
}

async function nextAssetId(connection, prefix) {
    const [rows] = await connection.query(
        `SELECT asset_id FROM assets
         WHERE asset_id LIKE ?
         ORDER BY LENGTH(asset_id) DESC, asset_id DESC
         LIMIT 1 FOR UPDATE`,
        [`${prefix}%`]
    );
    const suffix = rows.length ? parseInt(String(rows[0].asset_id).slice(prefix.length), 10) : 0;
    return `${prefix}${String((Number.isFinite(suffix) ? suffix : 0) + 1).padStart(6, '0')}`;
}

async function uniqueQrValue(connection, assetId, assetTag) {
    const base = assetModel.buildQrValue({ assetId, assetTag });
    let value = base;
    for (let attempt = 1; attempt <= 50; attempt += 1) {
        const [rows] = await connection.query(
            'SELECT id FROM assets WHERE qr_code_value = ? LIMIT 1',
            [value]
        );
        if (!rows.length) return value;
        value = `${base}#${attempt}`;
    }
    return `${base}#${Date.now()}`;
}

async function insertAsset(connection, asset, userId, ipAddress) {
    const category = asset.categoryId
        ? { id: asset.categoryId, name: asset.categoryName }
        : null;
    const prefix = assetController.prefixForCategory(category && category.name);
    const assetId = asset.assetId || await nextAssetId(connection, prefix);
    const [conflictRows] = await connection.query(
        `SELECT id FROM assets
         WHERE asset_id = ? OR asset_tag = ? OR (? IS NOT NULL AND serial_number = ?)
         LIMIT 1`,
        [assetId, asset.assetTag, asset.serialNumber || null, asset.serialNumber || null]
    );
    if (conflictRows.length) {
        const error = new Error('An asset ID, asset tag, or serial number is already registered.');
        error.status = 409;
        throw error;
    }

    const qrCodeValue = asset.qrCodeValue ||
        await uniqueQrValue(connection, assetId, asset.assetTag);
    const data = {
        ...asset,
        assetId,
        qrCodeValue,
        status: asset.status || 'In Stock',
        conditionStatus: asset.conditionStatus || 'Good'
    };
    const columns = [
        'asset_id', 'asset_tag', 'serial_number', 'category_id', 'manufacturer', 'model',
        'purchase_date', 'purchase_cost', 'supplier', 'po_invoice_ref', 'warranty_provider',
        'warranty_start', 'warranty_end', 'warranty_ref', 'location', 'department',
        'assigned_user_id', 'responsible_officer', 'status', 'condition_status',
        'last_inspection_date', 'qr_code_value'
    ];
    const values = [
        data.assetId, data.assetTag, data.serialNumber, data.categoryId, data.manufacturer,
        data.model, data.purchaseDate, data.purchaseCost, data.supplier, data.poInvoiceRef,
        data.warrantyProvider, data.warrantyStart, data.warrantyEnd, data.warrantyRef,
        data.location, data.department, data.assignedUserId, data.responsibleOfficer,
        data.status, data.conditionStatus, data.lastInspectionDate, data.qrCodeValue
    ];
    const [result] = await connection.query(
        `INSERT INTO assets (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values
    );
    const [assetRows] = await connection.query(
        `${assetModel.ASSET_SELECT} WHERE a.id = ? LIMIT 1`,
        [result.insertId]
    );
    const created = assetRows[0] || { id: result.insertId, ...data };
    await writeAudit(connection, {
        userId,
        action: 'CREATE',
        tableName: 'assets',
        recordId: result.insertId,
        newValues: created,
        ipAddress
    });
    return created;
}

async function allocateRef(connection, table, column, prefix) {
    const [rows] = await connection.query(
        `SELECT ${column} AS ref FROM ${table}
         WHERE ${column} LIKE ?
         ORDER BY LENGTH(${column}) DESC, ${column} DESC
         LIMIT 1 FOR UPDATE`,
        [`${prefix}%`]
    );
    const highest = rows.length ? parseInt(String(rows[0].ref).slice(prefix.length), 10) : 0;
    return `${prefix}${String((Number.isFinite(highest) ? highest : 0) + 1).padStart(6, '0')}`;
}

async function insertConsumable(connection, line, receipt, userId, ipAddress) {
    let itemId = line.stockItemId || null;
    let item;
    if (itemId) {
        const [rows] = await connection.query(
            'SELECT * FROM stock_items WHERE id = ? FOR UPDATE',
            [itemId]
        );
        if (!rows.length) {
            const error = new Error(`Stock item ${itemId} does not exist.`);
            error.status = 404;
            throw error;
        }
        item = rows[0];
        if (item.asset_id !== null) {
            const error = new Error('Serialized asset store cards cannot receive consumable quantities.');
            error.status = 400;
            throw error;
        }
    } else {
        const itemRef = await allocateRef(connection, 'stock_items', 'item_ref', 'STK-');
        const [result] = await connection.query(
            `INSERT INTO stock_items
                (item_ref, item_name, part_code, category, unit_of_measure, store_location,
                 bin_location, department, quantity_on_hand, minimum_level, maximum_level,
                 unit_cost, currency, supplier, supplier_contact, status, remarks, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'Active', ?, ?)`,
            [
                itemRef, line.itemName, line.partCode, line.category, line.unitOfMeasure,
                line.storeLocation, line.binLocation, line.department, line.minimumLevel,
                line.maximumLevel, line.unitCost, line.currency, line.supplier || receipt.supplier,
                line.supplierContact, line.remarks, userId
            ]
        );
        itemId = result.insertId;
        const [rows] = await connection.query('SELECT * FROM stock_items WHERE id = ?', [itemId]);
        item = rows[0];
        await writeAudit(connection, {
            userId,
            action: 'CREATE',
            tableName: 'stock_items',
            recordId: itemId,
            newValues: item,
            ipAddress
        });
    }

    const balance = Number(item.quantity_on_hand) + line.quantity;
    if (!Number.isSafeInteger(balance) || balance > 2147483647) {
        const error = new Error('The resulting stock balance exceeds the supported limit.');
        error.status = 400;
        throw error;
    }
    const movementRef = await allocateRef(connection, 'stock_movements', 'movement_ref', 'MOV-');
    const totalCost = Math.round(line.quantity * line.unitCost * 100) / 100;
    const [movement] = await connection.query(
        `INSERT INTO stock_movements
            (movement_ref, stock_item_id, movement_type, quantity, balance_after, movement_date,
             reference, reason, counterparty, unit_cost, total_cost, remarks, recorded_by)
         VALUES (?, ?, 'Receipt', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            movementRef, itemId, line.quantity, balance, receipt.receivedDate,
            receipt.receiptReference || receipt.purchaseOrder || null,
            'Procurement receipt', receipt.supplier, line.unitCost, totalCost,
            receipt.notes || null, userId
        ]
    );
    await connection.query('UPDATE stock_items SET quantity_on_hand = ? WHERE id = ?', [
        balance, itemId
    ]);
    await writeAudit(connection, {
        userId,
        action: 'RECEIPT',
        tableName: 'stock_movements',
        recordId: movement.insertId,
        newValues: { movement_ref: movementRef, stock_item_id: itemId, quantity: line.quantity, balance_after: balance },
        ipAddress
    });

    return {
        stockItemId: itemId,
        movementId: movement.insertId,
        movementRef,
        itemName: item.item_name,
        quantity: line.quantity,
        unitCost: line.unitCost,
        totalCost
    };
}

async function getReceiptById(connection, id) {
    const [receipts] = await connection.query(
        `SELECT r.id, r.receipt_reference, r.supplier, r.purchase_order, r.received_date,
                r.notes, r.received_by, u.username AS received_by_username,
                u.full_name AS received_by_name, r.created_at
         FROM procurement_receipts r
         LEFT JOIN users u ON u.id = r.received_by
         WHERE r.id = ? LIMIT 1`,
        [id]
    );
    if (!receipts.length) return null;
    const [lines] = await connection.query(
        `SELECT l.id, l.line_number, l.line_type, l.item_name, l.quantity, l.unit_cost,
                l.total_cost, l.asset_id, l.stock_item_id, l.stock_movement_id, l.details,
                a.asset_id AS asset_code, a.asset_tag, sm.movement_ref
         FROM procurement_receipt_lines l
         LEFT JOIN assets a ON a.id = l.asset_id
         LEFT JOIN stock_movements sm ON sm.id = l.stock_movement_id
         WHERE l.receipt_id = ? ORDER BY l.line_number`,
        [id]
    );
    return { ...receipts[0], lines };
}

async function receive({ idempotencyKey, requestHash, receipt, userId, ipAddress }) {
    await ensureTable();
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [inserted] = await connection.query(
            `INSERT INTO procurement_receipts
                (idempotency_key, request_hash, receipt_reference, supplier, purchase_order,
                 received_date, notes, received_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                idempotencyKey, requestHash, receipt.receiptReference, receipt.supplier,
                receipt.purchaseOrder, receipt.receivedDate, receipt.notes, userId
            ]
        );
        const receiptId = inserted.insertId;
        const createdLines = [];

        for (let index = 0; index < receipt.lines.length; index += 1) {
            const line = receipt.lines[index];
            const lineNumber = index + 1;
            let detail;
            let assetId = null;
            let stockItemId = null;
            let movementId = null;
            let type;

            if (line.type === 'serialized') {
                const asset = await insertAsset(connection, line.asset, userId, ipAddress);
                assetId = asset.id;
                type = 'Serialized Asset';
                detail = {
                    asset_code: asset.asset_id,
                    asset_tag: asset.asset_tag,
                    serial_number: asset.serial_number,
                    category_id: asset.category_id
                };
                createdLines.push({ line_number: lineNumber, type, asset_id: assetId, asset });
            } else {
                const stock = await insertConsumable(connection, line, receipt, userId, ipAddress);
                stockItemId = stock.stockItemId;
                movementId = stock.movementId;
                type = 'Consumable';
                detail = { movement_ref: stock.movementRef, stock_item_id: stockItemId };
                createdLines.push({ line_number: lineNumber, type, ...stock });
            }

            const quantity = line.type === 'serialized' ? 1 : line.quantity;
            const unitCost = line.type === 'serialized'
                ? Number(line.asset.purchaseCost || 0)
                : line.unitCost;
            const itemName = line.type === 'serialized'
                ? ([line.asset.manufacturer, line.asset.model].filter(Boolean).join(' ').slice(0, 150) ||
                    line.asset.assetTag)
                : (line.itemName || createdLines[createdLines.length - 1].itemName);
            await connection.query(
                `INSERT INTO procurement_receipt_lines
                    (receipt_id, line_number, line_type, item_name, quantity, unit_cost,
                     total_cost, asset_id, stock_item_id, stock_movement_id, details)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    receiptId, lineNumber, type, itemName, quantity, unitCost,
                    Math.round(quantity * unitCost * 100) / 100, assetId, stockItemId, movementId,
                    jsonValue(detail)
                ]
            );
        }

        await writeAudit(connection, {
            userId,
            action: 'RECEIVE',
            tableName: 'procurement_receipts',
            recordId: receiptId,
            newValues: {
                receipt_reference: receipt.receiptReference,
                supplier: receipt.supplier,
                purchase_order: receipt.purchaseOrder,
                line_count: createdLines.length,
                lines: createdLines.map((line) => ({
                    line_number: line.line_number,
                    type: line.type,
                    asset_id: line.asset_id || null,
                    stock_item_id: line.stockItemId || null,
                    movement_id: line.movementId || null
                }))
            },
            ipAddress
        });

        await connection.commit();
        return { receipt: await getReceiptById(db, receiptId), replayed: false };
    } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
            const [rows] = await db.query(
                `SELECT id, request_hash FROM procurement_receipts WHERE idempotency_key = ? LIMIT 1`,
                [idempotencyKey]
            );
            if (rows.length) {
                if (rows[0].request_hash !== requestHash) {
                    const conflict = new Error('This idempotency key was already used for a different receipt payload.');
                    conflict.status = 409;
                    throw conflict;
                }
                return { receipt: await getReceiptById(db, rows[0].id), replayed: true };
            }
            const conflict = new Error('The receipt reference or a generated register reference already exists.');
            conflict.status = 409;
            throw conflict;
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function findAll({ limit, offset }) {
    await ensureTable();
    const [rows] = await db.query(
        `SELECT r.id, r.receipt_reference, r.supplier, r.purchase_order, r.received_date,
                r.received_by, u.username AS received_by_username,
                u.full_name AS received_by_name, r.created_at, COUNT(l.id) AS line_count,
                COALESCE(SUM(l.total_cost), 0) AS total_cost
         FROM procurement_receipts r
         LEFT JOIN procurement_receipt_lines l ON l.receipt_id = r.id
         LEFT JOIN users u ON u.id = r.received_by
         GROUP BY r.id
         ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`,
        [limit, offset]
    );
    const [countRows] = await db.query('SELECT COUNT(*) AS total FROM procurement_receipts');
    return { receipts: rows, total: Number(countRows[0].total) };
}

async function findByKey(id) {
    await ensureTable();
    const connection = await db.getConnection();
    try {
        let receiptId = Number.isSafeInteger(Number(id)) && Number(id) > 0
            ? Number(id)
            : null;
        if (receiptId === null) {
            const [rows] = await connection.query(
                'SELECT id FROM procurement_receipts WHERE receipt_reference = ? LIMIT 1',
                [id]
            );
            receiptId = rows.length ? rows[0].id : null;
        }
        return receiptId === null ? null : getReceiptById(connection, receiptId);
    } finally {
        connection.release();
    }
}

module.exports = { ensureTable, receive, findAll, findByKey };
