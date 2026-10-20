'use strict';

const fs = require('fs');
const path = require('path');
const assetModel = require('../models/assetModel');
const documentModel = require('../models/assetDocumentModel');
const { DOCUMENT_DIRECTORY } = require('../middleware/assetDocumentUpload');
const { auditLog } = require('../middleware/auditMiddleware');
const { getClientIp, successResponse, errorResponse } = require('../utils/helpers');

const SAFE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_SIGNATURES = {
    'application/pdf': (bytes) => bytes.subarray(0, 5).toString('ascii') === '%PDF-',
    'image/jpeg': (bytes) => bytes.length >= 3 &&
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/png': (bytes) => bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
};

async function removeUploadedFile(file) {
    if (!file) return;
    await fs.promises.unlink(path.join(DOCUMENT_DIRECTORY, path.basename(file.filename)));
}

function parsePositiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function list(req, res) {
    const assetId = parsePositiveId(req.params.id);
    if (!assetId) return res.status(400).json(errorResponse('A valid asset id is required.'));
    if (!await assetModel.findById(assetId)) {
        return res.status(404).json(errorResponse('Asset not found.'));
    }
    const documents = await documentModel.findByAsset(assetId);
    return res.json(successResponse('Asset documents retrieved.', { documents }));
}

async function upload(req, res) {
    const assetId = parsePositiveId(req.params.id);
    if (!assetId) {
        await removeUploadedFile(req.file);
        return res.status(400).json(errorResponse('A valid asset id is required.'));
    }
    if (!req.file) return res.status(400).json(errorResponse('Select a document to upload.'));

    if (!await assetModel.findById(assetId)) {
        await removeUploadedFile(req.file);
        return res.status(404).json(errorResponse('Asset not found.'));
    }

    try {
        const handle = await fs.promises.open(req.file.path, 'r');
        let bytes;
        try {
            bytes = Buffer.alloc(8);
            const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
            bytes = bytes.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }

        const signature = FILE_SIGNATURES[req.file.mimetype];
        if (!signature || !signature(bytes)) {
            await removeUploadedFile(req.file);
            return res.status(400).json(errorResponse('The file content does not match its declared type.'));
        }
    } catch (error) {
        await removeUploadedFile(req.file);
        throw error;
    }

    const originalName = req.file.originalname.split(/[\\/]/).pop()
        .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255);
    let document;
    try {
        document = await documentModel.create({
            assetId,
            storedName: path.basename(req.file.filename),
            originalName: originalName || 'document',
            mimeType: req.file.mimetype,
            fileSize: req.file.size,
            uploadedBy: req.user.id
        });
    } catch (error) {
        await removeUploadedFile(req.file);
        throw error;
    }

    await auditLog({
        userId: req.user.id,
        action: 'UPLOAD_DOCUMENT',
        tableName: 'asset_documents',
        recordId: document.id,
        oldValues: null,
        newValues: {
            asset_id: assetId,
            original_name: document.original_name,
            file_size: document.file_size
        },
        ipAddress: getClientIp(req)
    });

    return res.status(201).json(successResponse('Asset document uploaded.', { document }));
}

async function download(req, res) {
    const assetId = parsePositiveId(req.params.id);
    const documentId = parsePositiveId(req.params.documentId);
    if (!assetId || !documentId) {
        return res.status(400).json(errorResponse('Valid asset and document ids are required.'));
    }

    const document = await documentModel.findById(documentId);
    if (!document || Number(document.asset_id) !== assetId) {
        return res.status(404).json(errorResponse('Document not found.'));
    }
    if (!SAFE_NAME.test(document.stored_name)) {
        return res.status(404).json(errorResponse('Document file not found.'));
    }

    const filePath = path.join(DOCUMENT_DIRECTORY, document.stored_name);
    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json(errorResponse('Document file not found.'));
        }
        throw error;
    }

    res.set({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': 'application/octet-stream'
    });
    return res.download(filePath, document.original_name);
}

async function remove(req, res) {
    const assetId = parsePositiveId(req.params.id);
    const documentId = parsePositiveId(req.params.documentId);
    if (!assetId || !documentId) {
        return res.status(400).json(errorResponse('Valid asset and document ids are required.'));
    }

    const document = await documentModel.findById(documentId);
    if (!document || Number(document.asset_id) !== assetId) {
        return res.status(404).json(errorResponse('Document not found.'));
    }
    if (!SAFE_NAME.test(document.stored_name)) {
        return res.status(404).json(errorResponse('Document file not found.'));
    }

    await documentModel.remove(documentId);
    const filePath = path.join(DOCUMENT_DIRECTORY, document.stored_name);
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`Could not remove asset document ${documentId}:`, error.message);
            return res.status(500).json(errorResponse('Document record was removed, but the stored file could not be deleted.'));
        }
    }

    await auditLog({
        userId: req.user.id,
        action: 'DELETE_DOCUMENT',
        tableName: 'asset_documents',
        recordId: documentId,
        oldValues: {
            asset_id: assetId,
            original_name: document.original_name,
            file_size: document.file_size
        },
        newValues: null,
        ipAddress: getClientIp(req)
    });

    return res.json(successResponse('Asset document deleted.'));
}

module.exports = { list, upload, download, remove };
