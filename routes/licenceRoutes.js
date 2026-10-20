'use strict';

const express = require('express');
const licenceController = require('../controllers/licenceController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();
const READERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR];
const WRITERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER];

router.use(protect);

router.get('/meta', authorize(...WRITERS), licenceController.getMeta);
router.get('/stats', authorize(...READERS), licenceController.stats);
router.get('/expiring', authorize(...READERS), licenceController.expiring);
router.get('/', authorize(...READERS), licenceController.list);
router.post('/', authorize(...WRITERS), licenceController.create);
router.get('/:id', authorize(...READERS), licenceController.getById);
router.put('/:id', authorize(...WRITERS), licenceController.update);
router.patch('/:id', authorize(...WRITERS), licenceController.update);
router.patch('/:id/status', authorize(...WRITERS), licenceController.setStatus);
router.post('/:id/allocations', authorize(...WRITERS), licenceController.allocate);
router.post('/:id/allocations/:allocationId/release', authorize(...WRITERS), licenceController.release);

module.exports = router;