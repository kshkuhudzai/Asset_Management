'use strict';

const db = require('../config/db');

const TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS asset_documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        asset_id INT NOT NULL,
        stored_name CHAR(36) NOT NULL UNIQUE,
        original_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        file_size INT UNSIGNED NOT NULL,
        uploaded_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL,
        INDEX idx_asset_document_asset (asset_id),
        INDEX idx_asset_document_created (created_at)
    )
`;

async function ensureTable() {
    await db.query(TABLE_DDL);
}

async function findByAsset(assetId) {
    const [rows] = await db.query(
        `SELECT d.id, d.asset_id, d.original_name, d.mime_type, d.file_size,
                d.uploaded_by, u.full_name AS uploaded_by_name, d.created_at
           FROM asset_documents d
           LEFT JOIN users u ON u.id = d.uploaded_by
          WHERE d.asset_id = ?
          ORDER BY d.created_at DESC, d.id DESC`,
        [assetId]
    );
    return rows;
}

async function findById(id) {
    const [rows] = await db.query(
        `SELECT id, asset_id, stored_name, original_name, mime_type, file_size,
                uploaded_by, created_at
           FROM asset_documents
          WHERE id = ?
          LIMIT 1`,
        [id]
    );
    return rows[0] || null;
}

async function create({ assetId, storedName, originalName, mimeType, fileSize, uploadedBy }) {
    const [result] = await db.query(
        `INSERT INTO asset_documents
            (asset_id, stored_name, original_name, mime_type, file_size, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [assetId, storedName, originalName, mimeType, fileSize, uploadedBy]
    );
    return findById(result.insertId);
}

async function remove(id) {
    const [result] = await db.query('DELETE FROM asset_documents WHERE id = ?', [id]);
    return result.affectedRows > 0;
}

module.exports = { ensureTable, findByAsset, findById, create, remove };
