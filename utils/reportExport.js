'use strict';

const path = require('path');
const fs = require('fs');
const { zipSync, strToU8 } = require('fflate');
const PDFDocument = require('pdfkit');

function xmlEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
    })[character]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function columnName(number) {
    let result = '';
    while (number > 0) {
        const remainder = (number - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        number = Math.floor((number - 1) / 26);
    }
    return result;
}

function worksheetCell(reference, value, style) {
    return `<c r="${reference}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

function createWorkbook(report) {
    const sheetRows = [report.columns.map((column) => column.label)];
    for (const row of report.rows) {
        sheetRows.push(report.columns.map((column) => row[column.key]));
    }
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${sheetRows.map((values, rowIndex) => `<row r="${rowIndex + 1}">${values.map((value, columnIndex) => worksheetCell(`${columnName(columnIndex + 1)}${rowIndex + 1}`, value, rowIndex === 0 ? 1 : 0)).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${columnName(report.columns.length)}${sheetRows.length}"/></worksheet>`;
    const files = {
        '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
        '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
        'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>'),
        'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
        'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'),
        'xl/worksheets/sheet1.xml': strToU8(sheetXml)
    };
    return Buffer.from(zipSync(files, { level: 6 }));
}

/**
 * Calculates responsive column widths for an A4 Landscape table (printable width: ~770pt)
 */
function calculateColumnWidths(columns, totalWidth) {
    const colCount = columns.length;
    // Default base weights
    const weights = columns.map((col) => {
        const key = col.key.toLowerCase();
        const label = col.label.toLowerCase();
        if (key.includes('ref') || key.includes('tag') || key.includes('id')) return 1.1;
        if (key.includes('date') || key.includes('time')) return 0.95;
        if (key.includes('cost') || key.includes('quantity') || key.includes('balance') || key.includes('seats')) return 0.85;
        if (key.includes('status') || key.includes('condition') || key.includes('priority')) return 0.9;
        if (label.includes('description') || label.includes('software') || label.includes('item') || label.includes('reason') || label.includes('coverage')) return 1.8;
        if (key.includes('department') || key.includes('location') || key.includes('vendor') || key.includes('provider')) return 1.25;
        return 1.0;
    });

    const sumWeights = weights.reduce((acc, w) => acc + w, 0);
    let assigned = weights.map((w) => Math.floor((w / sumWeights) * totalWidth));
    const currentSum = assigned.reduce((acc, w) => acc + w, 0);
    // Distribute remainder
    const diff = totalWidth - currentSum;
    if (assigned.length > 0) {
        assigned[assigned.length - 1] += diff;
    }
    return assigned;
}

function formatCell(val) {
    if (val === null || val === undefined || val === '') return '-';
    if (typeof val === 'number') {
        return Number.isInteger(val) ? String(val) : val.toFixed(2);
    }
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
        return str.slice(0, 10);
    }
    return str;
}

function createPdf(report) {
    return new Promise((resolve, reject) => {
        const margin = 32;
        const doc = new PDFDocument({
            size: 'A4',
            layout: 'landscape',
            margin,
            bufferPages: true
        });

        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('error', reject);
        doc.on('end', () => {
            // Add page numbers
            const range = doc.bufferedPageRange();
            for (let i = range.start; i < range.start + range.count; i++) {
                doc.switchToPage(i);
                doc.font('Helvetica').fontSize(7.5).fillColor('#64748b');
                doc.text(
                    `Page ${i + 1} of ${range.count}`,
                    doc.page.width - margin - 120,
                    doc.page.height - margin + 12,
                    { width: 120, align: 'right' }
                );
            }
            resolve(Buffer.concat(chunks));
        });

        const pageWidth = doc.page.width;
        const pageHeight = doc.page.height;
        const printableWidth = pageWidth - (margin * 2);
        const logoPath = path.join(__dirname, '../public/images/nbsz-logo.jpg');
        const hasLogo = fs.existsSync(logoPath);

        function drawReportHeader(isFirstPage) {
            // Top red accent bar
            doc.rect(margin, margin - 10, printableWidth, 3.5).fill('#ba1a1a');

            let headerY = margin + 4;
            let textStartX = margin;

            if (hasLogo && isFirstPage) {
                try {
                    doc.image(logoPath, margin, headerY, { width: 52, height: 44, fit: [52, 44] });
                    textStartX = margin + 62;
                } catch {
                    // fallback if image fails
                }
            }

            if (isFirstPage) {
                // Main Header
                doc.font('Helvetica-Bold').fontSize(13.5).fillColor('#0f2942')
                    .text('NATIONAL BLOOD SERVICE ZIMBABWE', textStartX, headerY);
                doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ba1a1a')
                    .text('ICT ASSET MANAGEMENT & AUDIT SYSTEM', textStartX, headerY + 16);
                doc.font('Helvetica-Bold').fontSize(11).fillColor('#1e3a5f')
                    .text(report.title.toUpperCase(), textStartX, headerY + 28);

                // Meta box on top right
                const metaX = pageWidth - margin - 200;
                doc.rect(metaX, headerY, 200, 42).fillAndStroke('#f8fafc', '#e2e8f0');
                doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#475569')
                    .text('REPORT GENERATION METADATA', metaX + 8, headerY + 6);
                doc.font('Helvetica').fontSize(7.5).fillColor('#334155')
                    .text(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`, metaX + 8, headerY + 17)
                    .text(`Records Found: ${report.rows.length} row(s)`, metaX + 8, headerY + 28);

                doc.y = headerY + 52;

                // KPI summary bar
                const kpiWidth = (printableWidth - 24) / 3;
                const kpiY = doc.y;
                doc.rect(margin, kpiY, kpiWidth, 26).fillAndStroke('#f1f5f9', '#cbd5e1');
                doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text('TOTAL ENTRIES', margin + 8, kpiY + 4);
                doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f2942').text(String(report.rows.length), margin + 8, kpiY + 13);

                doc.rect(margin + kpiWidth + 12, kpiY, kpiWidth, 26).fillAndStroke('#f1f5f9', '#cbd5e1');
                doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text('DATA CLASSIFICATION', margin + kpiWidth + 20, kpiY + 4);
                doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f2942').text('Official NBSZ Register', margin + kpiWidth + 20, kpiY + 14);

                doc.rect(margin + (kpiWidth * 2) + 24, kpiY, kpiWidth, 26).fillAndStroke('#f1f5f9', '#cbd5e1');
                doc.font('Helvetica').fontSize(7.5).fillColor('#64748b').text('STATUS', margin + (kpiWidth * 2) + 32, kpiY + 4);
                doc.font('Helvetica-Bold').fontSize(9).fillColor('#166534').text('Active & Verified', margin + (kpiWidth * 2) + 32, kpiY + 14);

                doc.y = kpiY + 36;
            } else {
                // Secondary page concise running header
                doc.font('Helvetica-Bold').fontSize(9).fillColor('#0f2942')
                    .text(`National Blood Service Zimbabwe — ${report.title}`, margin, headerY);
                doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
                    .text(`Extracted ${new Date().toISOString().slice(0, 10)}`, pageWidth - margin - 150, headerY, { width: 150, align: 'right' });
                doc.y = headerY + 16;
            }
        }

        function drawFooter() {
            const footerY = pageHeight - margin + 12;
            doc.strokeColor('#cbd5e1').lineWidth(0.5)
                .moveTo(margin, footerY - 4)
                .lineTo(pageWidth - margin, footerY - 4)
                .stroke();
            doc.font('Helvetica').fontSize(7.5).fillColor('#64748b')
                .text('Confidential — National Blood Service Zimbabwe • Internal ICT Audit Document', margin, footerY);
        }

        const colWidths = calculateColumnWidths(report.columns, printableWidth);
        const headerHeight = 18;
        const rowHeight = 16;

        function drawTableHeaders(tableY) {
            // Header bar background
            doc.rect(margin, tableY, printableWidth, headerHeight).fill('#0f2942');

            let curX = margin;
            report.columns.forEach((col, idx) => {
                const w = colWidths[idx];
                doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff')
                    .text(col.label.toUpperCase(), curX + 4, tableY + 5, {
                        width: w - 8,
                        lineBreak: false,
                        ellipsis: true
                    });
                curX += w;
            });
            return tableY + headerHeight;
        }

        // Draw First Page Header
        drawReportHeader(true);
        drawFooter();

        let currentY = doc.y;
        currentY = drawTableHeaders(currentY);

        if (!report.rows.length) {
            doc.rect(margin, currentY, printableWidth, 32).fillAndStroke('#f8fafc', '#e2e8f0');
            doc.font('Helvetica').fontSize(9).fillColor('#64748b')
                .text('No matching records were found for the selected criteria.', margin + 10, currentY + 11);
        } else {
            report.rows.forEach((row, rowIndex) => {
                // Check if page break is needed
                if (currentY + rowHeight > pageHeight - margin - 20) {
                    doc.addPage();
                    drawReportHeader(false);
                    drawFooter();
                    currentY = drawTableHeaders(doc.y);
                }

                // Row background (zebra stripe)
                const isEven = rowIndex % 2 === 0;
                const bgColor = isEven ? '#ffffff' : '#f8fafc';
                doc.rect(margin, currentY, printableWidth, rowHeight).fill(bgColor);

                // Row border bottom
                doc.strokeColor('#f1f5f9').lineWidth(0.5)
                    .moveTo(margin, currentY + rowHeight)
                    .lineTo(margin + printableWidth, currentY + rowHeight)
                    .stroke();

                let curX = margin;
                report.columns.forEach((col, colIdx) => {
                    const w = colWidths[colIdx];
                    const val = formatCell(row[col.key]);
                    const key = col.key.toLowerCase();
                    const isNum = key.includes('cost') || key.includes('quantity') || key.includes('balance') || key.includes('seats');

                    doc.font('Helvetica').fontSize(7).fillColor('#1e293b')
                        .text(val, curX + 4, currentY + 4, {
                            width: w - 8,
                            lineBreak: false,
                            ellipsis: true,
                            align: isNum ? 'right' : 'left'
                        });
                    curX += w;
                });

                currentY += rowHeight;
            });

            // Outer bottom border of table
            doc.strokeColor('#cbd5e1').lineWidth(1)
                .moveTo(margin, currentY)
                .lineTo(margin + printableWidth, currentY)
                .stroke();
        }

        doc.end();
    });
}

module.exports = { createWorkbook, createPdf };
