import assert from 'node:assert/strict';
import test from 'node:test';
import { validateExtractionResult, extractionWorkerInput, extractionStaffAction, EXTRACTION_PROMPT_VERSION, EXTRACTION_SINGLE_SOURCE_LIMIT } from '../../src/lib/telegram-extraction-contracts.js';
const source = { messages: [{ messageId: '10', text: 'I am Alice Smith; email ALICE@example.test. Looking for Paris roles.', sender: { peer: { kind: 'user', id: '777' } }, forwardedFrom: null, attachments: [{ filename: 'CV.pdf' }] }] };
const fact = (field, value) => ({ field, value, evidence: [{ messageId: '10', quote: source.messages[0].text }] });
const result = () => ({ subjects: [{ key: 's1', identity: { kind: 'email', email: 'ALICE@example.test' }, facts: [fact('firstName', 'Alice'), fact('lastName', 'Smith'), fact('primaryEmail', 'ALICE@example.test')], attachments: [{ messageId: '10', attachmentIndex: 0 }] }] });
test('extraction normalizes supported fields and requires literal source names/emails', () => {
    const good = validateExtractionResult(result(), source); assert.equal(good.subjects[0].identity.email, 'alice@example.test');
    const invented = result(); invented.subjects[0].facts[0].value = 'Bob'; assert.throws(() => validateExtractionResult(invented, source));
    const reference = result(); reference.subjects[0].facts[0].evidence[0].messageId = '11'; assert.throws(() => validateExtractionResult(reference, source));
    const quoted = result(); quoted.subjects[0].facts[0].evidence[0].quote = 'Alice is a manager'; assert.throws(() => validateExtractionResult(quoted, source));
});
test('extraction rejects arbitrary identity, privilege and media capabilities', () => {
    for (const key of ['ownerMembershipId', 'telegramUserId', 'storageUrl']) { const r = result(); r.subjects[0].facts[0].field = key; assert.throws(() => validateExtractionResult(r, source)); }
    const r = result(); r.subjects[0].identity = { kind: 'telegram_sender', messageId: '10', quote: source.messages[0].text };
    assert.doesNotThrow(() => validateExtractionResult(r, source));
    assert.throws(() => validateExtractionResult(r, { messages: [{ ...source.messages[0], forwardedFrom: { peer: null } }] }));
    r.subjects[0].attachments[0].attachmentIndex = 1; assert.throws(() => validateExtractionResult(r, source));
});
test('extraction completion metadata is bounded and versioned without URLs', () => {
    const body = { jobId: '10000000-0000-4000-8000-000000000001', leaseToken: '10000000-0000-4000-8000-000000000002', sourceDigest: 'a'.repeat(64), result: result(), metadata: { model: 'demo-model', promptVersion: EXTRACTION_PROMPT_VERSION, reportedModel: null } };
    assert.doesNotThrow(() => extractionWorkerInput('complete', body));
    assert.throws(() => extractionWorkerInput('complete', { ...body, metadata: { ...body.metadata, model: 'https://private.example.test' } }));
    assert.throws(() => extractionWorkerInput('complete', { ...body, metadata: { ...body.metadata, promptVersion: 'unknown' } }));
});

test('retention decisions and automatic extraction settings are explicit, bounded and versioned', () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const change = { action: 'setExtraction', chats: [{ chatId: id, expectedVersion: 1 }], enabled: true };
    assert.deepEqual(extractionStaffAction(change), change);
    for (const input of [{ ...change, enabled: 'true' }, { ...change, chats: [...change.chats, ...change.chats] }, { ...change, chats: [] }, { ...change, chats: [{ chatId: id, expectedVersion: 0 }] }, { ...change, chats: Array(51).fill(change.chats[0]) }]) assert.throws(() => extractionStaffAction(input));
    const release = { action: 'sourceRetention', jobId: id, expectedSourceVersion: 1, mode: 'release_after_review' };
    assert.deepEqual(extractionStaffAction(release), release);
    assert.equal(extractionStaffAction({ ...release, mode: 'keep' }).mode, 'keep');
    for (const input of [{ ...release, mode: 'automatic' }, { ...release, expectedSourceVersion: null }, { ...release, ownerId: id }]) assert.throws(() => extractionStaffAction(input));
    assert.equal(EXTRACTION_SINGLE_SOURCE_LIMIT, 327680);
});
