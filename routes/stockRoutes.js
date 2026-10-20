'use strict';

// routes/stockRoutes.js
// ICT Stock / Store endpoints, mounted at /api/stock.
//
// Route order matters: literal paths (/stats, /meta, /balances, /low-stock,
// /movements/recent, /movements/:id, /asset/:assetId) must be declared BEFORE the
// parameterised /:id routes, otherwise Express would try to resolve 'stats' as a
// stock item id.
//
// RBAC summary (§9 of the requirements)
//   * Reads (list, stats, balances, low stock, movement history, per-asset
//     position, single record) - every authenticated role. Departmental Users
//     are additionally scoped, server-side by the controller, to the assets in
//     their custody; Auditors get read-only oversight of the whole store.
//   * Opening a store card and recording receipt / issue / return - System
//     Administrator, HISO and ICT Officer, who run the store as part of their
//     duties.
//   * Adjusting a balance, writing stock off and reversing a movement - System
//     Administrator and HISO only, because these alter the record of what is
//     physically on hand rather than recording a normal transaction.

const express = require('express');
const stockController = require('../controllers/stockController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

// Every stock endpoint requires a valid, active session.
router.use(protect);

/* -------------------------------------------------------------------------- */
/* Summaries & reference data (declared before /:id)                          */
/* -------------------------------------------------------------------------- */

// GET /api/stock                          - list / search / filter / paginate
router.get('/', stockController.getAllStockItems);

// GET /api/stock/stats                    - aggregate stock figures
router.get(
    '/stats',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR),
    stockController.getStockStats
);

// GET /api/stock/meta                     - ENUM choices + pick-lists
router.get(
    '/meta',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    stockController.getStockMeta
);

// GET /api/stock/balances                 - stock balances (§5.7)
router.get(
    '/balances',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR),
    stockController.getStockBalances
);

// GET /api/stock/low-stock                - replenishment list (§5.7)
router.get('/low-stock', stockController.getLowStock);

/* -------------------------------------------------------------------------- */
/* Movement history (§5.7)                                                    */
/* -------------------------------------------------------------------------- */

// GET /api/stock/movements                - the ledger, filtered / paged
router.get('/movements', stockController.getMovements);

// GET /api/stock/movements/recent         - latest movements (dashboard panel)
router.get(
    '/movements/recent',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR),
    stockController.getRecentMovements
);

// POST /api/stock/movements/:id/reverse   - reverse a movement (§11)
router.post(
    '/movements/:id/reverse',
    authorize(ROLES.ADMIN, ROLES.HISO),
    stockController.reverseStockMovement
);

// GET /api/stock/movements/:id            - one ledger entry
router.get('/movements/:id', stockController.getMovementById);

/* -------------------------------------------------------------------------- */
/* Per-asset position                                                         */
/* -------------------------------------------------------------------------- */

// GET /api/stock/asset/:assetId           - one asset's card + full history
router.get('/asset/:assetId', stockController.getAssetStock);

/* -------------------------------------------------------------------------- */
/* Store cards                                                                */
/* -------------------------------------------------------------------------- */

// POST /api/stock                         - open a store card
router.post(
    '/',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    stockController.createStockItem
);

// POST /api/stock/:id/receipt             - record stock received (§5.7)
router.post(
    '/:id/receipt',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    stockController.receiveStock
);

// POST /api/stock/:id/issue               - record stock issued out (§5.7)
router.post(
    '/:id/issue',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    stockController.issueStock
);

// POST /api/stock/:id/return              - record stock returned (§5.7)
router.post(
    '/:id/return',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    stockController.returnStock
);

// POST /api/stock/:id/adjust              - correct a balance / write off
router.post(
    '/:id/adjust',
    authorize(ROLES.ADMIN, ROLES.HISO),
    stockController.adjustStock
);

// GET /api/stock/:id                      - fetch one card (id, STK- ref,
//                                           or the derived asset-<id>)
router.get('/:id', stockController.getStockItemById);

// PUT /api/stock/:id                      - correct the catalogue details
router.put(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    stockController.updateStockItem
);

// PATCH /api/stock/:id                    - partial update (same handler as PUT)
router.patch(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    stockController.updateStockItem
);

module.exports = router;
