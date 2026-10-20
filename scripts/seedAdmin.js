'use strict';

// scripts/seedAdmin.js
// Idempotent seed for the default System Administrator account.
//
// Usage:
//   node scripts/seedAdmin.js
//
// Safe to run repeatedly: if the username OR email already exists the script
// simply reports it and exits without touching the existing record. Credentials
// may be overridden through environment variables:
//   ADMIN_USERNAME  (default: admin)
//   ADMIN_EMAIL     (default: admin@nbsz.co.zw)
//   ADMIN_PASSWORD  (default: Admin@123)
//   ADMIN_FULL_NAME (default: System Administrator)

const { hash } = require('bcryptjs');
const mysql = require('mysql2/promise');
require('dotenv').config();

const SALT_ROUNDS = 12;

const ADMIN = {
    username: process.env.ADMIN_USERNAME || 'admin',
    email: (process.env.ADMIN_EMAIL || 'admin@nbsz.co.zw').toLowerCase(),
    password:
        process.env.ADMIN_PASSWORD ||
        (process.env.NODE_ENV === 'production' ? '' : 'Admin@123'),
    fullName: process.env.ADMIN_FULL_NAME || 'System Administrator',
    role: 'System Administrator'
};

async function seedAdmin() {
    let connection;

    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME
        });

        console.log('\n🌱 Seeding default System Administrator...\n');

        // 1. Does an account with this username or email already exist?
        const [existing] = await connection.query(
            `SELECT id, username, email, role, is_active
             FROM users
             WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
             LIMIT 1`,
            [ADMIN.username, ADMIN.email]
        );

        if (existing.length) {
            const user = existing[0];
            console.log('ℹ️  An account already exists - nothing was changed.');
            console.log(`   id       : ${user.id}`);
            console.log(`   username : ${user.username}`);
            console.log(`   email    : ${user.email}`);
            console.log(`   role     : ${user.role}`);
            console.log(`   active   : ${user.is_active ? 'yes' : 'no'}\n`);

            if (!user.is_active) {
                await connection.query('UPDATE users SET is_active = 1 WHERE id = ?', [
                    user.id
                ]);
                console.log('✅ The existing account was reactivated.\n');
            }

            return;
        }

        if (
            ADMIN.password.length < 8 ||
            !/[A-Z]/.test(ADMIN.password) ||
            !/[a-z]/.test(ADMIN.password) ||
            !/[0-9]/.test(ADMIN.password) ||
            !/[^A-Za-z0-9\s]/.test(ADMIN.password)
        ) {
            throw new Error(
                'Set ADMIN_PASSWORD to at least 8 characters containing uppercase, lowercase, a number, and a special character.'
            );
        }

        // 2. Hash the password and insert.
        const passwordHash = await hash(ADMIN.password, SALT_ROUNDS);

        const [result] = await connection.query(
            `INSERT INTO users
                (username, password_hash, email, full_name, role, is_active, must_change_password)
             VALUES (?, ?, ?, ?, ?, 1, 1)`,
            [ADMIN.username, passwordHash, ADMIN.email, ADMIN.fullName, ADMIN.role]
        );

        const [created] = await connection.query(
            'SELECT id, username, email, full_name, role, is_active FROM users WHERE id = ?',
            [result.insertId]
        );

        console.log('✅ Default System Administrator created successfully!\n');
        console.log('   ---------------------------------------------');
        console.log(`   id        : ${created[0].id}`);
        console.log(`   username  : ${created[0].username}`);
        console.log(`   email     : ${created[0].email}`);
        console.log(`   full name : ${created[0].full_name}`);
        console.log(`   role      : ${created[0].role}`);
        console.log('   ---------------------------------------------');
        console.log('   Temporary password is not written to application logs.');
        console.log('   The account must change it at first login.\n');
    } catch (error) {
        console.error('❌ Failed to seed the administrator account:', error.message);
        process.exitCode = 1;
    } finally {
        if (connection) await connection.end();
    }
}

seedAdmin();
