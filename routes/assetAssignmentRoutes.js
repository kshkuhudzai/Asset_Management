'use strict';

// routes/assetAssignmentRoutes.js
// Asset assignment and custody endpoints, mounted at /api/assignments.
//
// Route order matters: literal paths (/stats, /meta, /active, /overdue,
// /pending, /user/:userId, /asset/:assetId) must be declared BEFORE the
// parameterised /:id routes, otherwise Express would try to resolve 'stats' as
// an assignment id.
//
// RBAC summary (§9 of the requirements)
//   * Reads (list, stats, meta, per-asset history, per-custodian holdings) -
//     every authenticated role. Departmental Users are additionally scoped to
//     their own holdings server-side by the controller.
//   * Assign / return / transfer - System Administrator, HISO and ICT Officer,
//     who "assign/transfer assets" as part of their day-to-day duties.
//   * Acknowledge receipt - the custodian themself, or Administrator / HISO.
//     Not role-restricted here because the controller must compare the caller
//     with the assignment's custodian.
//   * Cancel a mistaken assignment - System Administrator and HISO only, as it
//     corrects the record rather than recording a custody event.

const express = require('express');
const assignmentController = require('../controllers/assetAssignmentController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

// Every assignment endpoint requires a valid, active session.
router.use(protect);

/* -------------------------------------------------------------------------- */
/* Summaries & reference data (declared before /:id)                          */
/* -------------------------------------------------------------------------- */

// GET /api/assignments                - list / search / filter / paginate
router.get('/', assignmentController.getAllAssignments);

// GET /api/assignments/stats          - aggregate custody counts
router.get(
    '/stats',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR),
    assignmentController.getAssignmentStats
);

// GET /api/assignments/meta           - status ENUM + custodian pick-list
router.get(
    '/meta',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assignmentController.getAssignmentMeta
);

// GET /api/assignments/active         - every asset currently held
router.get('/active', assignmentController.getActiveAssignments);

// GET /api/assignments/overdue        - open assignments past their return date
router.get('/overdue', assignmentController.getOverdueAssignments);

// GET /api/assignments/pending        - open but not yet acknowledged
router.get('/pending', assignmentController.getPendingAcknowledgements);

/* -------------------------------------------------------------------------- */
/* Per-custodian and per-asset views                                          */
/* -------------------------------------------------------------------------- */

// GET /api/assignments/user/:userId        - a custodian's holdings
router.get('/user/:userId', assignmentController.getAssignmentsByUser);

// GET /api/assignments/user/:userId/active - a custodian's current holdings
router.get(
    '/user/:userId/active',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR, ROLES.DEPARTMENTAL_USER),
    assignmentController.getAssignmentsByUser
);

// GET /api/assignments/asset/:assetId/history - full custody history
router.get('/asset/:assetId/history', assignmentController.getAssetAssignmentHistory);

// GET /api/assignments/asset/:assetId      - the asset's current custody
router.get('/asset/:assetId', assignmentController.getAssetAssignment);

/* -------------------------------------------------------------------------- */
/* Assignment CRUD                                                            */
/* -------------------------------------------------------------------------- */

// POST /api/assignments               - assign an asset to a custodian
router.post(
    '/',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assignmentController.createAssignment
);

// PATCH /api/assignments/:id/acknowledge - confirm receipt of an asset
// (role check lives in the controller: custodian, Administrator or HISO)
router.patch('/:id/acknowledge', assignmentController.acknowledgeAssignment);

// PATCH /api/assignments/:id/return      - close custody, asset back to stores
router.patch(
    '/:id/return',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assignmentController.returnAssignment
);

// PATCH /api/assignments/:id/transfer    - hand over, history preserved
router.patch(
    '/:id/transfer',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assignmentController.transferAssignment
);

// PATCH /api/assignments/:id/cancel      - withdraw a mistaken assignment
router.patch(
    '/:id/cancel',
    authorize(ROLES.ADMIN, ROLES.HISO),
    assignmentController.cancelAssignment
);

// GET /api/assignments/:id            - fetch one assignment
router.get('/:id', assignmentController.getAssignmentById);

// PUT /api/assignments/:id            - correct the details of one
router.put(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assignmentController.updateAssignment
);

// PATCH /api/assignments/:id          - partial update (same handler as PUT)
router.patch(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assignmentController.updateAssignment
);

module.exports = router;
