import { parseDocument } from './parser.mjs';
// Parser/library diagnostics can contain document-controlled strings. Only the
// bounded JSON protocol may leave the credential-free sandbox.
for (const key of ['log', 'warn', 'error', 'info', 'debug']) console[key] = () => {};
const allowed = new Set(['INVALID_DOCUMENT', 'ENCRYPTED_DOCUMENT', 'OCR_REQUIRED', 'DOCUMENT_LIMIT', 'TEXT_LIMIT']);
try {
    const chunks = []; let length = 0;
    for await (const chunk of process.stdin) { length += chunk.length; if (length > 4194304) throw { code: 'DOCUMENT_LIMIT' }; chunks.push(chunk); }
    const result = await parseDocument(Buffer.concat(chunks), { extension: process.argv[2] });
    const output = JSON.stringify({ ok: true, result });
    if (Buffer.byteLength(output) > 1048576) throw { code: 'DOCUMENT_LIMIT' };
    process.stdout.write(output);
} catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: allowed.has(error?.code) ? error.code : 'INVALID_DOCUMENT' })); }
