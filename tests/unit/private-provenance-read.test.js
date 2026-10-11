import assert from 'node:assert/strict';
import test from 'node:test';
import { readPrivateProvenance, PrivateProvenanceTimeout } from '../../src/app/staff/candidates/[candidateId]/private-provenance-read.js';

test('private provenance closes unused error bodies and preserves successful data', async t => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    for (const status of [401, 403, 404, 428, 503]) {
        let cancelled = false;
        globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
        assert.deepEqual(await readPrivateProvenance('/private', new AbortController().signal), { status, ok: false, data: null });
        assert.equal(cancelled, true, `Unused ${status} body is closed`);
    }
    // A stalled disposal must not delay a known authentication denial.
    let deniedSignal;
    globalThis.fetch = async (url, init) => { deniedSignal = init.signal; return { status: 428, ok: false, body: { cancel: () => new Promise(() => {}) } }; };
    assert.equal((await readPrivateProvenance('/private', new AbortController().signal, 10)).status, 428);
    assert.equal(deniedSignal.aborted, true, 'Stalled body disposal cannot retain the underlying fetch');
    globalThis.fetch = async () => Response.json({ sources: [] });
    assert.deepEqual((await readPrivateProvenance('/private', new AbortController().signal)).data, { sources: [] });
});

test('private provenance deadlines cover headers and body while obsolete cancellation stays distinct', async t => {
    const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
    const pending = signal => new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
    globalThis.fetch = (url, init) => pending(init.signal);
    await assert.rejects(readPrivateProvenance('/private', new AbortController().signal, 10), PrivateProvenanceTimeout);
    globalThis.fetch = async (url, init) => ({ ok: true, json: () => pending(init.signal) });
    await assert.rejects(readPrivateProvenance('/private', new AbortController().signal, 10), PrivateProvenanceTimeout);
    const obsolete = new AbortController();
    const read = readPrivateProvenance('/private', obsolete.signal, 100);
    obsolete.abort();
    await assert.rejects(read, error => error.name === 'AbortError' && !(error instanceof PrivateProvenanceTimeout));
});
