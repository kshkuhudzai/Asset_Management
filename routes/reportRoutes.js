'use strict';

const express = require('express');
const reportController = require('../controllers/reportController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

router.use(protect, authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR));
router.get('/summary', reportController.summary);
router.get('/types', reportController.types);
router.get('/:type/export', reportController.exportReport);
router.get('/:type', reportController.getReport);

module.exports = router;