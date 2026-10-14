import assert from 'node:assert/strict';
import test from 'node:test';
import { editorJobDocument } from '../../src/lib/editor-job-document.js';
import { normalizeJobDocument, jobDocumentText } from '../../src/lib/client-job-contracts.js';

const pasted = {
    type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Read more', marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer', class: null, title: null } }] }] },
        { type: 'orderedList', attrs: { start: 3, type: 'A' }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A responsibility', marks: [{ type: 'bold' }] }] }] }] },
    ],
};

test('pasted editor links and lists remain readable and valid before saving', () => {
    const original = structuredClone(pasted);
    const canonical = normalizeJobDocument(editorJobDocument(pasted));
    assert.match(jobDocumentText(canonical), /Read more/);
    assert.match(jobDocumentText(canonical), /A responsibility/);
    assert.deepEqual(canonical.content[0].content[0].marks, [{ type: 'link', attrs: { href: 'https://example.com' } }]);
    assert.deepEqual(canonical.content[1].attrs, { start: 3 });
    assert.deepEqual(canonical.content[1].content[0].content[0].content[0].marks, [{ type: 'bold' }]);
    assert.deepEqual(pasted, original, 'conversion must not modify the editor draft');
});

test('editor metadata conversion does not bypass link or document validation', () => {
    const unsafe = structuredClone(pasted);
    unsafe.content[0].content[0].marks[0].attrs.href = 'javascript:alert(1)';
    assert.throws(() => normalizeJobDocument(editorJobDocument(unsafe)));
    const unknown = structuredClone(pasted);
    unknown.content[0].content[0].marks[0].attrs.unexpected = true;
    assert.throws(() => normalizeJobDocument(editorJobDocument(unknown)));
});
