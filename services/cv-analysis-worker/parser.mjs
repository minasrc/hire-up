import { createHash } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { readDocxArchive } from './zip.mjs';
import { ParserError, fail } from './errors.mjs';

export const PARSER_VERSION = 'pdfjs-6.2.108-docx-xml-0.8.15-v1';
const WORD = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const decoder = new TextDecoder('utf-8', { fatal: true });
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const elements = (node, name) => Array.from(node.getElementsByTagNameNS(WORD, name));
const attr = (node, name) => node.getAttributeNS(WORD, name);
function xml(bytes) {
    if (!bytes) fail('INVALID_DOCUMENT');
    const text = decoder.decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/iu.test(text) || text.includes('\0')) fail('INVALID_DOCUMENT');
    let invalid = false;
    const doc = new DOMParser({ errorHandler: { warning: () => { invalid = true; }, error: () => { invalid = true; }, fatalError: () => { invalid = true; } } }).parseFromString(text, 'application/xml');
    if (invalid || !doc.documentElement) fail('INVALID_DOCUMENT');
    return doc;
}
function hidden(node) {
    for (let ancestor = node; ancestor; ancestor = ancestor.parentNode) {
        if (ancestor.namespaceURI === WORD && ['del', 'moveFrom'].includes(ancestor.localName)) return true;
        if (ancestor.namespaceURI === WORD && ['footnote', 'endnote'].includes(ancestor.localName) && ['separator', 'continuationSeparator', 'continuationNotice'].includes(attr(ancestor, 'type'))) return true;
    }
    return false;
}
function paragraphText(node, root = node) {
    if (hidden(node) || (node !== root && node.namespaceURI === WORD && node.localName === 'p')) return '';
    if (node.namespaceURI === WORD) {
        if (node.localName === 't') return node.textContent;
        if (['br', 'cr'].includes(node.localName)) return '\n';
        if (node.localName === 'tab') return '\t';
        if (node.localName === 'noBreakHyphen') return '\u2011';
        if (node.localName === 'softHyphen') return '\u00ad';
        if (['altChunk', 'sym', 'object'].includes(node.localName)) fail('INVALID_DOCUMENT');
    }
    return Array.from(node.childNodes ?? []).map(child => paragraphText(child, root)).join('');
}
function docxBlocks(bytes, append) {
    const archive = readDocxArchive(bytes); const main = xml(archive.get('word/document.xml'));
    const packageRelationships = Array.from(xml(archive.get('_rels/.rels')).getElementsByTagNameNS(PACKAGE_REL, 'Relationship')).filter(node => node.getAttribute('Type') === `${REL}/officeDocument`);
    if (packageRelationships.length !== 1 || packageRelationships[0].getAttribute('TargetMode') === 'External' || !['word/document.xml', '/word/document.xml'].includes(packageRelationships[0].getAttribute('Target'))) fail('INVALID_DOCUMENT');
    const contentTypes = xml(archive.get('[Content_Types].xml'));
    const mainTypes = Array.from(contentTypes.getElementsByTagNameNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override')).filter(node => node.getAttribute('PartName') === '/word/document.xml');
    if (mainTypes.length !== 1 || mainTypes[0].getAttribute('ContentType') !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') fail('INVALID_DOCUMENT');
    if (main.documentElement.namespaceURI !== WORD || main.documentElement.localName !== 'document') fail('INVALID_DOCUMENT');
    const parts = new Map([['word/document.xml', main]]);
    const relations = archive.has('word/_rels/document.xml.rels') ? xml(archive.get('word/_rels/document.xml.rels')) : null;
    const byId = new Map();
    for (const relation of Array.from(relations?.getElementsByTagNameNS(PACKAGE_REL, 'Relationship') ?? [])) {
        const id = relation.getAttribute('Id'); if (byId.has(id)) fail('INVALID_DOCUMENT'); byId.set(id, relation);
    }
    for (const reference of [...elements(main, 'headerReference'), ...elements(main, 'footerReference')]) {
        const relation = byId.get(reference.getAttributeNS(REL, 'id'));
        const kind = reference.localName === 'headerReference' ? 'header' : 'footer';
        if (!relation || relation.getAttribute('TargetMode') === 'External' || relation.getAttribute('Type') !== `${REL}/${kind}`) fail('INVALID_DOCUMENT');
        const target = relation.getAttribute('Target').replace(/^\//u, '');
        const path = target.startsWith('word/') ? target : `word/${target}`;
        if (!new RegExp(`^word/${kind}(?:[1-9][0-9]?|100)\\.xml$`, 'u').test(path)) fail('INVALID_DOCUMENT');
        parts.set(path, xml(archive.get(path)));
    }
    const ordered = [...parts.keys()].filter(path => path !== 'word/document.xml').sort(); ordered.unshift('word/document.xml');
    const noteIds = new Map();
    for (const kind of ['footnote', 'endnote']) {
        const ids = new Set([...parts.values()].flatMap(doc => elements(doc, `${kind}Reference`)).filter(node => !hidden(node)).map(node => attr(node, 'id')));
        if (ids.size) { const path = `word/${kind}s.xml`; parts.set(path, xml(archive.get(path))); ordered.push(path); noteIds.set(path, ids); }
    }
    for (const path of ordered) {
        const doc = parts.get(path); let paragraph = 0;
        if (elements(doc, 'altChunk').length || elements(doc, 'object').length || elements(doc, 'sym').length) fail('INVALID_DOCUMENT');
        for (const node of elements(doc, 'p')) {
            if (hidden(node)) continue;
            if (noteIds.has(path)) {
                let parent = node.parentNode;
                while (parent && !['footnote', 'endnote'].includes(parent.localName)) parent = parent.parentNode;
                if (!parent || !noteIds.get(path).has(attr(parent, 'id'))) continue;
            }
            paragraph += 1; append({ kind: 'docx_paragraph', part: path, paragraph, text: paragraphText(node) });
        }
    }
}
async function pdfBlocks(bytes, append) {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(bytes), stopAtErrors: true, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, isEvalSupported: false, disableAutoFetch: true, verbosity: 0 });
    try {
        const document = await task.promise;
        if (document.numPages > 50) fail('DOCUMENT_LIMIT');
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            const page = await document.getPage(pageNumber); const content = await page.getTextContent();
            let text = '';
            for (const item of content.items) {
                if (typeof item.str !== 'string') continue;
                text += item.str; if (item.hasEOL) text += '\n';
            }
            if (!text.trim()) {
                const operators = await page.getOperatorList();
                if (operators.fnArray.some(op => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectRepeat].includes(op))) fail('OCR_REQUIRED');
            }
            append({ kind: 'pdf_page', page: pageNumber, text }); page.cleanup();
        }
    } catch (error) { if (error?.name === 'PasswordException') fail('ENCRYPTED_DOCUMENT'); throw error; }
    finally { await task.destroy(); }
}
// Only run this entry point inside the sandbox in production. The parent must
// never import parser dependencies or expose its credential-bearing process.
export async function parseDocument(input, { extension }) {
    try {
        const bytes = Buffer.from(input);
        if (!bytes.length || bytes.length > 4 * 1024 * 1024) fail('DOCUMENT_LIMIT');
        if (!['pdf', 'docx'].includes(extension)) fail('INVALID_DOCUMENT');
        const blocks = []; let size = 0;
        const append = block => {
            const text = block.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
            if (text.includes('\0') || !text.isWellFormed()) fail('INVALID_DOCUMENT');
            size += Buffer.byteLength(text) + (blocks.length ? 2 : 0);
            if (size > 65536) fail('TEXT_LIMIT'); if (blocks.length >= 2000) fail('DOCUMENT_LIMIT');
            blocks.push({ ordinal: blocks.length, ...block, text, sha256: sha256(text) });
        };
        if (extension === 'pdf') {
            if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail('INVALID_DOCUMENT');
            await pdfBlocks(bytes, append);
        } else {
            if (bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) fail('ENCRYPTED_DOCUMENT');
            docxBlocks(bytes, append);
        }
        const fullText = blocks.map(block => block.text).join('\n\n');
        if (!fullText.trim()) fail(extension === 'pdf' ? 'OCR_REQUIRED' : 'INVALID_DOCUMENT');
        return { parserVersion: PARSER_VERSION, documentSha256: sha256(bytes), textSha256: sha256(fullText), blocks };
    } catch (error) { if (error instanceof ParserError) throw error; fail('INVALID_DOCUMENT'); }
}
