export const CSV_MAX_BYTES = 1024 * 1024;
export const CSV_MAX_ROWS = 100;
export const CSV_MAX_COLUMNS = 50;

export class CsvParseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CsvParseError';
    }
}

export function parseCsv(text, {
    maxRows = CSV_MAX_ROWS,
    maxColumns = CSV_MAX_COLUMNS,
} = {}) {
    if (typeof text !== 'string') {
        throw new CsvParseError('The CSV file could not be read as text.');
    }
    if (new TextEncoder().encode(text).byteLength > CSV_MAX_BYTES) {
        throw new CsvParseError('The CSV file must be 1 MB or smaller.');
    }
    if (text.includes('\u0000')) {
        throw new CsvParseError('The CSV file contains unsupported binary data.');
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.trim() === '') throw new CsvParseError('The CSV file is empty.');

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let fieldStart = true;
    let afterQuote = false;

    const endField = () => {
        row.push(field);
        if (row.length > maxColumns) {
            throw new CsvParseError(`The CSV supports at most ${maxColumns} columns.`);
        }
        field = '';
        fieldStart = true;
        afterQuote = false;
    };
    const endRow = () => {
        endField();
        rows.push(row);
        if (rows.length > maxRows + 1) {
            throw new CsvParseError(`The CSV supports at most ${maxRows} data rows.`);
        }
        row = [];
    };

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (inQuotes) {
            if (char === '"') {
                if (text[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else {
                    inQuotes = false;
                    afterQuote = true;
                }
            } else {
                field += char;
            }
            continue;
        }
        if (afterQuote && char !== ',' && char !== '\n' && char !== '\r') {
            throw new CsvParseError(`Unexpected text after a closing quote in row ${rows.length + 1}.`);
        }
        if (char === '"' && fieldStart) {
            inQuotes = true;
            fieldStart = false;
            continue;
        }
        if (char === ',') {
            endField();
            continue;
        }
        if (char === '\n' || char === '\r') {
            if (char === '\r' && text[index + 1] === '\n') index += 1;
            endRow();
            continue;
        }
        if (char === '"') {
            throw new CsvParseError(`Malformed quotes in row ${rows.length + 1}.`);
        }
        field += char;
        fieldStart = false;
    }
    if (inQuotes) throw new CsvParseError('The CSV file ends inside a quoted field.');
    if (field !== '' || row.length > 0 || afterQuote || !fieldStart) endRow();
    if (rows.length === 0) throw new CsvParseError('The CSV file is empty.');

    const headers = rows[0].map((header) => header.trim());
    if (headers.every((header) => header === '')) {
        throw new CsvParseError('The CSV header row is empty.');
    }
    const data = rows.slice(1);
    for (const [index, entry] of data.entries()) {
        if (entry.length !== headers.length) {
            throw new CsvParseError(`Row ${index + 2} has ${entry.length} columns, expected ${headers.length}.`);
        }
    }

    const seenHeaders = new Set();
    const labels = headers.map((header, position) => {
        const base = header === '' ? `Column ${position + 1}` : header;
        if (seenHeaders.has(base.toLowerCase())) return `${base} (column ${position + 1})`;
        seenHeaders.add(base.toLowerCase());
        return base;
    });
    return { headers, labels, rows: data };
}

const COLUMN_ALIASES = new Map([
    ['fullName', ['name', 'full name', 'fullname', 'candidate', 'candidate name']],
    ['email', ['email', 'e-mail', 'email address', 'mail']],
    ['headline', ['role', 'title', 'headline', 'job title', 'position', 'current role']],
    ['location', ['location', 'city', 'country', 'where', 'based']],
    ['tags', ['tags', 'tag', 'labels', 'skills', 'labels/tags']],
    ['professionalSummary', ['summary', 'about', 'profile', 'bio', 'description', 'professional summary']],
    ['notes', ['notes', 'note', 'comments', 'comment']],
]);

export function suggestColumnTarget(label) {
    const normalized = label.replace(/\(column \d+\)$/u, '').trim().toLowerCase();
    for (const [target, aliases] of COLUMN_ALIASES) {
        if (aliases.includes(normalized)) return target;
    }
    return null;
}
