'use strict';

const db = require('../config/db');

const REPORTS = {
    asset_register: {
        title: 'Asset Register',
        columns: [
            ['asset_id', 'Asset ID'], ['asset_tag', 'Asset Tag'], ['serial_number', 'Serial Number'],
            ['category', 'Category'], ['manufacturer', 'Manufacturer'], ['model', 'Model'],
            ['department', 'Department'], ['location', 'Location'], ['assigned_to', 'Assigned To'],
            ['status', 'Status'], ['condition_status', 'Condition'], ['purchase_date', 'Purchase Date'],
            ['purchase_cost', 'Purchase Cost'], ['date_registered', 'Date Registered']
        ],
        from: `FROM assets a
               LEFT JOIN asset_categories c ON c.id = a.category_id
               LEFT JOIN users u ON u.id = a.assigned_user_id`,
        date: 'a.date_registered',
        filters: {
            status: 'a.status', department: 'a.department', location: 'a.location',
            category: 'c.name'
        },
        search: ['a.asset_id', 'a.asset_tag', 'a.serial_number', 'a.manufacturer', 'a.model'],
        select: `SELECT a.asset_id, a.asset_tag, a.serial_number, c.name AS category,
                        a.manufacturer, a.model, a.department, a.location,
                        u.full_name AS assigned_to, a.status, a.condition_status,
                        a.purchase_date, a.purchase_cost, a.date_registered`
    },
    warranty_expiry: {
        title: 'Warranty & Contract Expiry',
        columns: [
            ['warranty_ref', 'Reference'], ['title', 'Coverage'], ['warranty_type', 'Type'],
            ['asset_id', 'Asset ID'], ['asset_tag', 'Asset Tag'], ['provider', 'Provider'],
            ['department', 'Department'], ['location', 'Location'], ['expiry_date', 'Expiry Date'],
            ['days_remaining', 'Days Remaining'], ['status', 'Status']
        ],
        from: `FROM warranties w LEFT JOIN assets a ON a.id = w.asset_id`,
        date: 'w.expiry_date',
        filters: {
            status: 'w.status', department: 'a.department', location: 'a.location'
        },
        search: ['w.warranty_ref', 'w.title', 'w.contract_ref', 'w.provider', 'a.asset_id', 'a.asset_tag'],
        select: `SELECT w.warranty_ref, w.title, w.warranty_type, a.asset_id, a.asset_tag,
                        w.provider, a.department, a.location, w.expiry_date,
                        DATEDIFF(w.expiry_date, CURDATE()) AS days_remaining, w.status`
    },
    maintenance: {
        title: 'Maintenance History & Cost',
        columns: [
            ['maintenance_ref', 'Reference'], ['asset_id', 'Asset ID'], ['asset_tag', 'Asset Tag'],
            ['department', 'Department'], ['location', 'Location'], ['maintenance_type', 'Type'],
            ['priority', 'Priority'], ['reported_date', 'Reported Date'], ['completion_date', 'Completion Date'],
            ['vendor', 'Vendor'], ['cost', 'Cost'], ['status', 'Status']
        ],
        from: `FROM maintenance_records m JOIN assets a ON a.id = m.asset_id`,
        date: 'm.reported_date',
        filters: {
            status: 'm.status', department: 'a.department', location: 'a.location',
            category: 'c.name'
        },
        join: 'LEFT JOIN asset_categories c ON c.id = a.category_id',
        search: ['m.maintenance_ref', 'm.fault_description', 'm.vendor', 'a.asset_id', 'a.asset_tag'],
        select: `SELECT m.maintenance_ref, a.asset_id, a.asset_tag, a.department, a.location,
                        m.maintenance_type, m.priority, m.reported_date, m.completion_date,
                        m.vendor, m.cost, m.status`
    },
    transfers: {
        title: 'Asset Transfer History',
        columns: [
            ['transfer_ref', 'Reference'], ['asset_id', 'Asset ID'], ['asset_tag', 'Asset Tag'],
            ['from_custodian_name', 'From Custodian'], ['from_department', 'From Department'],
            ['from_location', 'From Location'], ['to_custodian_name', 'To Custodian'],
            ['to_department', 'To Department'], ['to_location', 'To Location'],
            ['transfer_type', 'Type'], ['transfer_date', 'Date'], ['reason', 'Reason'], ['status', 'Status']
        ],
        from: `FROM transfers t JOIN assets a ON a.id = t.asset_id`,
        date: 't.transfer_date',
        filters: {
            status: 't.status', department: 'COALESCE(t.to_department, a.department)',
            location: 'COALESCE(t.to_location, a.location)'
        },
        search: ['t.transfer_ref', 'a.asset_id', 'a.asset_tag', 't.reason', 't.to_custodian_name'],
        select: `SELECT t.transfer_ref, a.asset_id, a.asset_tag, t.from_custodian_name,
                        t.from_department, t.from_location, t.to_custodian_name,
                        t.to_department, t.to_location, t.transfer_type, t.transfer_date,
                        t.reason, t.status`
    },
    stock: {
        title: 'ICT Stock Balances',
        columns: [
            ['item_ref', 'Item Reference'], ['item_name', 'Item'], ['category', 'Category'],
            ['store_location', 'Store Location'], ['bin_location', 'Bin'], ['department', 'Department'],
            ['quantity_on_hand', 'On Hand'], ['minimum_level', 'Minimum'], ['unit_of_measure', 'Unit'],
            ['unit_cost', 'Unit Cost'], ['status', 'Status']
        ],
        from: 'FROM stock_items s',
        date: 's.created_at',
        dateTime: true,
        filters: {
            status: 's.status', department: 's.department', location: 's.store_location',
            category: 's.category'
        },
        search: ['s.item_ref', 's.item_name', 's.part_code', 's.supplier'],
        select: `SELECT s.item_ref, s.item_name, s.category, s.store_location,
                        s.bin_location, s.department, s.quantity_on_hand, s.minimum_level,
                        s.unit_of_measure, s.unit_cost, s.status`
    },
    stock_movements: {
        title: 'Stock Movement Ledger',
        columns: [
            ['movement_ref', 'Movement Reference'], ['item_name', 'Item'], ['movement_type', 'Type'],
            ['quantity', 'Quantity'], ['balance_after', 'Balance After'], ['movement_date', 'Date'],
            ['reference', 'Reference'], ['counterparty', 'Counterparty'], ['to_department', 'Department'],
            ['to_location', 'Location'], ['total_cost', 'Total Cost']
        ],
        from: 'FROM stock_movements m LEFT JOIN stock_items s ON s.id = m.stock_item_id',
        date: 'm.movement_date',
        filters: {
            status: 'm.movement_type', department: 'm.to_department', location: 'm.to_location',
            category: 's.category'
        },
        search: ['m.movement_ref', 's.item_name', 'm.reference', 'm.counterparty', 'm.reason'],
        select: `SELECT m.movement_ref, s.item_name, m.movement_type, m.quantity,
                        m.balance_after, m.movement_date, m.reference, m.counterparty,
                        m.to_department, m.to_location, m.total_cost`
    },
    verification_exceptions: {
        title: 'Physical Verification Exceptions',
        columns: [
            ['verification_ref', 'Exercise Reference'], ['name', 'Exercise'], ['asset_id', 'Asset ID'],
            ['asset_tag', 'Asset Tag'], ['department', 'Department'], ['location', 'Expected Location'],
            ['actual_location', 'Actual Location'], ['result', 'Result'], ['notes', 'Notes'],
            ['verified_at', 'Checked At']
        ],
        from: `FROM asset_verification_items i
               JOIN asset_verifications v ON v.id = i.verification_id
               JOIN assets a ON a.id = i.asset_id`,
        date: 'v.started_at',
        dateTime: true,
        filters: {
            department: 'a.department', location: 'a.location', category: 'c.name'
        },
        join: 'LEFT JOIN asset_categories c ON c.id = a.category_id',
        search: ['v.verification_ref', 'v.name', 'a.asset_id', 'a.asset_tag', 'i.result'],
        extraWhere: "i.result IN ('Missing', 'Damaged', 'Incorrect Location')",
        select: `SELECT v.verification_ref, v.name, a.asset_id, a.asset_tag,
                        a.department, a.location, i.actual_location, i.result, i.notes, i.verified_at`
    },
    disposals: {
        title: 'Asset Disposal History',
        columns: [
            ['disposal_ref', 'Reference'], ['asset_id', 'Asset ID'], ['asset_tag', 'Asset Tag'],
            ['department', 'Department'], ['location', 'Location'], ['reason', 'Reason'],
            ['disposal_method', 'Method'], ['requested_disposal_date', 'Requested Date'],
            ['final_condition', 'Final Condition'], ['data_destroyed', 'Data Destroyed'], ['status', 'Status']
        ],
        from: `FROM asset_disposals d JOIN assets a ON a.id = d.asset_id`,
        date: 'd.requested_disposal_date',
        filters: {
            status: 'd.status', department: 'a.department', location: 'a.location',
            category: 'c.name'
        },
        join: 'LEFT JOIN asset_categories c ON c.id = a.category_id',
        search: ['d.disposal_ref', 'a.asset_id', 'a.asset_tag', 'd.reason', 'd.disposal_method'],
        select: `SELECT d.disposal_ref, a.asset_id, a.asset_tag, a.department, a.location,
                        d.reason, d.disposal_method, d.requested_disposal_date,
                        d.final_condition, d.data_destroyed, d.status`
    },
    licences: {
        title: 'Software Licence Entitlements',
        columns: [
            ['licence_ref', 'Reference'], ['software_name', 'Software'], ['publisher', 'Publisher'],
            ['licence_type', 'Type'], ['purchased_quantity', 'Purchased Seats'],
            ['allocated_quantity', 'Allocated Seats'], ['available_quantity', 'Available Seats'],
            ['expiry_date', 'Expiry Date'], ['currency', 'Currency'], ['unit_cost', 'Unit Cost'],
            ['status', 'Status']
        ],
        from: `FROM software_licences l
               LEFT JOIN software_licence_allocations la
                 ON la.licence_id = l.id AND la.status = 'Active'`,
        date: 'l.expiry_date',
        filters: { status: 'l.status' },
        search: ['l.licence_ref', 'l.software_name', 'l.publisher', 'l.purchase_reference'],
        group: 'GROUP BY l.id',
        select: `SELECT l.licence_ref, l.software_name, l.publisher, l.licence_type,
                        l.purchased_quantity,
                        COALESCE(SUM(la.quantity), 0) AS allocated_quantity,
                        l.purchased_quantity - COALESCE(SUM(la.quantity), 0) AS available_quantity,
                        l.expiry_date, l.currency, l.unit_cost, l.status`
    }
};

function getTypes() {
    return Object.entries(REPORTS).map(([type, report]) => ({
        type,
        title: report.title,
        columns: report.columns,
        filters: [
            ...Object.keys(report.filters),
            ...(report.search ? ['search'] : []),
            ...(report.date ? ['from', 'to'] : [])
        ]
    }));
}

function addFilter(clauses, params, expression, value, operator = '=') {
    if (!value) return;
    clauses.push(`${expression} ${operator} ?`);
    params.push(operator === 'LIKE' ? `%${value}%` : value);
}

async function getReport(type, filters = {}) {
    if (!Object.prototype.hasOwnProperty.call(REPORTS, type)) return null;
    const report = REPORTS[type];

    const clauses = [];
    const params = [];
    if (report.extraWhere) clauses.push(report.extraWhere);

    for (const key of ['status', 'department', 'location', 'category']) {
        if (!filters[key]) continue;
        if (!report.filters || !report.filters[key]) continue;
        addFilter(clauses, params, report.filters[key], filters[key]);
    }
    if (filters.search && report.search) {
        const search = report.search.map((field) => `${field} LIKE ?`).join(' OR ');
        clauses.push(`(${search})`);
        report.search.forEach(() => params.push(`%${filters.search}%`));
    }
    if ((filters.from || filters.to) && report.date) {
        if (filters.from) {
            addFilter(clauses, params, report.date, filters.from, '>=');
        }
        if (filters.to) {
            if (report.dateTime) {
                clauses.push(`${report.date} < DATE_ADD(?, INTERVAL 1 DAY)`);
                params.push(filters.to);
            } else {
                addFilter(clauses, params, report.date, filters.to, '<=');
            }
        }
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const joins = `${report.from} ${report.join || ''}`;
    const group = report.group || '';
    const [rows] = await db.query(
        `${report.select} ${joins} ${where} ${group} ORDER BY 1 LIMIT 5000`,
        params
    );

    return {
        type,
        title: report.title,
        columns: report.columns.map(([key, label]) => ({ key, label })),
        rows,
        limit: 5000,
        truncated: rows.length === 5000
    };
}

async function getSummary() {
    const queries = [
        `SELECT COUNT(*) AS total,
                SUM(status = 'In Use') AS in_use,
                SUM(status = 'Under Repair') AS under_repair,
                SUM(status = 'Disposed') AS disposed
           FROM assets`,
        `SELECT COUNT(*) AS expiring
           FROM warranties
          WHERE status IN ('Active', 'Expiring Soon')
            AND expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)`,
        `SELECT COUNT(*) AS open
           FROM maintenance_records
          WHERE status IN ('Pending', 'In Progress', 'On Hold')`,
        `SELECT COUNT(*) AS low_stock
           FROM stock_items
          WHERE status = 'Active' AND quantity_on_hand <= minimum_level`,
        `SELECT COUNT(*) AS exceptions
           FROM asset_verification_items
          WHERE result IN ('Missing', 'Damaged', 'Incorrect Location')`,
        `SELECT COUNT(*) AS pending_disposals
           FROM asset_disposals
          WHERE status IN ('Pending Approval', 'Approved')`,
        `SELECT COUNT(*) AS active_licences,
                COALESCE(SUM(l.purchased_quantity), 0) AS purchased_seats,
                COALESCE(SUM(COALESCE(a.allocated, 0)), 0) AS allocated_seats
           FROM software_licences l
           LEFT JOIN (
               SELECT licence_id, SUM(quantity) AS allocated
                 FROM software_licence_allocations
                WHERE status = 'Active'
                GROUP BY licence_id
           ) a ON a.licence_id = l.id
          WHERE l.status = 'Active'`
    ];
    const results = await Promise.all(queries.map((query) => db.query(query)));
    return {
        assets: results[0][0][0],
        warranties: results[1][0][0],
        maintenance: results[2][0][0],
        stock: results[3][0][0],
        verification: results[4][0][0],
        disposals: results[5][0][0],
        licences: results[6][0][0]
    };
}

module.exports = { getTypes, getReport, getSummary };
