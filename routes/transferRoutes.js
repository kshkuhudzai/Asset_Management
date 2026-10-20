'use strict';

// routes/transferRoutes.js
// Asset transfer endpoints, mounted at /api/transfers.
//
// Route order matters: literal paths (/stats, /meta, /recent, /unacknowledged,
// /user/:userId, /asset/:assetId/...) must be declared BEFORE the
// parameterised /:id routes, otherwise Express would try to resolve 'stats' as
// a transfer id.
//
// RBAC summary (§9 of the requirements)
//   * Reads (list, stats, meta, recent, per-custodian movements, per-asset
//     history) - every authenticated role. Departmental Users are additionally
//     scoped to movements they were part of, server-side, by the controller.
//   * Record a transfer / correct its details / acknowledge receipt -
//     System Administrator, HISO and ICT Officer, who "assign/transfer assets"
//     as part of their day-to-day duties.
//   * Cancel or reverse the record - System Administrator and HISO only, as
//     these alter the movement trail rather than recording a new movement.

const express = require('express');
const transferController = require('../controllers/transferController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

// Every transfer endpoint requires a valid, active session.
router.use(protect);

/* -------------------------------------------------------------------------- */
/* Summaries & reference data (declared before /:id)                          */
/* -------------------------------------------------------------------------- */

// GET /api/transfers                  - list / search / filter / paginate
router.get('/', transferController.getAllTransfers);

// GET /api/transfers/stats            - aggregate movement counts
router.get(
    '/stats',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR),
    transferController.getTransferStats
);

// GET /api/transfers/meta             - ENUM choices + custodian pick-list
router.get(
    '/meta',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    transferController.getTransferMeta
);

// GET /api/transfers/recent           - latest movements (dashboard panel)
router.get('/recent', transferController.getRecentTransfers);

// GET /api/transfers/unacknowledged   - completed but not yet signed for
router.get('/unacknowledged', transferController.getUnacknowledgedTransfers);

/* -------------------------------------------------------------------------- */
/* Per-custodian and per-asset views                                          */
/* -------------------------------------------------------------------------- */

// GET /api/transfers/user/:userId     - a custodian's movements (+ ?direction=)
router.get('/user/:userId', transferController.getTransfersByUser);

// GET /api/transfers/asset/:assetId/history - permanent movement history
router.get('/asset/:assetId/history', transferController.getAssetTransferHistory);

// GET /api/transfers/asset/:assetId/latest  - the asset's last movement
router.get('/asset/:assetId/latest', transferController.getLatestAssetTransfer);

/* -------------------------------------------------------------------------- */
/* Transfer CRUD                                                              */
/* -------------------------------------------------------------------------- */

// POST /api/transfers                 - record an asset transfer
router.post(
    '/',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    transferController.createTransfer
);

// PATCH /api/transfers/:id/acknowledge - receiving party confirms delivery
router.patch(
    '/:id/acknowledge',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    transferController.acknowledgeTransfer
);

// PATCH /api/transfers/:id/approve - an independent officer confirms a pending transfer
router.patch(
    '/:id/approve',
    authorize(ROLES.ADMIN, ROLES.HISO),
    transferController.approveTransfer
);

// PATCH /api/transfers/:id/cancel      - withdraw a mistaken record
router.patch(
    '/:id/cancel',
    authorize(ROLES.ADMIN, ROLES.HISO),
    transferController.cancelTransfer
);

// PATCH /api/transfers/:id/reverse     - reverse a recorded movement
router.patch(
    '/:id/reverse',
    authorize(ROLES.ADMIN, ROLES.HISO),
    transferController.reverseTransfer
);

// GET /api/transfers/:id              - fetch one transfer (id or TRF- ref)
router.get('/:id', transferController.getTransferById);

// PUT /api/transfers/:id              - correct the descriptive details
router.put(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    transferController.updateTransfer
);

// PATCH /api/transfers/:id            - partial update (same handler as PUT)
router.patch(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    transferController.updateTransfer
);

module.exports = router;
