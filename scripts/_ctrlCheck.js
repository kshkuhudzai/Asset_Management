'use strict';

const c = require('../controllers/barcodeController');
const keys = Object.keys(c);
console.log('CONTROLLER EXPORTS: ' + keys.length);
console.log('KEYS: ' + keys.join(', '));
const fns = [
    'getBarcodeMeta', 'getBarcodeStats', 'getBarcodeCoverage',
    'getAllLabels', 'getLabelById', 'getAssetLabel', 'updateLabel',
    'generateAssetCode', 'generateBulkCodes', 'recordLabelPrint', 'replaceLabel',
    'lookupCode', 'scanCode', 'getScanEvents', 'getScanEventById'
];
console.log('ALL HANDLERS PRESENT: ' + fns.every((k) => typeof c[k] === 'function'));
console.log('SAMPLE CODE: ' + c.generateCodeValue());
console.log('CODE PREFIX OK: ' + /^NBSZ-[0-9A-F]{8}$/.test(c.generateCodeValue()));
console.log('CODE TYPES: ' + c.CODE_TYPES.join('|'));
console.log('LABEL STATUSES: ' + c.LABEL_STATUSES.join('|'));
console.log('SCAN RESULTS: ' + c.SCAN_RESULTS.join('|'));
process.exit(0);
