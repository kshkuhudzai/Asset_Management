'use strict';

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { randomUUID } = require('crypto');

const DOCUMENT_DIRECTORY = path.resolve(__dirname, '..', 'uploads', 'asset-documents');
const EXTENSIONS = Object.freeze({
    'application/pdf': ['.pdf'],
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png']
});

fs.mkdirSync(DOCUMENT_DIRECTORY, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: DOCUMENT_DIRECTORY,
        filename(req, file, callback) {
            callback(null, randomUUID());
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    fileFilter(req, file, callback) {
        const extension = path.extname(file.originalname).toLowerCase();
        if (!EXTENSIONS[file.mimetype] || !EXTENSIONS[file.mimetype].includes(extension)) {
            return callback(Object.assign(
                new Error('Only PDF, JPEG, and PNG files are accepted.'),
                { status: 400 }
            ));
        }
        return callback(null, true);
    }
}).single('document');

function uploadAssetDocument(req, res, next) {
    upload(req, res, (error) => {
        if (!error) return next();
        if (error.code === 'LIMIT_FILE_SIZE') {
            error.status = 413;
            error.message = 'Documents must be 10 MB or smaller.';
        } else if (error instanceof multer.MulterError) {
            error.status = 400;
            error.message = 'The upload must contain exactly one document in the document field.';
        }
        return res.status(error.status || 400).json({
            status: 'error',
            message: error.message
        });
    });
}

module.exports = { DOCUMENT_DIRECTORY, uploadAssetDocument };
