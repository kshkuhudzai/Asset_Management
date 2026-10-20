'use strict';

const m = require('../models/barcodeModel');
const keys = Object.keys(m);
console.log('EXPORT COUNT: ' + keys.length);
console.log('KEYS: ' + keys.join(', '));
console.log('LABEL_TABLE_DDL is string: ' + (typeof m.LABEL_TABLE_DDL === 'string'));
console.log('SCAN_TABLE_DDL is string: ' + (typeof m.SCAN_TABLE_DDL === 'string'));
console.log('DDL has asset_barcode_labels: ' + m.LABEL_TABLE_DDL.includes('asset_barcode_labels'));
console.log('DDL has asset_scan_events: ' + m.SCAN_TABLE_DDL.includes('asset_scan_events'));
console.log('all functions exported: ' + [
    'ensureTable', 'nextLabelRef', 'nextScanRef', 'createLabel', 'findLabel',
    'findPrimaryLabelForAsset', 'findLabelsForAsset', 'findCodeOwner',
    'findAllLabels', 'updateLabel', 'recordPrint', 'retireLabelsForAsset',
    'createScanEvent', 'findAssetByCode', 'findAllScans', 'findScan'
].every((k) => typeof m[k] === 'function'));

// The db pool keeps the event loop alive; this is a one-shot check.
process.exit(0);

