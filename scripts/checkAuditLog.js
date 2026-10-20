'use strict';

/**
 * scripts/checkAuditLog.js
 * ---------------------------------------------------------------------------
 * Prints the most recent rows from `audit_logs` so the audit trail produced by
 * the auth slice can be inspected by eye.
 *
 *     node scripts/checkAuditLog.js
 * ---------------------------------------------------------------------------
 */

require('dotenv').config();

const db = require('../config/db');

async function main() {
    const [rows] = await db.query(
        `SELECT id, user_id, action, table_name, record_id, ip_address, created_at
           FROM audit_logs
          ORDER BY id DESC
          LIMIT 15`
    );

    console.log(`\nMost recent audit_logs rows (${rows.length}):\n`);
    if (rows.length === 0) {
        console.log('  (no rows found)');
    } else {
        console.table(rows);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error('Query failed:', err.message);
    process.exit(1);
});
