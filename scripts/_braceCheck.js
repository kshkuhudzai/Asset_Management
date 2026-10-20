'use strict';

// Reports where the brace depth returns to 0 across the file, so a stray
// opening brace that swallows module.exports can be located precisely.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'controllers', 'barcodeController.js');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

let depth = 0;
let inBlockComment = false;
const zeroPoints = [];

lines.forEach((line, i) => {
    const lineNo = i + 1;
    let code = line;

    // Strip block comments so braces inside JSDoc do not skew the count.
    if (inBlockComment) {
        const end = code.indexOf('*/');
        if (end === -1) return;
        code = code.slice(end + 2);
        inBlockComment = false;
    }
    const start = code.indexOf('/*');
    if (start !== -1 && code.indexOf('*/', start) === -1) {
        inBlockComment = true;
        code = code.slice(0, start);
    }
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    code = code.replace(/\/\/.*$/, '');
    code = code.replace(/`[^`]*`/g, '``');
    code = code.replace(/'[^']*'/g, "''");
    code = code.replace(/"[^"]*"/g, '""');

    for (const ch of code) {
        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;
    }

    if (depth === 0 && /^(async )?function |^module\.exports|^const |^\/\*/.test(line.trim()) === false) {
        zeroPoints.push(lineNo);
    }
});

console.log('FINAL DEPTH: ' + depth);
console.log('LINE COUNT: ' + lines.length);

// Show the depth at each declared top-level function so a nesting bug is visible.
let d = 0;
let inComment = false;
lines.forEach((line, i) => {
    let code = line;
    if (inComment) {
        const end = code.indexOf('*/');
        if (end === -1) return;
        code = code.slice(end + 2);
        inComment = false;
    }
    const s = code.indexOf('/*');
    if (s !== -1 && code.indexOf('*/', s) === -1) {
        inComment = true;
        code = code.slice(0, s);
    }
    code = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '');
    code = code.replace(/`[^`]*`/g, '``').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');

    if (/^(async )?function [a-zA-Z]/.test(line) || /^module\.exports/.test(line)) {
        console.log(`depth ${d} at line ${i + 1}: ${line.trim().slice(0, 60)}`);
    }

    for (const ch of code) {
        if (ch === '{') d += 1;
        if (ch === '}') d -= 1;
    }
});

process.exit(0);
