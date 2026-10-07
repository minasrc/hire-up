import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CsvParseError,
    parseCsv,
    suggestColumnTarget,
} from '../../src/lib/csv-parse.js';

test('parses a simple comma-separated file', () => {
    const { headers, rows } = parseCsv('name,email\nAda,ada@example.com\nBob,bob@example.com\n');
    assert.deepEqual(headers, ['name', 'email']);
    assert.deepEqual(rows, [['Ada', 'ada@example.com'], ['Bob', 'bob@example.com']]);
});

test('handles quoted commas, escaped quotes and multiline fields', () => {
    const text = 'name,notes\n"Ada, Lovelace","says ""hi""\nthen a second line"\n';
    const { rows } = parseCsv(text);
    assert.deepEqual(rows, [['Ada, Lovelace', 'says "hi"\nthen a second line']]);
});

test('strips a UTF-8 byte order mark', () => {
    const { headers, rows } = parseCsv('﻿name,email\nAda,a@example.com');
    assert.deepEqual(headers, ['name', 'email']);
    assert.equal(rows.length, 1);
});

test('accepts CRLF and CR line endings', () => {
    const { rows } = parseCsv('name\r\nAda\rBob');
    assert.deepEqual(rows, [['Ada'], ['Bob']]);
});

test('rejects an unterminated quoted field', () => {
    assert.throws(() => parseCsv('name\n"unclosed'), CsvParseError);
});

test('rejects a stray quote inside an unquoted field', () => {
    assert.throws(() => parseCsv('name\nad"a'), CsvParseError);
});

test('rejects NUL bytes', () => {
    assert.throws(
        () => parseCsv('name\nAda' + String.fromCharCode(0)),
        CsvParseError,
    );
});

test('rejects ragged rows with the source row number', () => {
    assert.throws(
        () => parseCsv('name,email\nAda,only@example.com,extra'),
        /Row 2 has 3 columns, expected 2/u,
    );
    assert.throws(
        () => parseCsv('name,email\nok@example.com'),
        /Row 2 has 1 columns, expected 2/u,
    );
});

test('enforces row and column limits', () => {
    const many = `name\n${Array.from({ length: 101 }, (_, i) => `p${i}`).join('\n')}`;
    assert.throws(() => parseCsv(many), /at most 100/u);
    const wide = `${Array.from({ length: 51 }, (_, i) => `c${i}`).join(',')}\nx`;
    assert.throws(() => parseCsv(wide), /at most 50/u);
});

test('disambiguates duplicate headers by column position', () => {
    const { headers, labels } = parseCsv('name,name\nAda,Bobb');
    assert.deepEqual(headers, ['name', 'name']);
    assert.deepEqual(labels, ['name', 'name (column 2)']);
});

test('an empty header cell gets a positional label', () => {
    const { labels } = parseCsv('name,\nAda,x');
    assert.deepEqual(labels, ['name', 'Column 2']);
});

test('a trailing empty quoted field keeps its row', () => {
    const { rows } = parseCsv('name\n""');
    assert.deepEqual(rows, [['']]);
});

test('rejects trailing text after a closing quote', () => {
    assert.throws(() => parseCsv('name\n"Ada"trailing'), CsvParseError);
});

test('quoted CRLF and escaped quotes round-trip', () => {
    const { rows } = parseCsv('name,notes\n"Ada","line one\r\nline ""two"""\r\nBob,ok');
    assert.deepEqual(rows, [
        ['Ada', 'line one\r\nline "two"'],
        ['Bob', 'ok'],
    ]);
});

test('enforces the 1 MB limit on raw UTF-8 bytes, not characters', () => {
    const big = `name\n${'é'.repeat(600 * 1024)}`;
    assert.ok(new TextEncoder().encode(big).byteLength > 1024 * 1024);
    assert.ok(big.length <= 1024 * 1024);
    assert.throws(() => parseCsv(big), /1 MB/u);
});

test('fatal UTF-8 decoding rejects malformed bytes before parsing', () => {
    const bytes = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xff, 0xfe]);
    assert.throws(
        () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        TypeError);
});

test('suggests import targets from common header aliases', () => {
    assert.equal(suggestColumnTarget('Full Name'), 'fullName');
    assert.equal(suggestColumnTarget('E-mail'), 'email');
    assert.equal(suggestColumnTarget('Job Title'), 'headline');
    assert.equal(suggestColumnTarget('City'), 'location');
    assert.equal(suggestColumnTarget('About'), 'professionalSummary');
    assert.equal(suggestColumnTarget('Notes'), 'notes');
    assert.equal(suggestColumnTarget('name (column 2)'), 'fullName');
    assert.equal(suggestColumnTarget('unrelated column'), null);
});
