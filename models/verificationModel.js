'use strict';

const db = require('../config/db');

const EXERCISE_DDL = `
    CREATE TABLE IF NOT EXISTS asset_verifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        verification_ref VARCHAR(50) UNIQUE,
        name VARCHAR(150) NOT NULL,
        department VARCHAR(100),
        location VARCHAR(100),
        category_id INT NULL,
        status ENUM('In Progress', 'Completed', 'Cancelled') NOT NULL DEFAULT 'In Progress',
        notes TEXT,
        created_by INT NULL,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES asset_categories(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_verification_status (status),
        INDEX idx_verification_started (started_at)
    )
`;

const ITEM_DDL = `
    CREATE TABLE IF NOT EXISTS asset_verification_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        verification_id INT NOT NULL,
        asset_id INT NOT NULL,
        result ENUM('Pending', 'Verified', 'Missing', 'Damaged', 'Incorrect Location')
            NOT NULL DEFAULT 'Pending',
        actual_location VARCHAR(100),
        notes TEXT,
        verified_by INT NULL,
        verified_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_verification_asset (verification_id, asset_id),
        FOREIGN KEY (verification_id) REFERENCES asset_verifications(id) ON DELETE CASCADE,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_verification_item_result (result)
    )
`;

async function ensureTables() {
    await db.query(EXERCISE_DDL);
    await db.query(ITEM_DDL);
}

async function findAll({ limit = 25, offset = 0 } = {}) {
    const [rows] = await db.query(
        `SELECT v.*, u.full_name AS created_by_name,
                COUNT(i.id) AS total_assets,
                SUM(CASE WHEN i.result <> 'Pending' THEN 1 ELSE 0 END) AS checked_assets,
                SUM(CASE WHEN i.result IN ('Missing', 'Damaged', 'Incorrect Location')
                         THEN 1 ELSE 0 END) AS exceptions
           FROM asset_verifications v
           LEFT JOIN users u ON u.id = v.created_by
           LEFT JOIN asset_verification_items i ON i.verification_id = v.id
          GROUP BY v.id
          ORDER BY v.id DESC
          LIMIT ? OFFSET ?`,
        [limit, offset]
    );
    const [[count]] = await db.query('SELECT COUNT(*) AS total FROM asset_verifications');
    return { rows, total: Number(count.total) || 0 };
}

async function create({ name, department, location, category_id, notes, created_by }) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();

        const filters = [
            "a.status NOT IN ('Disposed', 'Retired')"
        ];
        const params = [];
        if (department) {
            filters.push('a.department = ?');
            params.push(department);
        }
        if (location) {
            filters.push('a.location = ?');
            params.push(location);
        }
        if (category_id) {
            filters.push('a.category_id = ?');
            params.push(category_id);
        }

        const [assets] = await connection.query(
            `SELECT a.id FROM assets a WHERE ${filters.join(' AND ')} ORDER BY a.id`,
            params
        );
        if (!assets.length) {
            await connection.rollback();
            return null;
        }

        const [insert] = await connection.query(
            `INSERT INTO asset_verifications (name, department, location, category_id, notes, created_by)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [name, department || null, location || null, category_id || null, notes || null, created_by]
        );
        const id = insert.insertId;
        const ref = `VER-${String(id).padStart(6, '0')}`;
        await connection.query(
            'UPDATE asset_verifications SET verification_ref = ? WHERE id = ?',
            [ref, id]
        );
        await connection.query(
            `INSERT INTO asset_verification_items (verification_id, asset_id)
             VALUES ?`,
            [assets.map((asset) => [id, asset.id])]
        );
        await connection.commit();
        return { id, verification_ref: ref, total_assets: assets.length };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function findById(id) {
    const [rows] = await db.query(
        `SELECT v.*, u.full_name AS created_by_name,
                COUNT(i.id) AS total_assets,
                SUM(CASE WHEN i.result <> 'Pending' THEN 1 ELSE 0 END) AS checked_assets,
                SUM(CASE WHEN i.result IN ('Missing', 'Damaged', 'Incorrect Location')
                         THEN 1 ELSE 0 END) AS exceptions
           FROM asset_verifications v
           LEFT JOIN users u ON u.id = v.created_by
           LEFT JOIN asset_verification_items i ON i.verification_id = v.id
          WHERE v.id = ?
          GROUP BY v.id
          LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

async function findItems(verificationId, { exceptionsOnly = false } = {}) {
    const filter = exceptionsOnly
        ? "AND i.result IN ('Missing', 'Damaged', 'Incorrect Location')"
        : '';
    const [rows] = await db.query(
        `SELECT i.*, a.asset_id AS asset_code, a.asset_tag, a.serial_number,
                a.manufacturer, a.model, a.department, a.location AS expected_location,
                a.status AS asset_status, c.name AS category_name,
                u.full_name AS verified_by_name
           FROM asset_verification_items i
           JOIN assets a ON a.id = i.asset_id
           LEFT JOIN asset_categories c ON c.id = a.category_id
           LEFT JOIN users u ON u.id = i.verified_by
          WHERE i.verification_id = ? ${filter}
          ORDER BY a.asset_tag`,
        [verificationId]
    );
    return rows;
}

async function updateItem(verificationId, itemId, data) {
    const [result] = await db.query(
        `UPDATE asset_verification_items i
         JOIN asset_verifications v ON v.id = i.verification_id
            SET i.result = ?, i.actual_location = ?, i.notes = ?,
                i.verified_by = ?, i.verified_at = NOW()
          WHERE i.id = ? AND i.verification_id = ? AND v.status = 'In Progress'`,
        [
            data.result,
            data.actual_location || null,
            data.notes || null,
            data.verified_by,
            itemId,
            verificationId
        ]
    );
    return result.affectedRows;
}

async function complete(id) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [pending] = await connection.query(
            `SELECT COUNT(*) AS total
               FROM asset_verification_items
              WHERE verification_id = ? AND result = 'Pending'`,
            [id]
        );
        if (Number(pending[0].total) > 0) {
            await connection.rollback();
            return { pending: Number(pending[0].total) };
        }
        const [result] = await connection.query(
            `UPDATE asset_verifications
                SET status = 'Completed', completed_at = NOW()
              WHERE id = ? AND status = 'In Progress'`,
            [id]
        );
        await connection.commit();
        return { completed: result.affectedRows > 0 };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    EXERCISE_DDL,
    ITEM_DDL,
    ensureTables,
    findAll,
    create,
    findById,
    findItems,
    updateItem,
    complete
};
