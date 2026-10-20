'use strict';

function parseCsv(text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw Object.assign(new Error('The CSV file is empty.'), { status: 400 });
    }

    const input = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const records = [];
    let record = [];
    let field = '';
    let quoted = false;
    let closedQuote = false;

    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (quoted) {
            if (char === '"') {
                if (input[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else {
                    quoted = false;
                    closedQuote = true;
                }
            } else {
                field += char;
            }
            continue;
        }

        if (closedQuote && char !== ',' && char !== '\r' && char !== '\n' && char !== ' ' && char !== '\t') {
            throw Object.assign(new Error('The CSV contains characters after a closing quote.'), {
                status: 400
            });
        }
        if (char === '"' && (field !== '' || closedQuote)) {
            throw Object.assign(new Error('The CSV contains an invalid quote in an unquoted field.'), {
                status: 400
            });
        }
        if (char === '"' && field === '' && !closedQuote) {
            quoted = true;
        } else if (char === ',' || char === '\r' || char === '\n') {
            record.push(field.trim());
            field = '';
            closedQuote = false;
            if (char === ',') continue;
            if (char === '\r' && input[index + 1] === '\n') index += 1;
            if (record.some((value) => value !== '')) records.push(record);
            record = [];
        } else {
            field += char;
            if (closedQuote && (char === ' ' || char === '\t')) {
                field = field.trim();
            }
        }
    }

    if (quoted) {
        throw Object.assign(new Error('The CSV contains an unterminated quoted field.'), {
            status: 400
        });
    }
    record.push(field.trim());
    if (record.some((value) => value !== '')) records.push(record);
    if (!records.length) {
        throw Object.assign(new Error('The CSV file does not contain a header row.'), { status: 400 });
    }

    const headers = records.shift().map((value) => value.replace(/^\uFEFF/, '').trim().toLowerCase());
    if (headers.some((header) => !header)) {
        throw Object.assign(new Error('CSV column names cannot be empty.'), { status: 400 });
    }
    if (new Set(headers).size !== headers.length) {
        throw Object.assign(new Error('CSV column names must be unique.'), { status: 400 });
    }

    return records.map((values, index) => {
        if (values.length !== headers.length) {
            return {
                rowNumber: index + 2,
                error: `Expected ${headers.length} columns, found ${values.length}.`
            };
        }
        return {
            rowNumber: index + 2,
            data: Object.fromEntries(headers.map((header, column) => [header, values[column]]))
        };
    });
}

module.exports = { parseCsv };
