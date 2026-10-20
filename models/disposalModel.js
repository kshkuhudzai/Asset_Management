'use strict';

const db = require('../config/db');

const TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS asset_disposals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        disposal_ref VARCHAR(50) UNIQUE,
        asset_id INT NOT NULL,
        status ENUM('Pending Approval', 'Approved', 'Rejected', 'Completed')
            NOT NULL DEFAULT 'Pending Approval',
        reason VARCHAR(1000) NOT NULL,
        disposal_method VARCHAR(100) NOT NULL,
        requested_disposal_date DATE NOT NULL,
        approval_reference VARCHAR(100),
        final_condition ENUM('Good', 'Fair', 'Damaged', 'Obsolete') NOT NULL,
        data_destroyed TINYINT(1) NOT NULL DEFAULT 0,
        data_destroyed_at DATE NULL,
        data_destruction_reference VARCHAR(100),
        notes TEXT,
        requested_by INT NULL,
        approved_by INT NULL,
        approved_at DATETIME NULL,
        rejected_by INT NULL,
        rejected_at DATETIME NULL,
        rejection_reason VARCHAR(1000),
        completed_by INT NULL,
        completed_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE RESTRICT,
        FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (completed_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_disposal_asset (asset_id),
        INDEX idx_disposal_status (status),
        INDEX idx_disposal_date (requested_disposal_date)
    )
`;

async function ensureTable() {
    await db.query(TABLE_DDL);
}

const SELECT = `
    SELECT d.*, a.asset_id AS asset_code, a.asset_tag, a.serial_number,
           a.manufacturer, a.model, a.department, a.location,
           a.status AS asset_status, a.condition_status AS asset_condition,
           c.name AS category_name, requester.full_name AS requested_by_name,
           approver.full_name AS approved_by_name,
           rejecter.full_name AS rejected_by_name,
           completer.full_name AS completed_by_name
      FROM asset_disposals d
      JOIN assets a ON a.id = d.asset_id
      LEFT JOIN asset_categories c ON c.id = a.category_id
      LEFT JOIN users requester ON requester.id = d.requested_by
      LEFT JOIN users approver ON approver.id = d.approved_by
      LEFT JOIN users rejecter ON rejecter.id = d.rejected_by
      LEFT JOIN users completer ON completer.id = d.completed_by
`;

async function findAll({ limit = 25, offset = 0 } = {}) {
    const [[count]] = await db.query('SELECT COUNT(*) AS total FROM asset_disposals');
    const [rows] = await db.query(`${SELECT} ORDER BY d.id DESC LIMIT ? OFFSET ?`, [limit, offset]);
    return { rows, total: Number(count.total) || 0 };
}

async function getStatusCounts() {
    const [rows] = await db.query(
        'SELECT status, COUNT(*) AS total FROM asset_disposals GROUP BY status'
    );
    return rows.reduce((counts, row) => {
        counts[row.status] = Number(row.total) || 0;
        return counts;
    }, {});
}

async function findById(id) {
    const [rows] = await db.query(`${SELECT} WHERE d.id = ? LIMIT 1`, [id]);
    return rows[0] || null;
}

async function create(data) {
    const connection = await db.getConnection();
    let id;
    try {
        await connection.beginTransaction();
        const [assets] = await connection.query(
            `SELECT status FROM assets WHERE id = ? FOR UPDATE`,
            [data.asset_id]
        );
        if (!assets.length || ['Disposed', 'Retired', 'Under Repair'].includes(assets[0].status)) {
            await connection.rollback();
            return null;
        }
        const [existing] = await connection.query(
            `SELECT id FROM asset_disposals
              WHERE asset_id = ? AND status IN ('Pending Approval', 'Approved')
              LIMIT 1`,
            [data.asset_id]
        );
        if (existing.length) {
            await connection.rollback();
            return null;
        }
        const [result] = await connection.query(
            `INSERT INTO asset_disposals
                (asset_id, reason, disposal_method, requested_disposal_date, approval_reference,
                 final_condition, data_destroyed, data_destroyed_at,
                 data_destruction_reference, notes, requested_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                data.asset_id,
                data.reason,
                data.disposal_method,
                data.requested_disposal_date,
                data.approval_reference || null,
                data.final_condition,
                data.data_destroyed ? 1 : 0,
                data.data_destroyed_at || null,
                data.data_destruction_reference || null,
                data.notes || null,
                data.requested_by
            ]
        );
        id = result.insertId;
        const ref = `DSP-${String(id).padStart(6, '0')}`;
        await connection.query('UPDATE asset_disposals SET disposal_ref = ? WHERE id = ?', [ref, id]);
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
    return findById(id);
}

async function approve(id, userId) {
    const [result] = await db.query(
        `UPDATE asset_disposals
            SET status = 'Approved', approved_by = ?, approved_at = NOW()
          WHERE id = ? AND status = 'Pending Approval'`,
        [userId, id]
    );
    return result.affectedRows;
}

async function reject(id, userId, reason) {
    const [result] = await db.query(
        `UPDATE asset_disposals
            SET status = 'Rejected', rejected_by = ?, rejected_at = NOW(),
                rejection_reason = ?
          WHERE id = ? AND status = 'Pending Approval'`,
        [userId, reason, id]
    );
    return result.affectedRows;
}

async function complete(id, userId) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [disposals] = await connection.query(
            'SELECT asset_id, final_condition FROM asset_disposals WHERE id = ? AND status = ? FOR UPDATE',
            [id, 'Approved']
        );
        if (!disposals.length) {
            await connection.rollback();
            return false;
        }

        const disposal = disposals[0];
        const [updatedAssets] = await connection.query(
            `UPDATE assets SET status = 'Disposed', condition_status = ?, assigned_user_id = NULL
              WHERE id = ? AND status NOT IN ('Disposed', 'Retired')`,
            [disposal.final_condition, disposal.asset_id]
        );
        if (!updatedAssets.affectedRows) {
            await connection.rollback();
            return false;
        }

        const [assignmentTables] = await connection.query(
            "SHOW TABLES LIKE 'asset_assignments'"
        );
        if (assignmentTables.length) {
            await connection.query(
                `UPDATE asset_assignments
                    SET released_at = NOW(), released_by = ?, release_reason = ?,
                        status = 'Returned'
                  WHERE asset_id = ? AND released_at IS NULL`,
                [userId, `Asset disposed under ${id}`, disposal.asset_id]
            );
        }

        const [updatedDisposal] = await connection.query(
            `UPDATE asset_disposals
                SET status = 'Completed', completed_by = ?, completed_at = NOW()
              WHERE id = ? AND status = 'Approved'`,
            [userId, id]
        );
        if (!updatedDisposal.affectedRows) {
            await connection.rollback();
            return false;
        }
        await connection.commit();
        return true;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = { TABLE_DDL, ensureTable, findAll, getStatusCounts, findById, create, approve, reject, complete };
