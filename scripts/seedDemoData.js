'use strict';

// scripts/seedDemoData.js
// Populates a small, realistic demo dataset so the frontend has something to
// show after a fresh `node scripts/initDb.js` + `node scripts/seedAdmin.js`.
//
// Usage:
//   node scripts/seedDemoData.js
//
// Idempotent: every insert is guarded by a lookup on the natural key
// (category name / asset_tag / username), so re-running only tops up what is
// missing and never duplicates rows.
//
// Creates:
//   - 4 asset categories
//   - 4 staff accounts (HISO, ICT Officer, Departmental User, Auditor)
//   - 8 assets spread across statuses/conditions
//   - 2 assignments, 3 maintenance records, 2 transfers
//
// All demo passwords are `Passw0rd!` except the seeded administrator
// (`admin` / `Admin@123`).

const mysql = require('mysql2/promise');
const { hash } = require('bcryptjs');
require('dotenv').config();

const DEMO_PASSWORD = 'Passw0rd!';
const SALT_ROUNDS = 12;

const CATEGORIES = [
    { name: 'Laptops', description: 'Portable computers issued to staff' },
    { name: 'Desktops', description: 'Desktop workstations and monitors' },
    { name: 'Network Equipment', description: 'Routers, switches, access points' },
    { name: 'Printers & Scanners', description: 'Shared office peripherals' }
];

const STAFF = [
    { username: 'hiso', email: 'hiso@nbsz.co.zw', full_name: 'Tendai Moyo', role: 'HISO' },
    { username: 'ictofficer', email: 'ict.officer@nbsz.co.zw', full_name: 'Rudo Chikafu', role: 'ICT Officer' },
    { username: 'deptuser', email: 'dept.user@nbsz.co.zw', full_name: 'Farai Nyoni', role: 'Departmental User' },
    { username: 'auditor', email: 'auditor@nbsz.co.zw', full_name: 'Nyasha Banda', role: 'Auditor' }
];

// [asset_tag, serial, category, manufacturer, model, cost, location, department,
//  status, condition, warranty_start, warranty_end]
const ASSETS = [
    ['NBSZ-LAP-0001', 'SN-LAP-0001', 'Laptops', 'Dell', 'Latitude 5540', 1450.0, 'Head Office', 'ICT', 'In Use', 'Good', '2024-01-15', '2027-01-14'],
    ['NBSZ-LAP-0002', 'SN-LAP-0002', 'Laptops', 'HP', 'ProBook 450 G10', 1250.0, 'Head Office', 'Finance', 'In Use', 'Good', '2024-03-01', '2027-02-28'],
    ['NBSZ-LAP-0003', 'SN-LAP-0003', 'Laptops', 'Lenovo', 'ThinkPad T14', 1390.0, 'Bulawayo Branch', 'Operations', 'In Stock', 'Good', '2024-06-10', '2027-06-09'],
    ['NBSZ-DSK-0001', 'SN-DSK-0001', 'Desktops', 'Dell', 'OptiPlex 7010', 980.0, 'Head Office', 'ICT', 'Under Repair', 'Damaged', '2023-05-20', '2026-05-19'],
    ['NBSZ-DSK-0002', 'SN-DSK-0002', 'Desktops', 'HP', 'EliteDesk 800 G9', 1100.0, 'Gweru Branch', 'Credit', 'In Use', 'Good', '2024-09-05', '2027-09-04'],
    ['NBSZ-NET-0001', 'SN-NET-0001', 'Network Equipment', 'Cisco', 'Catalyst 2960X', 3200.0, 'Head Office', 'ICT', 'In Use', 'Good', '2023-11-11', '2026-11-10'],
    ['NBSZ-NET-0002', 'SN-NET-0002', 'Network Equipment', 'Ubiquiti', 'UniFi U6 Pro', 260.0, 'Mutare Branch', 'ICT', 'In Stock', 'Good', '2025-01-20', '2028-01-19'],
    ['NBSZ-PRN-0001', 'SN-PRN-0001', 'Printers & Scanners', 'Canon', 'imageRUNNER 2630', 2100.0, 'Head Office', 'Administration', 'Retired', 'Obsolete', '2020-02-01', '2023-01-31']
];

/* -------------------------------------------------------------------------- */
/* Idempotent insert helpers                                                  */
/* -------------------------------------------------------------------------- */

async function ensureCategory(conn, category) {
    const [found] = await conn.query('SELECT id FROM asset_categories WHERE name = ? LIMIT 1', [
        category.name
    ]);
    if (found.length) return found[0].id;

    const [res] = await conn.query(
        'INSERT INTO asset_categories (name, description) VALUES (?, ?)',
        [category.name, category.description]
    );
    return res.insertId;
}

async function ensureUser(conn, staff) {
    const [found] = await conn.query('SELECT id FROM users WHERE username = ? LIMIT 1', [
        staff.username
    ]);
    if (found.length) return found[0].id;

    const passwordHash = await hash(DEMO_PASSWORD, SALT_ROUNDS);
    const [res] = await conn.query(
        `INSERT INTO users (username, password_hash, email, full_name, role, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
        [staff.username, passwordHash, staff.email, staff.full_name, staff.role]
    );
    return res.insertId;
}

async function ensureAsset(conn, row, categoryIds, userIds) {
    const [tag, serial, category, manufacturer, model, cost, location, department,
        status, condition, wStart, wEnd] = row;

    const [found] = await conn.query('SELECT id FROM assets WHERE asset_tag = ? LIMIT 1', [tag]);
    if (found.length) return found[0].id;

    // Keep the human-readable Asset ID identical to the tag for demo clarity.
    const custodian = status === 'In Use' ? userIds.ictofficer : null;

    const [res] = await conn.query(
        `INSERT INTO assets
            (asset_id, asset_tag, serial_number, category_id, manufacturer, model,
             purchase_date, purchase_cost, supplier, po_invoice_ref, warranty_provider,
             warranty_start, warranty_end, warranty_ref, location, department,
             assigned_user_id, responsible_officer, status, condition_status, qr_code_value)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            tag, tag, serial, categoryIds[category] || null, manufacturer, model,
            wStart, cost, 'Demo Supplier (Pvt) Ltd', `PO-${tag}`, `${manufacturer} Zimbabwe`,
            wStart, wEnd, `WAR-${tag}`, location, department,
            custodian, custodian ? 'Rudo Chikafu' : null, status, condition, `NBSZ|${tag}`
        ]
    );
    return res.insertId;
}


/* -------------------------------------------------------------------------- */
/* Lifecycle data                                                             */
/* -------------------------------------------------------------------------- */

async function seedAssignments(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM asset_assignments');
    if (existing[0].n > 0) {
        console.log(`   assignments : ${existing[0].n} already present (skipped)`);
        return;
    }

    const rows = [
        ['NBSZ-LAP-0001', userIds.ictofficer, 'Rudo Chikafu', 'ICT', 'Head Office',
            'Primary work laptop'],
        ['NBSZ-DSK-0002', userIds.deptuser, 'Farai Nyoni', 'Credit', 'Gweru Branch',
            'Credit department workstation']
    ];

    for (const [tag, userId, name, dept, location, purpose] of rows) {
        if (!assetIds[tag] || !userId) continue;
        await conn.query(
            `INSERT INTO asset_assignments
                (asset_id, assigned_user_id, assigned_to_name, department, location,
                 responsible_officer, assignment_date, purpose, status, assigned_by)
             VALUES (?, ?, ?, ?, ?, ?, DATE_SUB(CURDATE(), INTERVAL 30 DAY), ?, 'Active', ?)`,
            [assetIds[tag], userId, name, dept, location, name, purpose, userIds.admin]
        );
    }
    console.log('   assignments : 2 created');
}


async function seedMaintenance(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM maintenance_records');
    if (existing[0].n > 0) {
        console.log(`   maintenance : ${existing[0].n} already present (skipped)`);
        return;
    }

    // 1. Open repair - drives the "In Progress" counter and the overdue panel.
    if (assetIds['NBSZ-DSK-0001']) {
        await conn.query(
            `INSERT INTO maintenance_records
                (maintenance_ref, asset_id, maintenance_type, priority, status,
                 reported_by, reported_date, fault_description, technician_name,
                 start_date, performed_by)
             VALUES ('MNT-000001', ?, 'Repair', 'High', 'In Progress', ?, CURDATE(),
                     ?, 'Rudo Chikafu', CURDATE(), ?)`,
            [assetIds['NBSZ-DSK-0001'], userIds.ictofficer,
                'Desktop powers on but the monitor shows no signal.', userIds.ictofficer]
        );
    }

    // 2. Scheduled preventive service - shows under the "Pending" filter.
    if (assetIds['NBSZ-PRN-0001']) {
        await conn.query(
            `INSERT INTO maintenance_records
                (maintenance_ref, asset_id, maintenance_type, priority, status,
                 reported_by, reported_date, fault_description, scheduled_date)
             VALUES ('MNT-000002', ?, 'Service', 'Low', 'Pending', ?, CURDATE(),
                     ?, DATE_ADD(CURDATE(), INTERVAL 5 DAY))`,
            [assetIds['NBSZ-PRN-0001'], userIds.admin,
                'Scheduled servicing before the retirement review.']
        );
    }

    // 3. Historical completed job - proves the stats/history endpoints.
    if (assetIds['NBSZ-NET-0001']) {
        await conn.query(
            `INSERT INTO maintenance_records
                (maintenance_ref, asset_id, maintenance_type, priority, status,
                 reported_by, reported_date, fault_description, technician_name,
                 vendor, work_performed, resolution, start_date, completion_date,
                 cost, condition_after, performed_by)
             VALUES ('MNT-000003', ?, 'Repair', 'Medium', 'Completed', ?,
                     DATE_SUB(CURDATE(), INTERVAL 20 DAY),
                     'Intermittent reboots under load.', 'Rudo Chikafu',
                     'TechWorks (Pvt) Ltd', 'Firmware upgraded; faulty power supply replaced.',
                     'Unit tested and returned to service.', DATE_SUB(CURDATE(), INTERVAL 18 DAY),
                     DATE_SUB(CURDATE(), INTERVAL 12 DAY), 145.50, 'Good', ?)`,
            [assetIds['NBSZ-NET-0001'], userIds.ictofficer, userIds.ictofficer]
        );
    }
    console.log('   maintenance : 3 created');
}


async function seedTransfers(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM transfers');
    if (existing[0].n > 0) {
        console.log(`   transfers   : ${existing[0].n} already present (skipped)`);
        return;
    }

    // 1. Pending request - visible in the "Pending" filter.
    if (assetIds['NBSZ-LAP-0003']) {
        await conn.query(
            `INSERT INTO transfers
                (transfer_ref, asset_id, transfer_type, from_department, from_location,
                 to_department, to_location, to_user_id, to_custodian_name, reason,
                 status, initiated_by, transfer_date)
             VALUES ('TRF-000001', ?, 'Location', 'Operations', 'Bulawayo Branch', 'ICT',
                     'Head Office', ?, 'Rudo Chikafu',
                     'Consolidating ICT kit at Head Office.', 'Pending', ?, CURDATE())`,
            [assetIds['NBSZ-LAP-0003'], userIds.ictofficer, userIds.ictofficer]
        );
    }

    // 2. Completed movement - proves history plus the acknowledgement columns.
    if (assetIds['NBSZ-LAP-0002']) {
        await conn.query(
            `INSERT INTO transfers
                (transfer_ref, asset_id, transfer_type, from_user_id, from_custodian_name,
                 from_department, from_location, to_user_id, to_custodian_name,
                 to_department, to_location, reason, status, initiated_by, approved_by,
                 transfer_date, receiving_party_name, receiving_party_acknowledged_at,
                 receiving_party_acknowledged_by)
             VALUES ('TRF-000002', ?, 'Department', ?, 'Rudo Chikafu', 'ICT', 'Head Office',
                     ?, 'Farai Nyoni', 'Finance', 'Head Office',
                     'Finance requires a dedicated laptop for audit support.',
                     'Completed', ?, ?, DATE_SUB(CURDATE(), INTERVAL 3 DAY),
                     'Farai Nyoni', NOW(), ?)`,
            [assetIds['NBSZ-LAP-0002'], userIds.ictofficer, userIds.deptuser,
                userIds.ictofficer, userIds.admin, userIds.deptuser]
        );
    }
    console.log('   transfers   : 2 created');
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function seed() {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Demo accounts and credentials are disabled in production.');
    }

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    try {
        // The lifecycle tables are created lazily by their models' ensureTable().
        // Requiring them here keeps this script self-sufficient on a fresh DB.
        for (const name of ['assetAssignmentModel', 'transferModel', 'maintenanceModel']) {
            const model = require(`../models/${name}`);
            if (typeof model.ensureTable === 'function') await model.ensureTable();
        }

        console.log('\n🌱 Seeding demo data...\n');

        const categoryIds = {};
        for (const category of CATEGORIES) {
            categoryIds[category.name] = await ensureCategory(conn, category);
        }
        console.log(`   categories  : ${CATEGORIES.length} ensured`);

        const userIds = {};
        for (const staff of STAFF) {
            userIds[staff.username] = await ensureUser(conn, staff);
        }
        const [admins] = await conn.query(
            "SELECT id FROM users WHERE role = 'System Administrator' ORDER BY id LIMIT 1"
        );
        userIds.admin = admins.length ? admins[0].id : null;
        console.log(`   users       : ${STAFF.length} ensured (+ administrator)`);

        const assetIds = {};
        for (const row of ASSETS) {
            assetIds[row[0]] = await ensureAsset(conn, row, categoryIds, userIds);
        }
        console.log(`   assets      : ${ASSETS.length} ensured`);

        await seedAssignments(conn, assetIds, userIds);
        await seedMaintenance(conn, assetIds, userIds);
        await seedTransfers(conn, assetIds, userIds);

        console.log('\n✅ Demo data seeded successfully.');
        console.log('\n   Sign in with any of these accounts:');
        console.log('   ------------------------------------------------');
        console.log('   admin        / Admin@123    (System Administrator)');
        STAFF.forEach(function (s) {
            console.log(`   ${s.username.padEnd(12)} / ${DEMO_PASSWORD}  (${s.role})`);
        });
        console.log('   ------------------------------------------------\n');
    } finally {
        await conn.end();
    }
}

seed()
    .then(function () {
        // The models pull in the shared MySQL pool via config/db, which keeps
        // sockets open and would otherwise hold the event loop open forever.
        // The dedicated `conn` above is already closed, so exit explicitly.
        process.exit(0);
    })
    .catch(function (err) {
        console.error('❌ Demo seed failed:', err.message);
        process.exit(1);
    });
