'use strict';

// scripts/seedDemoData.js
// Populates a realistic demo dataset for all NBSZ asset management modules.
//
// Usage:
//   node scripts/seedDemoData.js
//
// Idempotent: every insert is guarded by a lookup on natural keys.

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
            custodian, custodian ? 'Rudo Chikafu' : null, status, condition, `NBSZ-${tag.slice(-8)}`
        ]
    );
    return res.insertId;
}

/* -------------------------------------------------------------------------- */
/* Lifecycle data                                                             */
/* -------------------------------------------------------------------------- */

async function seedAssignments(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM asset_assignments');
    if (existing[0].n > 0) return;

    const rows = [
        ['NBSZ-LAP-0001', userIds.ictofficer, 'Rudo Chikafu', 'ICT', 'Head Office', 'Primary work laptop'],
        ['NBSZ-DSK-0002', userIds.deptuser, 'Farai Nyoni', 'Credit', 'Gweru Branch', 'Credit department workstation']
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
    if (existing[0].n > 0) return;

    if (assetIds['NBSZ-DSK-0001']) {
        await conn.query(
            `INSERT INTO maintenance_records
                (maintenance_ref, asset_id, maintenance_type, priority, status,
                 reported_by, reported_date, fault_description, technician_name,
                 start_date, performed_by)
             VALUES ('MNT-000001', ?, 'Repair', 'High', 'In Progress', ?, CURDATE(),
                     ?, 'Rudo Chikafu', CURDATE(), ?)`,
            [assetIds['NBSZ-DSK-0001'], userIds.ictofficer, 'Desktop powers on but monitor shows no signal.', userIds.ictofficer]
        );
    }

    if (assetIds['NBSZ-PRN-0001']) {
        await conn.query(
            `INSERT INTO maintenance_records
                (maintenance_ref, asset_id, maintenance_type, priority, status,
                 reported_by, reported_date, fault_description, scheduled_date)
             VALUES ('MNT-000002', ?, 'Service', 'Low', 'Pending', ?, CURDATE(),
                     ?, DATE_ADD(CURDATE(), INTERVAL 5 DAY))`,
            [assetIds['NBSZ-PRN-0001'], userIds.admin, 'Scheduled servicing before retirement review.']
        );
    }

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
    if (existing[0].n > 0) return;

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
            [assetIds['NBSZ-LAP-0002'], userIds.ictofficer, userIds.deptuser, userIds.ictofficer, userIds.admin, userIds.deptuser]
        );
    }
    console.log('   transfers   : 2 created');
}

async function seedWarranties(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM warranties');
    if (existing[0].n > 0) return;

    const items = [
        ['WAR-000001', assetIds['NBSZ-LAP-0001'], 'Asset Warranty', 'CTR-DELL-2024', 'Dell ProSupport Next Business Day', 'Dell EMC Zimbabwe', 'support@dell.co.zw', '+263 242 700000', '2024-01-15', '2027-01-14', 30, 'Full hardware & on-site motherboard coverage', 450.00, 'USD', 'Active'],
        ['WAR-000002', assetIds['NBSZ-LAP-0002'], 'Extended Warranty', 'CTR-HP-2024', 'HP Care Pack On-Site Repair', 'HP Enterprise Hararre', 'service@hpe.co.zw', '+263 242 700001', '2024-03-01', DATE_ADD_STR(20), 30, 'Parts and labor for business laptops', 320.00, 'USD', 'Expiring Soon'],
        ['WAR-000003', assetIds['NBSZ-NET-0001'], 'Service Level Agreement', 'CTR-CSCO-2023', 'Cisco SMARTnet 24x7x4 High Priority', 'Bytes Technology Zimbabwe', 'cisco@bytes.co.zw', '+263 242 790000', '2023-11-11', '2026-11-10', 60, '24x7 hardware replacement within 4 hours', 1200.00, 'USD', 'Active'],
        ['WAR-000004', assetIds['NBSZ-PRN-0001'], 'Maintenance Contract', 'CTR-CANON-2020', 'Canon Copier Service & Consumables SLA', 'Dovetail Office Machines', 'service@dovetail.co.zw', '+263 242 755555', '2020-02-01', '2023-01-31', 30, 'Monthly preventive maintenance and toner supply', 850.00, 'USD', 'Expired']
    ];

    for (const row of items) {
        if (!row[1]) continue;
        await conn.query(
            `INSERT INTO warranties
                (warranty_ref, asset_id, warranty_type, contract_ref, title, provider, provider_email,
                 provider_phone, start_date, expiry_date, notice_period_days, coverage_details,
                 contract_value, currency, status, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [...row, userIds.admin]
        );
    }
    console.log('   warranties  : 4 created');
}

function DATE_ADD_STR(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

async function seedLicences(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM software_licences');
    if (existing[0].n > 0) return;

    const licences = [
        ['LIC-000001', 'Microsoft 365 Business Standard', 'Microsoft Corporation', 'Subscription', 'PO-MS-2025', 50, '2025-01-01', '2026-12-31', 12.50, 'USD', 'Active', 'Productivity suite for all head office staff'],
        ['LIC-000002', 'Kaspersky Endpoint Security Cloud', 'Kaspersky Lab', 'Subscription', 'PO-KASP-2025', 50, '2025-02-01', '2026-01-31', 8.00, 'USD', 'Active', 'Centralized anti-malware and EDR endpoint protection'],
        ['LIC-000003', 'Adobe Acrobat Pro DC', 'Adobe Systems', 'Subscription', 'PO-ADOBE-2025', 10, '2025-03-01', '2026-02-28', 19.99, 'USD', 'Active', 'Executive document signing and OCR processing'],
        ['LIC-000004', 'Windows Server 2022 Datacenter', 'Microsoft Corporation', 'Perpetual', 'PO-WINSRV-2023', 2, '2023-06-01', null, 1400.00, 'USD', 'Active', 'Hyper-V Host Core Licenses for Blood Bank VMs']
    ];

    for (const lic of licences) {
        const [res] = await conn.query(
            `INSERT INTO software_licences
                (licence_ref, software_name, publisher, licence_type, purchase_reference,
                 purchased_quantity, purchased_date, expiry_date, unit_cost, currency, status, notes, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [...lic, userIds.admin]
        );
        const licId = res.insertId;

        // Allocations
        if (lic[0] === 'LIC-000001') {
            await conn.query(
                `INSERT INTO software_licence_allocations
                    (licence_id, asset_id, user_id, quantity, status, allocated_by, notes)
                 VALUES (?, ?, ?, 1, 'Active', ?, 'Primary staff seat')`,
                [licId, assetIds['NBSZ-LAP-0001'], userIds.ictofficer, userIds.admin]
            );
            await conn.query(
                `INSERT INTO software_licence_allocations
                    (licence_id, asset_id, user_id, quantity, status, allocated_by, notes)
                 VALUES (?, ?, ?, 1, 'Active', ?, 'Finance department user seat')`,
                [licId, assetIds['NBSZ-LAP-0002'], userIds.deptuser, userIds.admin]
            );
        }
    }
    console.log('   licences    : 4 created (+ allocations)');
}

async function seedStock(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM stock_items');
    if (existing[0].n > 0) return;

    const items = [
        ['STK-000001', 'Cat6 UTP Ethernet Cable 305m Box', 'CAB-UTP-CAT6', 'Cables', 'Box', 'ICT Store Room', 'A-01', 'ICT', 3, 5, 20, 85.00, 'USD', 'Cable City Harare', 'Active', 'Solid copper 23AWG network cable'],
        ['STK-000002', 'Dell 65W USB-C Laptop Charger', 'DELL-65W-TYPEC', 'Accessories', 'Unit', 'ICT Store Room', 'B-02', 'ICT', 12, 5, 30, 45.00, 'USD', 'Dell Zimbabwe', 'Active', 'Standard replacement PSU for Latitudes'],
        ['STK-000003', 'Logitech Wireless Mouse M185', 'LOG-M185-BLK', 'Peripherals', 'Unit', 'ICT Store Room', 'C-03', 'ICT', 22, 10, 50, 18.00, 'USD', 'Office Choice', 'Active', 'Standard issue wireless mouse'],
        ['STK-000004', 'Kingston 16GB DDR4 3200MHz SODIMM', 'KNG-RAM-16GB-SOD', 'Components', 'Module', 'ICT Store Room', 'D-04', 'ICT', 2, 6, 20, 48.00, 'USD', 'Memory Experts Zim', 'Active', 'Laptop memory upgrades (Low stock alert)'],
        ['STK-000005', 'HP 85A Black LaserJet Toner (CE285A)', 'HP-TONER-CE285A', 'Consumables', 'Cartridge', 'ICT Store Room', 'E-05', 'Administration', 8, 4, 25, 65.00, 'USD', 'Toner Express', 'Active', 'Toner for branch desktop printers']
    ];

    for (const item of items) {
        const [res] = await conn.query(
            `INSERT INTO stock_items
                (item_ref, item_name, part_code, category, unit_of_measure, store_location,
                 bin_location, department, quantity_on_hand, minimum_level, maximum_level,
                 unit_cost, currency, supplier, status, remarks, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [...item, userIds.admin]
        );
        const itemId = res.insertId;

        // Add a movement ledger entry
        await conn.query(
            `INSERT INTO stock_movements
                (movement_ref, stock_item_id, movement_type, quantity, balance_after,
                 movement_date, reference, counterparty, to_department, to_location,
                 unit_cost, total_cost, remarks, recorded_by)
             VALUES (?, ?, 'Receipt', ?, ?, CURDATE(), 'GRN-2026-001', 'Central Stores Supplier',
                     'ICT', 'Head Office', ?, ?, 'Initial stock delivery receipt', ?)`,
            [`MOV-${String(itemId).padStart(6, '0')}`, itemId, item[8], item[8], item[11], item[8] * item[11], userIds.admin]
        );
    }
    console.log('   stock       : 5 items (+ movement ledger) created');
}

async function seedDisposals(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM asset_disposals');
    if (existing[0].n > 0) return;

    if (assetIds['NBSZ-PRN-0001']) {
        await conn.query(
            `INSERT INTO asset_disposals
                (disposal_ref, asset_id, status, reason, disposal_method, requested_disposal_date,
                 approval_reference, final_condition, data_destroyed, notes, requested_by)
             VALUES ('DSP-000001', ?, 'Pending Approval',
                     'Photocopier is beyond economical repair. Optical drum assembly and logic board failed.',
                     'Recycling / Scrap', CURDATE(), 'NBSZ/ICT/DSP/2026-01', 'Obsolete', 0,
                     'Awaiting Board of Survey final recommendation', ?)`,
            [assetIds['NBSZ-PRN-0001'], userIds.ictofficer]
        );
    }
    console.log('   disposals   : 1 created');
}

async function seedVerifications(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM asset_verifications');
    if (existing[0].n > 0) return;

    const [vRes] = await conn.query(
        `INSERT INTO asset_verifications
            (verification_ref, name, department, location, status, notes, created_by, started_at)
         VALUES ('VRF-2026-01', 'Q1 2026 ICT Asset Physical Verification', 'ICT', 'Head Office',
                 'In Progress', 'Annual physical stock count and tag verification', ?, NOW())`,
        [userIds.admin]
    );
    const vId = vRes.insertId;

    const checks = [
        [assetIds['NBSZ-LAP-0001'], 'Verified', 'Head Office', 'Asset physically present, tag legible, in good working condition'],
        [assetIds['NBSZ-DSK-0001'], 'Damaged', 'Head Office', 'Observed in repair workshop with casing removed'],
        [assetIds['NBSZ-NET-0001'], 'Verified', 'Head Office', 'In Server Rack 1, ports active and labelled'],
        [assetIds['NBSZ-LAP-0003'], 'Incorrect Location', 'Mutare Branch', 'Asset was moved to Mutare without logged transfer'],
        [assetIds['NBSZ-PRN-0001'], 'Missing', 'Stores Basement', 'Asset not found in expected store room']
    ];

    for (const [aId, res, loc, notes] of checks) {
        if (!aId) continue;
        await conn.query(
            `INSERT INTO asset_verification_items
                (verification_id, asset_id, result, actual_location, notes, verified_by, verified_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [vId, aId, res, loc, notes, userIds.auditor]
        );
    }
    console.log('   verification: 1 exercise (+ 5 physical audit checks) created');
}

async function seedBarcodeLabels(conn, assetIds, userIds) {
    const [existing] = await conn.query('SELECT COUNT(*) n FROM asset_barcode_labels');
    if (existing[0].n > 0) return;

    let index = 1;
    for (const [tag] of ASSETS) {
        const id = assetIds[tag];
        if (!id) continue;
        const ref = `LBL-${String(index).padStart(6, '0')}`;
        const code = `NBSZ-${tag.slice(-8)}`;
        await conn.query(
            `INSERT INTO asset_barcode_labels
                (label_ref, asset_id, code_value, code_type, symbology, label_reference,
                 label_status, label_condition, print_count, last_printed_at, last_printed_by,
                 is_primary, notes, issued_by)
             VALUES (?, ?, ?, 'QR Code', 'QR', ?, 'Active', 'Good', 1, NOW(), ?, 1, 'Standard initial deployment label', ?)`,
            [ref, id, code, `STICKER-${tag}`, userIds.admin, userIds.admin]
        );
        index++;
    }
    console.log(`   barcodes    : ${index - 1} labels created`);
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
        console.log('\n🌱 Seeding comprehensive NBSZ demo data...\n');

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
        await seedWarranties(conn, assetIds, userIds);
        await seedLicences(conn, assetIds, userIds);
        await seedStock(conn, assetIds, userIds);
        await seedDisposals(conn, assetIds, userIds);
        await seedVerifications(conn, assetIds, userIds);
        await seedBarcodeLabels(conn, assetIds, userIds);

        console.log('\n✅ Demo data seeded successfully across all modules.');
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
        process.exit(0);
    })
    .catch(function (err) {
        console.error('❌ Demo seed failed:', err.message);
        process.exit(1);
    });
