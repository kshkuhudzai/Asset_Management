'use strict';

// routes/warrantyRoutes.js
// Warranty and contract monitoring endpoints, mounted at /api/warranties.
//
// Route order matters: literal paths (/stats, /meta, /expiring, /expired,
// /recent, /contracts, /asset/:assetId) must be declared BEFORE the
// parameterised /:id routes, otherwise Express would try to resolve 'stats' as
// a warranty id.
//
// RBAC summary (§9 of the requirements)
//   * Reads (list, stats, meta, expiring, expired, recent, contracts,
//     per-asset coverage, single record) - every authenticated role.
//     Departmental Users are additionally scoped, server-side by the
//     controller, to the assets in their custody; Auditors get read-only
//     oversight of the whole estate.
//   * Recording / correcting / renewing cover - System Administrator, HISO and
//     ICT Officer, who handle supplier contracts as part of their duties.
//   * Cancelling a record - System Administrator and HISO only, as this alters
//     the historical coverage position rather than recording new cover.

const express = require('express');
const warrantyController = require('../controllers/warrantyController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

// Every warranty endpoint requires a valid, active session.
router.use(protect);

/* -------------------------------------------------------------------------- */
/* Summaries & reference data (declared before /:id)                          */
/* -------------------------------------------------------------------------- */

// GET /api/warranties                     - list / search / filter / paginate
router.get('/', warrantyController.getAllWarranties);

// GET /api/warranties/stats               - aggregate warranty figures
router.get(
    '/stats',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR),
    warrantyController.getWarrantyStats
);

// GET /api/warranties/meta                - ENUM choices + pick-lists
router.get(
    '/meta',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    warrantyController.getWarrantyMeta
);

// GET /api/warranties/expiring            - upcoming-expiry alerts (§5.6)
router.get('/expiring', warrantyController.getExpiringWarranties);

// GET /api/warranties/expired             - cover that has already lapsed
router.get('/expired', warrantyController.getExpiredWarranties);

// GET /api/warranties/recent              - latest recordings (dashboard panel)
router.get('/recent', warrantyController.getRecentWarranties);

// GET /api/warranties/contracts           - support & maintenance contracts
router.get('/contracts', warrantyController.getContracts);

/* -------------------------------------------------------------------------- */
/* Per-asset coverage                                                         */
/* -------------------------------------------------------------------------- */

// GET /api/warranties/asset/:assetId      - one asset's complete coverage
router.get('/asset/:assetId', warrantyController.getAssetWarranties);

/* -------------------------------------------------------------------------- */
/* Warranty CRUD                                                              */
/* -------------------------------------------------------------------------- */

// POST /api/warranties                    - record a warranty / contract
router.post(
    '/',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    warrantyController.createWarranty
);

// PATCH /api/warranties/:id/renew         - extend the cover (§5.6)
router.patch(
    '/:id/renew',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    warrantyController.renewWarranty
);

// PATCH /api/warranties/:id/status        - move the lifecycle status
router.patch(
    '/:id/status',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    warrantyController.setWarrantyStatus
);

// PATCH /api/warranties/:id/cancel        - retire a superseded record
router.patch(
    '/:id/cancel',
    authorize(ROLES.ADMIN, ROLES.HISO),
    warrantyController.cancelWarranty
);

// GET /api/warranties/:id                 - fetch one record (id or WAR- ref)
router.get('/:id', warrantyController.getWarrantyById);

// PUT /api/warranties/:id                 - correct the descriptive details
router.put(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    warrantyController.updateWarranty
);

// PATCH /api/warranties/:id               - partial update (same handler as PUT)
router.patch(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    warrantyController.updateWarranty
);

module.exports = router;
