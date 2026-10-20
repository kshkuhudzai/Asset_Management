'use strict';

const express = require('express');
const procurementController = require('../controllers/procurementController');
const procurementModel = require('../models/procurementModel');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();
const readers = authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR);
const receivers = authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER);

router.use(protect);
router.use((req, res, next) => {
    procurementModel.ensureTable().then(() => next(), next);
});

router.get('/', readers, procurementController.listReceipts);
router.get('/:id', readers, procurementController.getReceipt);
router.post('/receive', receivers, procurementController.receive);

module.exports = router;
