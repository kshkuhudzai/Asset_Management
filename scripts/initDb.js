'use strict';

// scripts/initDb.js
const mysql = require('mysql2/promise');
require('dotenv').config();

async function initializeDatabase() {
    let connection;
    try {
        // Connect to MySQL
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            multipleStatements: true // Allows us to run multiple SQL statements at once
        });

        console.log('🔌 Connected to MySQL. Building tables...');

        const schema = `
            -- 1. Users Table (For Authentication & RBAC)
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                full_name VARCHAR(100) NOT NULL,
                role ENUM('System Administrator', 'HISO', 'ICT Officer', 'Departmental User', 'Auditor') NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            );

            -- 2. Asset Categories Table (Configurable categories)
            CREATE TABLE IF NOT EXISTS asset_categories (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- 3. Assets Table (The core register)
            CREATE TABLE IF NOT EXISTS assets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                asset_id VARCHAR(50) UNIQUE NOT NULL,       -- Generated Asset ID
                asset_tag VARCHAR(50) UNIQUE NOT NULL,      -- Physical Tag
                serial_number VARCHAR(100) UNIQUE,          -- Manufacturer Serial
                category_id INT,
                manufacturer VARCHAR(100),
                model VARCHAR(100),
                purchase_date DATE,
                purchase_cost DECIMAL(15, 2),
                supplier VARCHAR(150),
                po_invoice_ref VARCHAR(100),
                warranty_provider VARCHAR(150),
                warranty_start DATE,
                warranty_end DATE,
                warranty_ref VARCHAR(100),
                location VARCHAR(100),                      -- Branch/Location
                department VARCHAR(100),
                assigned_user_id INT,                       -- Custodian (FK to Users)
                responsible_officer VARCHAR(100),
                status ENUM('In Use', 'In Stock', 'Under Repair', 'Missing', 'Retired', 'Disposed') DEFAULT 'In Stock',
                condition_status ENUM('Good', 'Fair', 'Damaged', 'Obsolete') DEFAULT 'Good',
                last_inspection_date DATE,
                qr_code_value VARCHAR(255),
                date_registered TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (category_id) REFERENCES asset_categories(id) ON DELETE SET NULL,
                FOREIGN KEY (assigned_user_id) REFERENCES users(id) ON DELETE SET NULL,
                INDEX idx_asset_tag (asset_tag),
                INDEX idx_serial (serial_number),
                INDEX idx_status (status)
            );

            -- 4. Audit Logs Table (For tracking all material changes)
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT,
                action VARCHAR(50) NOT NULL,                -- e.g., 'CREATE', 'UPDATE', 'DELETE'
                table_name VARCHAR(50) NOT NULL,
                record_id INT NOT NULL,
                old_values JSON,                            -- Store previous state
                new_values JSON,                            -- Store new state
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
            );
        `;

        // Execute the schema
        await connection.query(schema);
        const [userColumns] = await connection.query(
            "SHOW COLUMNS FROM users LIKE 'must_change_password'"
        );
        if (!userColumns.length) {
            await connection.query(
                'ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE AFTER is_active'
            );
        }
        console.log('✅ Database tables created successfully!');

    } catch (error) {
        console.error('❌ Error initializing database:', error.message);
        process.exitCode = 1;
    } finally {
        if (connection) await connection.end();
    }
}

initializeDatabase();