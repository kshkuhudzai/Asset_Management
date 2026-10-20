'use strict';

// routes/maintenanceRoutes.js
// Maintenance and repair endpoints, mounted at /api/maintenance.
//
// Route order matters: literal paths (/stats, /meta, /recent, /open, /overdue,
// /asset/:assetId/..., /user/:userId) must be declared BEFORE the
// parameterised /:id routes, otherwise Express would try to resolve 'stats' as
// a maintenance id.
//
// RBAC summary (§9 of the requirements)
//   * Reads (list, stats, meta, recent, open, overdue, per-asset history,
//     per-asset open jobs, per-user reports) - every authenticated role.
//     Departmental Users are additionally scoped to the faults they reported,
//     server-side, by the controller.
//   * Report a fault / correct its details / advance the workflow - System
//     Administrator, HISO and ICT Officer, who handle repairs as part of their
//     day-to-day duties.
//   * Cancel a record - System Administrator and HISO only, as this alters the
//     maintenance trail rather than recording new work.

const express = require('express');
const maintenanceController = require('../controllers/maintenanceController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

// Every maintenance endpoint requires a valid, active session.
router.use(protect);

/* -------------------------------------------------------------------------- */
/* Summaries & reference data (declared before /:id)                          */
/* -------------------------------------------------------------------------- */

// GET /api/maintenance                - list / search / filter / paginate
router.get('/', maintenanceController.getAllMaintenance);

// GET /api/maintenance/stats          - aggregate maintenance figures
router.get(
    '/stats',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR),
    maintenanceController.getMaintenanceStats
);

// GET /api/maintenance/meta           - ENUM choices + pick-lists
router.get(
    '/meta',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    maintenanceController.getMaintenanceMeta
);

// GET /api/maintenance/recent         - latest reported faults (dashboard panel)
router.get('/recent', maintenanceController.getRecentMaintenance);

// GET /api/maintenance/open           - assets currently under repair (§5.5)
router.get('/open', maintenanceController.getOpenMaintenance);

// GET /api/maintenance/overdue        - open jobs past their scheduled date
router.get('/overdue', maintenanceController.getOverdueMaintenance);

/* -------------------------------------------------------------------------- */
/* Per-asset and per-user views                                               */
/* -------------------------------------------------------------------------- */

// GET /api/maintenance/asset/:assetId/history - the asset's repair history
router.get('/asset/:assetId/history', maintenanceController.getAssetMaintenanceHistory);

// GET /api/maintenance/asset/:assetId/open    - the asset's open jobs
router.get('/asset/:assetId/open', maintenanceController.getAssetOpenMaintenance);

// GET /api/maintenance/user/:userId           - faults raised by one user
router.get('/user/:userId', maintenanceController.getMaintenanceByUser);

/* -------------------------------------------------------------------------- */
/* Maintenance CRUD                                                           */
/* -------------------------------------------------------------------------- */

// POST /api/maintenance               - report a fault / book a service
router.post(
    '/',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    maintenanceController.createMaintenance
);

// PATCH /api/maintenance/:id/start    - begin the work
router.patch(
    '/:id/start',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    maintenanceController.startMaintenance
);

// PATCH /api/maintenance/:id/complete - finish the job
router.patch(
    '/:id/complete',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    maintenanceController.completeMaintenance
);

// PATCH /api/maintenance/:id/status   - move to any valid workflow status
router.patch(
    '/:id/status',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    maintenanceController.setMaintenanceStatus
);

// PATCH /api/maintenance/:id/cancel   - withdraw a mistaken record
router.patch(
    '/:id/cancel',
    authorize(ROLES.ADMIN, ROLES.HISO),
    maintenanceController.cancelMaintenance
);

// GET /api/maintenance/:id            - fetch one record (id or MNT- ref)
router.get('/:id', maintenanceController.getMaintenanceById);

// PUT /api/maintenance/:id            - correct the descriptive details
router.put(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    maintenanceController.updateMaintenance
);

// PATCH /api/maintenance/:id          - partial update (same handler as PUT)
router.patch(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    maintenanceController.updateMaintenance
);

module.exports = router;
