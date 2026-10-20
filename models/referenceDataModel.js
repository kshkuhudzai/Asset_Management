'use strict';

const db = require('../config/db');

const TABLES = Object.freeze({
    departments: { table: 'departments' },
    locations: { table: 'locations' }
});

let ensurePromise = null;

function ensureTables() {
    if (!ensurePromise) {
        ensurePromise = (async function () {
            await db.query(`
                CREATE TABLE IF NOT EXISTS departments (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(100) NOT NULL UNIQUE,
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);
            await db.query(`
                CREATE TABLE IF NOT EXISTS locations (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(100) NOT NULL UNIQUE,
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);
            await db.query(`
                INSERT IGNORE INTO departments (name)
                SELECT DISTINCT TRIM(department)
                  FROM assets
                 WHERE department IS NOT NULL
                   AND TRIM(department) <> ''
                   AND CHAR_LENGTH(TRIM(department)) <= 100
            `);
            await db.query(`
                INSERT IGNORE INTO locations (name)
                SELECT DISTINCT TRIM(location)
                  FROM assets
                 WHERE location IS NOT NULL
                   AND TRIM(location) <> ''
                   AND CHAR_LENGTH(TRIM(location)) <= 100
            `);
        })().catch((error) => {
            ensurePromise = null;
            throw error;
        });
    }
    return ensurePromise;
}

function getTable(kind) {
    return Object.prototype.hasOwnProperty.call(TABLES, kind) ? TABLES[kind] : null;
}

async function list(kind, includeInactive = false) {
    const config = getTable(kind);
    if (!config) throw new Error('Unsupported reference data type.');
    const [rows] = await db.query(
        `SELECT id, name, is_active, created_at, updated_at
           FROM ${config.table}
          ${includeInactive ? '' : 'WHERE is_active = 1'}
          ORDER BY name ASC`
    );
    return rows;
}

async function create(kind, name) {
    const config = getTable(kind);
    if (!config) throw new Error('Unsupported reference data type.');
    const [result] = await db.query(
        `INSERT INTO ${config.table} (name) VALUES (?)`,
        [name]
    );
    const [rows] = await db.query(
        `SELECT id, name, is_active, created_at, updated_at
           FROM ${config.table}
          WHERE id = ?`,
        [result.insertId]
    );
    return rows[0];
}

async function findById(kind, id) {
    const config = getTable(kind);
    if (!config) throw new Error('Unsupported reference data type.');
    const [rows] = await db.query(
        `SELECT id, name, is_active, created_at, updated_at
           FROM ${config.table}
          WHERE id = ?
          LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

async function setActive(kind, id, isActive) {
    const config = getTable(kind);
    if (!config) throw new Error('Unsupported reference data type.');
    const [result] = await db.query(
        `UPDATE ${config.table} SET is_active = ? WHERE id = ?`,
        [isActive ? 1 : 0, id]
    );
    return result.affectedRows > 0;
}

module.exports = { ensureTables, list, create, findById, setActive };
