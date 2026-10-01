import { crc32, inflateRawSync } from 'node:zlib';
import { fail } from './errors.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_ENTRIES = 256;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;

// Inspect the archive before any XML parser sees it. Never extract names to the
// filesystem, and verify actual bounded inflation rather than trusting ZIP sizes.
export function readDocxArchive(bytes) {
    try { return readArchive(bytes); }
    catch (error) { if (['DOCUMENT_LIMIT', 'INVALID_DOCUMENT', 'ENCRYPTED_DOCUMENT'].includes(error?.code)) throw error; fail('INVALID_DOCUMENT'); }
}
function readArchive(bytes) {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) {
        if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
    }
    if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('INVALID_DOCUMENT');
    const count = bytes.readUInt16LE(end + 10); const size = bytes.readUInt32LE(end + 12); const start = bytes.readUInt32LE(end + 16);
    if (count !== bytes.readUInt16LE(end + 8) || count === 65535 || size === 0xffffffff || start === 0xffffffff || start + size !== end) fail('INVALID_DOCUMENT');
    if (count > MAX_ENTRIES) fail('DOCUMENT_LIMIT');
    const entries = new Map(); const ranges = []; let position = start; let total = 0;
    for (let i = 0; i < count; i += 1) {
        if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) fail('INVALID_DOCUMENT');
        const flags = bytes.readUInt16LE(position + 8); const method = bytes.readUInt16LE(position + 10);
        const checksum = bytes.readUInt32LE(position + 16); const compressed = bytes.readUInt32LE(position + 20); const expanded = bytes.readUInt32LE(position + 24);
        const nameLength = bytes.readUInt16LE(position + 28); const extraLength = bytes.readUInt16LE(position + 30); const commentLength = bytes.readUInt16LE(position + 32);
        const offset = bytes.readUInt32LE(position + 42); const attributes = bytes.readUInt32LE(position + 38);
        if (flags & 0x41) fail('ENCRYPTED_DOCUMENT');
        if (![0, 8].includes(method) || bytes.readUInt16LE(position + 34) || (attributes >>> 16 & 0xf000) === 0xa000) fail('INVALID_DOCUMENT');
        if (expanded > MAX_ENTRY_BYTES || total + expanded > MAX_EXPANDED_BYTES) fail('DOCUMENT_LIMIT');
        if (position + 46 + nameLength + extraLength + commentLength > end) fail('INVALID_DOCUMENT');
        const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength); const name = decoder.decode(nameBytes);
        if (!name || name.startsWith('/') || /[\\\u0000-\u001f\u007f]/u.test(name) || name.split('/').some(segment => segment === '..' || segment === '.') || entries.has(name)) fail('INVALID_DOCUMENT');
        if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail('INVALID_DOCUMENT');
        const localNameLength = bytes.readUInt16LE(offset + 26); const localExtraLength = bytes.readUInt16LE(offset + 28); const dataStart = offset + 30 + localNameLength + localExtraLength;
        if (dataStart + compressed > start || !bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(nameBytes)) fail('INVALID_DOCUMENT');
        if (!(flags & 8) && (bytes.readUInt32LE(offset + 14) !== checksum || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== expanded)) fail('INVALID_DOCUMENT');
        const data = bytes.subarray(dataStart, dataStart + compressed);
        let value;
        try { value = method === 0 ? data : inflateRawSync(data, { maxOutputLength: Math.min(MAX_ENTRY_BYTES, MAX_EXPANDED_BYTES - total) }); }
        catch (error) { if (error?.code === 'ERR_BUFFER_TOO_LARGE') fail('DOCUMENT_LIMIT'); throw error; }
        if (value.length !== expanded || crc32(value) !== checksum) fail('INVALID_DOCUMENT');
        total += value.length; entries.set(name, value); ranges.push([offset, dataStart + compressed]); position += 46 + nameLength + extraLength + commentLength;
    }
    if (position !== end) fail('INVALID_DOCUMENT');
    ranges.sort((a, b) => a[0] - b[0]);
    if (ranges.some((range, i) => i > 0 && range[0] < ranges[i - 1][1])) fail('INVALID_DOCUMENT');
    if (!entries.has('[Content_Types].xml') || !entries.has('word/document.xml')) fail('INVALID_DOCUMENT');
    return entries;
}
