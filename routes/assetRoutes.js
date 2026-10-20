'use strict';

// routes/assetRoutes.js
// Asset register endpoints, mounted at /api/assets.
//
// Route order matters: literal paths (/stats, /meta, /scan, /categories) must
// be declared BEFORE the parameterised /:id routes, otherwise Express would try
// to resolve 'stats' as an asset id.
//
// RBAC summary
//   * Reads (list, view, scan, history, categories, meta) - every
//     authenticated role. Departmental Users may consult the register;
//     Auditors get read-only oversight.
//   * Writes (create, update, QR generation) - System Administrator, HISO and
//     ICT Officer, who perform day-to-day registration and custody changes.
//   * Destructive actions (dispose an asset, delete a category) - System
//     Administrator and HISO only.
//   * Category maintenance (create / rename) - System Administrator and HISO.

const express = require('express');
const assetController = require('../controllers/assetController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

// Every asset endpoint requires a valid, active session.
router.use(protect);

/* -------------------------------------------------------------------------- */
/* Reference data & summaries (declared before /:id)                          */
/* -------------------------------------------------------------------------- */

// GET /api/assets                     - list / search / filter / paginate
router.get('/', assetController.getAllAssets);

// GET /api/assets/stats               - aggregate register counts
router.get(
    '/stats',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR),
    assetController.getAssetStats
);

// GET /api/assets/meta                - ENUM choices, categories, next ids
router.get(
    '/meta',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assetController.getAssetMeta
);

// GET /api/assets/scan/:qrValue       - resolve a scanned QR payload
router.get('/scan/:qrValue', assetController.scanAsset);

router.post(
    '/import',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    express.text({ type: 'text/csv', limit: '2mb' }),
    assetController.importAssets
);

/* -------------------------------------------------------------------------- */
/* Asset categories                                                           */
/* -------------------------------------------------------------------------- */

// GET  /api/assets/categories         - list categories (with asset counts)
router.get('/categories', assetController.getAllCategories);

// GET  /api/assets/categories/:id     - fetch one category
router.get('/categories/:id', assetController.getCategoryById);

// POST /api/assets/categories         - create a category (admin / HISO)
router.post(
    '/categories',
    authorize(ROLES.ADMIN, ROLES.HISO),
    assetController.createCategory
);

// PUT  /api/assets/categories/:id     - rename / re-describe (admin / HISO)
router.put(
    '/categories/:id',
    authorize(ROLES.ADMIN, ROLES.HISO),
    assetController.updateCategory
);

// DELETE /api/assets/categories/:id   - delete an unused category (admin / HISO)
router.delete(
    '/categories/:id',
    authorize(ROLES.ADMIN, ROLES.HISO),
    assetController.deleteCategory
);

/* -------------------------------------------------------------------------- */
/* Asset register CRUD                                                        */
/* -------------------------------------------------------------------------- */

// POST /api/assets                    - register a new asset
router.post(
    '/',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assetController.createAsset
);

// GET /api/assets/:id/history          - audit timeline for one asset
router.get(
    '/:id/history',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.AUDITOR),
    assetController.getAssetHistory
);

// GET /api/assets/:id                  - fetch one asset (numeric id, asset_id or tag)
router.get('/:id', assetController.getAssetById);

// PUT /api/assets/:id                  - full update
router.put(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assetController.updateAsset
);

// PATCH /api/assets/:id                - partial update (same handler as PUT)
router.patch(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assetController.updateAsset
);

// POST /api/assets/:id/qr              - (re)generate the asset's QR value
router.post(
    '/:id/qr',
    authorize(ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER),
    assetController.regenerateAssetQr
);

// DELETE /api/assets/:id               - disabled; disposal must use the approval workflow
router.delete(
    '/:id',
    authorize(ROLES.ADMIN, ROLES.HISO),
    assetController.deleteAsset
);

module.exports = router;
