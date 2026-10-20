'use strict';

const express = require('express');
const disposalController = require('../controllers/disposalController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();
const READERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR];
const WRITERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER];
const APPROVERS = [ROLES.ADMIN, ROLES.HISO];

router.use(protect);

router.get('/meta', authorize(...WRITERS), disposalController.getMeta);
router.get('/stats', authorize(...READERS), disposalController.getStats);
router.get('/', authorize(...READERS), disposalController.list);
router.post('/', authorize(...WRITERS), disposalController.create);
router.post('/:id/approve', authorize(...APPROVERS), disposalController.approve);
router.post('/:id/reject', authorize(...APPROVERS), disposalController.reject);
router.post('/:id/complete', authorize(...WRITERS), disposalController.complete);
router.get('/:id', authorize(...READERS), disposalController.getById);

module.exports = router;