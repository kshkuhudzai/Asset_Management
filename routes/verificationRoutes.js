'use strict';

const express = require('express');
const verificationController = require('../controllers/verificationController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();
const READERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR];
const WRITERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER];

router.use(protect);

router.get('/meta', authorize(...WRITERS), verificationController.getMeta);
router.get('/', authorize(...READERS), verificationController.list);
router.post('/', authorize(...WRITERS), verificationController.create);
router.get('/:id/exceptions', authorize(...READERS), verificationController.getExceptions);
router.get('/:id', authorize(...READERS), verificationController.getById);
router.patch('/:id/items/:itemId', authorize(...WRITERS), verificationController.updateItem);
router.patch('/:id/complete', authorize(...WRITERS), verificationController.complete);

module.exports = router;