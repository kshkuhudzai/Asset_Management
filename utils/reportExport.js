'use strict';

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

function createPdf(report) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        doc.font('Helvetica-Bold').fontSize(18).fillColor('#17365d').text(report.title);
        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(9).fillColor('#555555')
            .text(`Generated ${new Date().toISOString()} | ${report.rows.length} records`);
        doc.moveDown();

        const fieldsPerLine = report.columns.length > 8 ? 4 : 3;
        report.rows.forEach((row, index) => {
            if (doc.y + 60 > doc.page.height - doc.page.margins.bottom) doc.addPage();
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#17365d')
                .text(`${index + 1}. ${String(row[report.columns[0].key] ?? '').slice(0, 120)}`, {
                    width: 760,
                    lineBreak: false,
                    ellipsis: true
                });
            doc.moveDown(0.25);

            for (let offset = 1; offset < report.columns.length; offset += fieldsPerLine) {
                const fields = report.columns.slice(offset, offset + fieldsPerLine).map((column) => {
                    const value = String(row[column.key] ?? '').replace(/\s+/g, ' ').slice(0, 120);
                    return `${column.label}: ${value || '-'}`;
                });
                doc.font('Helvetica').fontSize(8).fillColor('#222222')
                    .text(fields.join('   |   '), { width: 760, lineGap: 1 });
            }
            doc.moveDown(0.4);
            if (doc.y < doc.page.height - doc.page.margins.bottom) {
                doc.strokeColor('#d9e0e8')
                    .moveTo(doc.page.margins.left, doc.y)
                    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
                    .stroke();
                doc.moveDown(0.5);
            }
        });

        if (!report.rows.length) {
            doc.font('Helvetica').fontSize(10).fillColor('#555555').text('No records match these filters.');
        }
        doc.end();
    });
}

module.exports = { createWorkbook, createPdf };
