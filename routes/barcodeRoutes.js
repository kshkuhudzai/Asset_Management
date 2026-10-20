'use strict';

// routes/barcodeRoutes.js
// QR Code / Barcode Management endpoints, mounted at /api/barcode.
// Section 5.8 & Section 10 of the requirements.
//
// Route order matters: literal paths (/stats, /meta, /coverage, /lookup,
// /scan, /scans, /generate, /asset/:assetId, /label/:id/replace) must be
// declared BEFORE the parameterised /:id routes, otherwise Express would try
// to resolve 'stats' or 'meta' as a label id.
//
// RBAC summary:
//   * Reads (register, stats, coverage, scan history, label lookup):
//     System Administrator, HISO, ICT Officer, Auditor.
//   * Mutating actions (minting codes, bulk generation, recording prints,
//     retiring & replacing labels, editing label details):
//     System Administrator, HISO, ICT Officer.
//   * Departmental users can scan to identify assets in their custody.

const express = require('express');
const barcodeController = require('../controllers/barcodeController');
const { protect } = require('../middleware/authMiddleware');
const { authorize, ROLES } = require('../middleware/rbacMiddleware');

const router = express.Router();

// Every barcode endpoint requires a valid, authenticated session.
router.use(protect);

const READERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER, ROLES.AUDITOR];
const WRITERS = [ROLES.ADMIN, ROLES.HISO, ROLES.ICT_OFFICER];

/* -------------------------------------------------------------------------- */
/* Reference & Aggregate endpoints (declared before /:id)                     */
/* -------------------------------------------------------------------------- */

// GET /api/barcode/stats                 - label coverage & scan figures
router.get('/stats', authorize(...READERS), barcodeController.getBarcodeStats);

// GET /api/barcode/meta                  - ENUM choices + pick-lists
router.get('/meta', authorize(...READERS), barcodeController.getBarcodeMeta);

// GET /api/barcode/coverage              - assets still needing a code
router.get('/coverage', authorize(...READERS), barcodeController.getBarcodeCoverage);

/* -------------------------------------------------------------------------- */
/* Scanning endpoints                                                         */
/* -------------------------------------------------------------------------- */

// GET  /api/barcode/lookup/:code         - resolve code without logging scan event
router.get('/lookup/:code', barcodeController.lookupCode);

// POST /api/barcode/scan                 - resolve code and append to asset_scan_events
router.post('/scan', barcodeController.scanCode);

// GET  /api/barcode/scans                - scan history with filters & pagination
router.get('/scans', authorize(...READERS), barcodeController.getScanEvents);

// GET  /api/barcode/scans/:id            - fetch one scan event by id or SCN- ref
router.get('/scans/:id', authorize(...READERS), barcodeController.getScanEventById);

/* -------------------------------------------------------------------------- */
/* Asset-specific Barcode Actions                                             */
/* -------------------------------------------------------------------------- */

// GET  /api/barcode/asset/:assetId       - get asset's active label + scan history
router.get('/asset/:assetId', authorize(...READERS), barcodeController.getAssetLabel);

// POST /api/barcode/asset/:assetId/generate - mint a code for one asset
router.post('/asset/:assetId/generate', authorize(...WRITERS), barcodeController.generateAssetCode);

// POST /api/barcode/asset/:assetId/print    - record a print run & get printable card
router.post('/asset/:assetId/print', authorize(...WRITERS), barcodeController.recordLabelPrint);

/* -------------------------------------------------------------------------- */
/* Generation & Replacement                                                   */
/* -------------------------------------------------------------------------- */

// POST /api/barcode/generate             - bulk mint codes for multiple assets
router.post('/generate', authorize(...WRITERS), barcodeController.generateBulkCodes);

// POST /api/barcode/label/:id/replace    - retire damaged/lost label & issue new code
router.post('/label/:id/replace', authorize(...WRITERS), barcodeController.replaceLabel);

/* -------------------------------------------------------------------------- */
/* Label Register CRUD                                                        */
/* -------------------------------------------------------------------------- */

// GET   /api/barcode                     - list / search / filter labels
router.get('/', authorize(...READERS), barcodeController.getAllLabels);

// GET   /api/barcode/:id                 - fetch one label by id or LBL- ref
router.get('/:id', authorize(...READERS), barcodeController.getLabelById);

// PUT   /api/barcode/:id                 - update label details (condition, notes, etc.)
router.put('/:id', authorize(...WRITERS), barcodeController.updateLabel);

// PATCH /api/barcode/:id                 - partial update (same handler)
router.patch('/:id', authorize(...WRITERS), barcodeController.updateLabel);

module.exports = router;
