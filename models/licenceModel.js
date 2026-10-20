'use strict';

const db = require('../config/db');

const LICENCE_DDL = `
    CREATE TABLE IF NOT EXISTS software_licences (
        id INT AUTO_INCREMENT PRIMARY KEY,
        licence_ref VARCHAR(50) UNIQUE,
        software_name VARCHAR(150) NOT NULL,
        publisher VARCHAR(150),
        licence_type ENUM('Per User', 'Per Device', 'Concurrent', 'Subscription', 'Perpetual', 'Other')
            NOT NULL DEFAULT 'Per User',
        purchase_reference VARCHAR(100),
        purchased_quantity INT UNSIGNED NOT NULL,
        purchased_date DATE NULL,
        expiry_date DATE NULL,
        unit_cost DECIMAL(15, 2) NOT NULL DEFAULT 0,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        status ENUM('Active', 'Suspended', 'Expired', 'Retired') NOT NULL DEFAULT 'Active',
        notes TEXT,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_licence_name (software_name),
        INDEX idx_licence_status (status),
        INDEX idx_licence_expiry (expiry_date)
    )
`;

const ALLOCATION_DDL = `
    CREATE TABLE IF NOT EXISTS software_licence_allocations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        licence_id INT NOT NULL,
        asset_id INT NULL,
        user_id INT NULL,
        quantity INT UNSIGNED NOT NULL,
        status ENUM('Active', 'Released') NOT NULL DEFAULT 'Active',
        allocated_by INT NULL,
        allocated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        released_by INT NULL,
        released_at DATETIME NULL,
        notes VARCHAR(1000),
        FOREIGN KEY (licence_id) REFERENCES software_licences(id) ON DELETE RESTRICT,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (allocated_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (released_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_licence_allocation (licence_id, status),
        INDEX idx_licence_asset (asset_id),
        INDEX idx_licence_user (user_id)
    )
`;

const SELECT = `
    SELECT l.*,
           COALESCE(SUM(CASE WHEN a.status = 'Active' THEN a.quantity ELSE 0 END), 0) AS allocated_quantity,
           l.purchased_quantity -
             COALESCE(SUM(CASE WHEN a.status = 'Active' THEN a.quantity ELSE 0 END), 0) AS available_quantity,
           DATEDIFF(l.expiry_date, CURDATE()) AS days_remaining
      FROM software_licences l
      LEFT JOIN software_licence_allocations a ON a.licence_id = l.id
`;

async function ensureTables() {
    await db.query(LICENCE_DDL);
    await db.query(ALLOCATION_DDL);
}

async function findAll({ search, status, limit = 25, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (search) {
        where.push('(l.licence_ref LIKE ? OR l.software_name LIKE ? OR l.publisher LIKE ? OR l.purchase_reference LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like);
    }
    if (status) {
        where.push('l.status = ?');
        params.push(status);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[count]] = await db.query(
        `SELECT COUNT(*) AS total FROM software_licences l ${filter}`,
        params
    );
    const [rows] = await db.query(
        `${SELECT} ${filter}
          GROUP BY l.id
          ORDER BY l.id DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    return { rows, total: Number(count.total) || 0 };
}

async function findById(id) {
    const [rows] = await db.query(
        `${SELECT} WHERE l.id = ? GROUP BY l.id LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

async function findAllocations(id) {
    const [rows] = await db.query(
        `SELECT a.*, u.username, u.full_name,
                s.asset_id AS asset_code, s.asset_tag, s.serial_number,
                allocator.full_name AS allocated_by_name,
                releaser.full_name AS released_by_name
           FROM software_licence_allocations a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN assets s ON s.id = a.asset_id
           LEFT JOIN users allocator ON allocator.id = a.allocated_by
           LEFT JOIN users releaser ON releaser.id = a.released_by
          WHERE a.licence_id = ?
          ORDER BY a.id DESC`,
        [id]
    );
    return rows;
}

async function create(data) {
    const [result] = await db.query(
        `INSERT INTO software_licences
            (software_name, publisher, licence_type, purchase_reference,
             purchased_quantity, purchased_date, expiry_date, unit_cost, currency, notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            data.software_name,
            data.publisher || null,
            data.licence_type,
            data.purchase_reference || null,
            data.purchased_quantity,
            data.purchased_date || null,
            data.expiry_date || null,
            data.unit_cost,
            data.currency,
            data.notes || null,
            data.created_by
        ]
    );
    const ref = `LIC-${String(result.insertId).padStart(6, '0')}`;
    await db.query('UPDATE software_licences SET licence_ref = ? WHERE id = ?', [ref, result.insertId]);
    return findById(result.insertId);
}

async function setStatus(id, status) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [licences] = await connection.query(
            'SELECT id FROM software_licences WHERE id = ? FOR UPDATE',
            [id]
        );
        if (!licences.length) {
            await connection.rollback();
            return 0;
        }
        if (status === 'Retired') {
            const [[active]] = await connection.query(
                `SELECT COALESCE(SUM(quantity), 0) AS total
                   FROM software_licence_allocations
                  WHERE licence_id = ? AND status = 'Active'`,
                [id]
            );
            if (Number(active.total) > 0) {
                await connection.rollback();
                return -1;
            }
        }
        await connection.query('UPDATE software_licences SET status = ? WHERE id = ?', [status, id]);
        await connection.commit();
        return 1;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function updateDetails(id, fields) {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const [licences] = await connection.query(
            'SELECT id FROM software_licences WHERE id = ? FOR UPDATE',
            [id]
        );
        if (!licences.length) {
            await connection.rollback();
            return 0;
        }
        const [[allocation]] = await connection.query(
            `SELECT COALESCE(SUM(quantity), 0) AS allocated
               FROM software_licence_allocations
              WHERE licence_id = ? AND status = 'Active'`,
            [id]
        );
        if (fields.purchased_quantity !== undefined &&
            Number(fields.purchased_quantity) < Number(allocation.allocated)) {
            await connection.rollback();
            return -1;
        }
        const keys = Object.keys(fields);
        if (!keys.length) {
            await connection.commit();
            return 1;
        }
        const assignments = keys.map((key) => `${key} = ?`).join(', ');
        const [result] = await connection.query(
            `UPDATE software_licences SET ${assignments} WHERE id = ?`,
            [...keys.map((key) => fields[key]), id]
        );
        await connection.commit();
        return result.affectedRows || 1;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

async function getStats() {
    const [[row]] = await db.query(
        `SELECT COUNT(*) AS total,
                SUM(status = 'Active' AND (expiry_date IS NULL OR expiry_date >= CURDATE())) AS active,
                SUM(status = 'Suspended') AS suspended,
                SUM(status = 'Retired' OR (expiry_date IS NOT NULL AND expiry_date < CURDATE())) AS expired,
                SUM(expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 90 DAY)
                    AND status = 'Active') AS expiring_soon,
                COALESCE(SUM(purchased_quantity), 0) AS purchased,
                COALESCE(SUM(allocated), 0) AS allocated
           FROM (
                SELECT l.id, l.status, l.expiry_date, l.purchased_quantity,
                       COALESCE(SUM(CASE WHEN a.status = 'Active' THEN a.quantity ELSE 0 END), 0) AS allocated
                  FROM software_licences l
                  LEFT JOIN software_licence_allocations a ON a.licence_id = l.id
                 GROUP BY l.id
           ) totals`
    );
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value) || 0]));
}

async function findExpiring(days = 90) {
    const [rows] = await db.query(
        `${SELECT}
          WHERE l.status = 'Active'
            AND l.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
          GROUP BY l.id
          ORDER BY l.expiry_date ASC`,
        [days]
    );
    return rows;
}

async function allocate(id, data) {
    const connection = await db.getConnection();
    let allocationId;
    try {
        await connection.beginTransaction();
        const [licences] = await connection.query(
            `SELECT purchased_quantity, status, expiry_date,
                    (expiry_date IS NOT NULL AND expiry_date < CURDATE()) AS is_expired
               FROM software_licences
              WHERE id = ?
              FOR UPDATE`,
            [id]
        );
        if (!licences.length || licences[0].status !== 'Active' ||
            Number(licences[0].is_expired)) {
            await connection.rollback();
            return { error: 'Licence is unavailable or expired.' };
        }
        const [[allocation]] = await connection.query(
            `SELECT COALESCE(SUM(quantity), 0) AS allocated
               FROM software_licence_allocations
              WHERE licence_id = ? AND status = 'Active'`,
            [id]
        );
        const available = Number(licences[0].purchased_quantity) - Number(allocation.allocated);
        if (data.quantity > available) {
            await connection.rollback();
            return { error: `Only ${available} licence(s) remain available.` };
        }
        const [result] = await connection.query(
            `INSERT INTO software_licence_allocations
                (licence_id, asset_id, user_id, quantity, allocated_by, notes)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, data.asset_id || null, data.user_id || null, data.quantity, data.allocated_by, data.notes || null]
        );
        allocationId = result.insertId;
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
    const [rows] = await db.query(
        `SELECT a.*, u.full_name, u.username, s.asset_tag, s.asset_id AS asset_code
           FROM software_licence_allocations a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN assets s ON s.id = a.asset_id
          WHERE a.id = ?`,
        [allocationId]
    );
    return { allocation: rows[0] };
}

async function release(id, allocationId, userId) {
    const [result] = await db.query(
        `UPDATE software_licence_allocations
            SET status = 'Released', released_by = ?, released_at = NOW()
          WHERE id = ? AND licence_id = ? AND status = 'Active'`,
        [userId, allocationId, id]
    );
    return result.affectedRows;
}

module.exports = {
    LICENCE_DDL,
    ALLOCATION_DDL,
    ensureTables,
    findAll,
    findById,
    findAllocations,
    create,
    setStatus,
    updateDetails,
    getStats,
    findExpiring,
    allocate,
    release
};