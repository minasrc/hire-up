import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { parseDocument, sha256, PARSER_VERSION } from '../../services/cv-analysis-worker/parser.mjs';
import { readDocxArchive } from '../../services/cv-analysis-worker/zip.mjs';
import { sandboxArguments, runIsolatedParser } from '../../services/cv-analysis-worker/sandbox.mjs';
import { createCvAnalysisPdf, createCvAnalysisDocx } from '../support/cv-analysis-fixtures.js';

const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const patchDocx = (bytes, update) => { const entries = unzipSync(bytes); update(entries); return Buffer.from(zipSync(entries)); };
const docx = bytes => parseDocument(bytes, { extension: 'docx' });
const pdf = bytes => parseDocument(bytes, { extension: 'pdf' });
test('parser uses its patched exact dependency pins rather than the root viewer package', () => {
    const require = createRequire(new URL('../../services/cv-analysis-worker/parser.mjs', import.meta.url));
    assert.equal(require('pdfjs-dist/package.json').version, '6.2.108');
    assert.equal(require('@xmldom/xmldom/package.json').version, '0.8.15');
});
function imagePdf({ mixed = false, encrypted = false } = {}) {
    const stream = 'q\nBI /W 1 /H 1 /BPC 8 /CS /G ID\nx\nEI\nQ\n';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [3 0 R${mixed ? ' 6 0 R' : ''}] /Count ${mixed ? 2 : 1} >>`,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    if (mixed) { const text = 'BT /F1 12 Tf 72 720 Td (Synthetic CV text) Tj ET\n'; objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', `<< /Length ${text.length} >>\nstream\n${text}endstream`); }
    if (encrypted) objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${'00'.repeat(32)}> /U <${'00'.repeat(32)}> /P -4 >>`);
    let value = '%PDF-1.7\n'; const offsets = [0];
    for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(value)); value += `${i + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(value); value += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${offsets.length}${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<0123456789abcdef> <0123456789abcdef>]` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(value);
}
test('DOCX preserves Unicode, tables, line breaks, tabs, empty paragraphs and referenced header contacts', async () => {
    const bytes = createCvAnalysisDocx(['Ana García', '', 'Résumé\nPlatform\tEngineer'], { header: 'ana@example.test', footer: 'Madrid', table: [['Kafka', 'PostgreSQL']] });
    const result = await docx(bytes);
    assert.equal(result.parserVersion, PARSER_VERSION); assert.equal(result.documentSha256, sha256(bytes));
    assert.deepEqual(result.blocks.map(b => b.text), ['Ana García', '', 'Résumé\nPlatform\tEngineer', 'Kafka', 'PostgreSQL', 'Madrid', 'ana@example.test']);
    assert.equal(result.blocks.at(-1).part, 'word/header1.xml'); assert.equal(result.blocks.at(-1).paragraph, 1);
    assert.equal(result.textSha256, sha256(result.blocks.map(b => b.text).join('\n\n')));
    for (const [i, block] of result.blocks.entries()) { assert.equal(block.ordinal, i); assert.equal(block.sha256, sha256(block.text)); }
});
test('DOCX notes are referenced and separator/deleted text does not become candidate content', async () => {
    const bytes = patchDocx(createCvAnalysisDocx(['Visible']), entries => {
        entries['word/document.xml'] = strToU8(strFromU8(entries['word/document.xml']).replace('</w:p>', '<w:r><w:footnoteReference w:id="2"/></w:r><w:del><w:r><w:t>Deleted identity</w:t></w:r></w:del></w:p>'));
        entries['word/footnotes.xml'] = strToU8(`<w:footnotes xmlns:w="${word}"><w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:t>Separator</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>Relevant note</w:t></w:r></w:p></w:footnote><w:footnote w:id="3"><w:p><w:r><w:t>Unreferenced</w:t></w:r></w:p></w:footnote></w:footnotes>`);
        entries['word/header99.xml'] = strToU8(`<w:hdr xmlns:w="${word}"><w:p><w:r><w:t>Unreferenced header</w:t></w:r></w:p></w:hdr>`);
    });
    assert.deepEqual((await docx(bytes)).blocks.map(b => b.text), ['Visible', 'Relevant note']);
});
test('DOCX rejects external header references, malformed XML, entities, unsupported content and archive traversal', async () => {
    const external = patchDocx(createCvAnalysisDocx(['A'], { header: 'B' }), entries => { entries['word/_rels/document.xml.rels'] = strToU8(strFromU8(entries['word/_rels/document.xml.rels']).replace('Target="header1.xml"', 'TargetMode="External" Target="https://example.invalid/private"')); });
    const entity = patchDocx(createCvAnalysisDocx(['A']), entries => { entries['word/document.xml'] = strToU8('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><x>&secret;</x>'); });
    const malformed = patchDocx(createCvAnalysisDocx(['A']), entries => { entries['word/document.xml'] = strToU8('<a><b></a>'); });
    const traversal = patchDocx(createCvAnalysisDocx(['A']), entries => { entries['../private.xml'] = strToU8('x'); });
    const unsupported = patchDocx(createCvAnalysisDocx(['A']), entries => { entries['word/document.xml'] = strToU8(strFromU8(entries['word/document.xml']).replace('<w:sectPr>', '<w:altChunk/><w:sectPr>')); });
    for (const bytes of [external, entity, malformed, traversal, unsupported]) await assert.rejects(docx(bytes), { code: 'INVALID_DOCUMENT' });
});
test('DOCX caps entry count, actual inflated bytes, paragraph count and joined UTF8 text without truncation', async () => {
    const entries = patchDocx(createCvAnalysisDocx(['A']), values => { for (let i = 0; i < 256; i += 1) values[`word/extra${i}`] = strToU8('x'); });
    assert.throws(() => readDocxArchive(entries), { code: 'DOCUMENT_LIMIT' });
    const inflated = patchDocx(createCvAnalysisDocx(['A']), values => { values['word/oversize'] = new Uint8Array(17 * 1024 * 1024); });
    assert.throws(() => readDocxArchive(inflated), { code: 'DOCUMENT_LIMIT' });
    const forged = Buffer.from(inflated); const centralMagic = Buffer.from('504b0102', 'hex');
    for (let at = forged.indexOf(centralMagic); at >= 0; at = forged.indexOf(centralMagic, at + 4)) {
        if (forged.subarray(at + 46, at + 46 + forged.readUInt16LE(at + 28)).toString() === 'word/oversize') { forged.writeUInt32LE(1, at + 24); forged.writeUInt32LE(1, forged.readUInt32LE(at + 42) + 22); }
    }
    assert.throws(() => readDocxArchive(forged), { code: 'DOCUMENT_LIMIT' }, 'actual inflation is bounded even if metadata lies');
    await assert.rejects(docx(createCvAnalysisDocx(Array.from({ length: 2001 }, () => 'a'))), { code: 'DOCUMENT_LIMIT' });
    await assert.rejects(docx(createCvAnalysisDocx(['漢'.repeat(22000)])), { code: 'TEXT_LIMIT' });
    const almost = await docx(createCvAnalysisDocx(['a'.repeat(65532), 'b'])); assert.equal(Buffer.byteLength(almost.blocks.map(b => b.text).join('\n\n')), 65535);
});
test('PDF preserves contiguous page coverage including blank pages and validates full hashes', async () => {
    const bytes = createCvAnalysisPdf([['Alex Rivera', 'alex@example.test'], [], ['Experience', 'PostgreSQL']]); const result = await pdf(bytes);
    assert.deepEqual(result.blocks.map(b => b.page), [1, 2, 3]); assert.equal(result.blocks[1].text, ''); assert.match(result.blocks[0].text, /alex@example\.test/u); assert.equal(result.documentSha256, sha256(bytes));
});
test('PDF scanned/mixed, encrypted, malformed and page/text/input overflows are explicit', async () => {
    await assert.rejects(pdf(imagePdf()), { code: 'OCR_REQUIRED' }); await assert.rejects(pdf(imagePdf({ mixed: true })), { code: 'OCR_REQUIRED' });
    await assert.rejects(pdf(imagePdf({ encrypted: true })), { code: 'ENCRYPTED_DOCUMENT' });
    await assert.rejects(pdf(Buffer.from('%PDF-invalid')), { code: 'INVALID_DOCUMENT' });
    await assert.rejects(pdf(createCvAnalysisPdf(Array.from({ length: 51 }, () => ['A']))), { code: 'DOCUMENT_LIMIT' });
    await assert.rejects(pdf(Buffer.alloc(4194305)), { code: 'DOCUMENT_LIMIT' });
    await assert.rejects(pdf(createCvAnalysisPdf(Array.from({ length: 30 }, () => Array.from({ length: 40 }, () => 'a'.repeat(80))))), { code: 'TEXT_LIMIT' });
    await assert.rejects(docx(Buffer.from('d0cf11e0a1b11ae100000000', 'hex')), { code: 'ENCRYPTED_DOCUMENT' });
});
test('sandbox requires no network, readonly root, bounded resources and no host mounts or credentials', () => {
    const args = sandboxArguments('synthetic', 'agora-cv-parser:v1', 'pdf');
    for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--pids-limit=64', '--user=65534:65534']) assert(args.includes(flag));
    assert(!args.some(value => ['-v', '--mount', '-e', '--env-file'].includes(value)));
});
test('actual isolated parser reads PDF and DOCX without host filesystem access', { skip: process.env.CV_PARSER_DOCKER !== '1' }, async () => {
    for (const [extension, bytes] of [['pdf', createCvAnalysisPdf()], ['docx', createCvAnalysisDocx(['Álex Rivera'], { header: 'alex@example.test' })]]) {
        const result = await runIsolatedParser(bytes, { extension }); assert.equal(result.documentSha256, sha256(bytes)); assert(result.blocks.length > 0);
    }
    await assert.rejects(runIsolatedParser(imagePdf({ mixed: true }), { extension: 'pdf' }), { code: 'OCR_REQUIRED' });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(runIsolatedParser(createCvAnalysisPdf(), { extension: 'pdf', signal: controller.signal }), { code: 'STOPPED' }); }
    finally { clearTimeout(timer); }
});
