'use strict';

const express = require('express');
const referenceDataController = require('../controllers/referenceDataController');
const referenceDataModel = require('../models/referenceDataModel');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

router.use(protect);
router.use((req, res, next) => {
    referenceDataModel.ensureTables().then(() => next(), next);
});
router.get('/', referenceDataController.list);
router.post('/:type', authorize(ROLES.ADMIN, ROLES.HISO), referenceDataController.create);
router.patch('/:type/:id/status', authorize(ROLES.ADMIN, ROLES.HISO), referenceDataController.setStatus);

module.exports = router;
