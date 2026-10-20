'use strict';

const express = require('express');
const assetDocumentController = require('../controllers/assetDocumentController');
const { uploadAssetDocument } = require('../middleware/assetDocumentUpload');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();
const READERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR];
const WRITERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER];

router.use(protect);
router.get('/:id/documents', authorize(...READERS), assetDocumentController.list);
router.post(
    '/:id/documents',
    authorize(...WRITERS),
    uploadAssetDocument,
    assetDocumentController.upload
);
router.get(
    '/:id/documents/:documentId',
    authorize(...READERS),
    assetDocumentController.download
);
router.delete(
    '/:id/documents/:documentId',
    authorize(...WRITERS),
    assetDocumentController.remove
);

module.exports = router;
