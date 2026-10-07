import { strToU8, zipSync } from 'fflate';

export const cvAnalysisProfile = Object.freeze({
    firstName: 'Alex', lastName: 'Rivera', primaryEmail: 'alex.rivera@example.invalid',
    headline: 'Senior platform engineer', location: 'Madrid, Spain',
});
export const cvAnalysisPages = Object.freeze([
    ['Alex Rivera', 'alex.rivera@example.invalid', 'Senior platform engineer', 'Madrid, Spain'],
    ['Experience', 'Built event processing systems with PostgreSQL and Kafka.',
        'Led a platform team of six engineers.', 'Education', 'MSc Computer Science'],
]);

// Deliberately synthetic, valid PDF objects with byte-accurate cross references.
// Built-in Helvetica supports the ASCII test content; use DOCX for Unicode cases.
export function createCvAnalysisPdf(pages = cvAnalysisPages) {
    if (!Array.isArray(pages) || !pages.length) throw new Error('Synthetic PDF requires pages');
    const pageRefs = pages.map((_, index) => `${4 + index * 2} 0 R`);
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    for (const [index, lines] of pages.entries()) {
        if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string' || /[^\x20-\x7e]/.test(line))) throw new Error('Synthetic PDF lines must be ASCII');
        const escaped = lines.map(line => line.replace(/[\\()]/g, '\\$&'));
        const stream = `BT /F1 12 Tf 72 720 Td 16 TL\n${escaped.map((line, i) => `${i ? 'T* ' : ''}(${line}) Tj`).join('\n')}\nET\n`;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
            `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
    }
    let pdf = '%PDF-1.7\n';
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
    for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function createCvAnalysisDocx(paragraphs = cvAnalysisPages.flat(), { header = null, footer = null, table = [] } = {}) {
    if (!Array.isArray(paragraphs) || paragraphs.some(value => typeof value !== 'string')) throw new Error('Synthetic DOCX requires text paragraphs');
    const modified = new Date('2020-01-01T00:00:00Z');
    const paragraphXml = text => `<w:p><w:r><w:t xml:space="preserve">${xml(text).replaceAll('\n', '</w:t><w:br/><w:t xml:space="preserve">').replaceAll('\t', '</w:t><w:tab/><w:t xml:space="preserve">')}</w:t></w:r></w:p>`;
    const parts = [['header', header], ['footer', footer]].filter(([, value]) => value !== null);
    const partOverrides = parts.map(([kind]) => `<Override PartName="/word/${kind}1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`).join('');
    const partReferences = parts.map(([kind]) => `<w:${kind}Reference w:type="default" r:id="r${kind}"/>`).join('');
    const tableXml = table.length ? `<w:tbl>${table.map(row => `<w:tr>${row.map(cell => `<w:tc>${paragraphXml(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : '';
    const entries = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${paragraphs.map(paragraphXml).join('')}${tableXml}<w:sectPr>${partReferences}</w:sectPr></w:body></w:document>`,
    };
    entries['[Content_Types].xml'] = entries['[Content_Types].xml'].replace('</Types>', `${partOverrides}</Types>`);
    if (parts.length) {
        entries['word/_rels/document.xml.rels'] = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts.map(([kind]) => `<Relationship Id="r${kind}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${kind}1.xml"/>`).join('')}</Relationships>`;
        for (const [kind, value] of parts) {
            const tag = kind === 'header' ? 'hdr' : 'ftr';
            entries[`word/${kind}1.xml`] = `<w:${tag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${paragraphXml(value)}</w:${tag}>`;
        }
    }
    return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, content]) => [name, [strToU8(content), { mtime: modified }]]))));
}
