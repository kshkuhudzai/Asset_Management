'use strict';

const reportModel = require('../models/reportModel');
const { createWorkbook, createPdf } = require('../utils/reportExport');
const { asyncHandler, errorResponse, successResponse } = require('../utils/helpers');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function readFilters(query) {
    const filters = {};
    ['status', 'department', 'location', 'category', 'search', 'from', 'to'].forEach((key) => {
        const value = query[key];
        if (value === undefined || value === '') return;
        if (typeof value !== 'string' || value.length > 100) {
            throw Object.assign(new Error(`Invalid ${key} filter.`), { status: 400 });
        }
        filters[key] = value.trim();
    });

    for (const key of ['from', 'to']) {
        const date = filters[key];
        const parsed = date && new Date(`${date}T00:00:00.000Z`);
        if (date && (!DATE_PATTERN.test(date) || Number.isNaN(parsed.getTime()) ||
            parsed.toISOString().slice(0, 10) !== date)) {
            throw Object.assign(new Error(`The ${key} filter must use YYYY-MM-DD format.`), {
                status: 400
            });
        }
    }

    if (filters.from && filters.to && filters.from > filters.to) {
        throw Object.assign(new Error('The from date must not be after the to date.'), {
            status: 400
        });
    }

    return filters;
}

async function summary(req, res) {
    const data = await reportModel.getSummary();
    res.json(successResponse('Report summary loaded.', data));
}

async function types(req, res) {
    res.json(successResponse('Available reports loaded.', reportModel.getTypes()));
}

async function getReport(req, res) {
    const filters = readFilters(req.query);
    const report = await reportModel.getReport(req.params.type, filters);
    if (!report) {
        return res.status(404).json(errorResponse('The requested report is not available.'));
    }
    return res.json(successResponse('Report loaded.', report));
}

async function exportReport(req, res) {
    const format = req.query.format;
    if (typeof format !== 'string' || !['xlsx', 'pdf'].includes(format)) {
        return res.status(400).json(errorResponse('Export format must be xlsx or pdf.'));
    }

    const filters = readFilters(req.query);
    const report = await reportModel.getReport(req.params.type, filters);
    if (!report) {
        return res.status(404).json(errorResponse('The requested report is not available.'));
    }

    const filename = `${report.type}.${format}`;
    const buffer = format === 'xlsx' ? createWorkbook(report) : await createPdf(report);
    res.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': format === 'xlsx'
            ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            : 'application/pdf',
        'Content-Length': buffer.length
    });
    return res.send(buffer);
}

module.exports = {
    summary: asyncHandler(summary),
    types: asyncHandler(types),
    getReport: asyncHandler(getReport),
    exportReport: asyncHandler(exportReport)
};
