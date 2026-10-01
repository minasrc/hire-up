import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { CV_ANALYSIS_PARSER_VERSION, CV_ANALYSIS_PROMPT_VERSION, validateCvParsedResult, validateCvFactsResult, cvAnalysisStaffAction, cvAnalysisWorkerInput } from '../../src/lib/cv-analysis-contracts.js';
const sha = text => createHash('sha256').update(text).digest('hex');
const parsed = text => ({ parserVersion: CV_ANALYSIS_PARSER_VERSION, documentSha256: 'a'.repeat(64), textSha256: sha(text), blocks: [{ ordinal: 0, kind: 'pdf_page', page: 1, text, sha256: sha(text) }] });
const fact = (text, quote = text, field = 'location', value = 'Paris') => ({ facts: [{ field, value, evidence: [{ blockOrdinal: 0, startByte: 0, endByte: Buffer.byteLength(quote), quote }] }], issues: [] });

test('CV evidence covers exact UTF8 bytes and parser hashes without silent truncation', () => {
    const input = parsed('José — Paris');
    assert.deepEqual(validateCvParsedResult(input, { extension: 'pdf', documentSha256: 'a'.repeat(64) }), input);
    assert.equal(validateCvFactsResult(fact(input.blocks[0].text), input.blocks).facts[0].value, 'Paris');
    const bad = fact(input.blocks[0].text); bad.facts[0].evidence[0].endByte--;
    assert.throws(() => validateCvFactsResult(bad, input.blocks));
    assert.throws(() => validateCvParsedResult({ ...input, textSha256: 'b'.repeat(64) }));
    assert.throws(() => validateCvParsedResult(parsed('é'.repeat(32769))));
    assert.throws(() => validateCvParsedResult(parsed('bad\ud800')));
});

test('CV pages and DOCX part locators cannot omit or reorder structural blocks', () => {
    const input = parsed('Main'); input.blocks.push({ ordinal: 1, kind: 'pdf_page', page: 3, text: 'Tail', sha256: sha('Tail') }); input.textSha256 = sha('Main\n\nTail');
    assert.throws(() => validateCvParsedResult(input));
    const docx = { ...parsed('Main'), blocks: [{ ordinal: 0, kind: 'docx_paragraph', part: 'word/document.xml', paragraph: 1, text: 'Main', sha256: sha('Main') }, { ordinal: 1, kind: 'docx_paragraph', part: 'word/header1.xml', paragraph: 1, text: 'Email', sha256: sha('Email') }], textSha256: sha('Main\n\nEmail') };
    assert.equal(validateCvParsedResult(docx, { extension: 'docx' }).blocks.length, 2);
    docx.blocks[1].part = '../private.xml'; assert.throws(() => validateCvParsedResult(docx));
});

test('CV facts require literal identity evidence and cannot set account or document identity', () => {
    const input = parsed('Alice in Paris');
    assert.throws(() => validateCvFactsResult(fact(input.blocks[0].text, undefined, 'firstName', 'Bob'), input.blocks));
    assert.throws(() => validateCvFactsResult(fact(input.blocks[0].text, undefined, 'telegramUserId', '123'), input.blocks));
    const duplicate = fact(input.blocks[0].text); duplicate.facts.push(duplicate.facts[0]);
    assert.throws(() => validateCvFactsResult(duplicate, input.blocks));
    assert.throws(() => validateCvFactsResult({ ...fact(input.blocks[0].text), issues: ['NOT_A_CV'] }, input.blocks));
});

test('CV worker audit metadata and request shapes reject secrets, aliases and unknown keys', () => {
    const input = { jobId: randomUUID(), leaseToken: randomUUID(), sourceDigest: 'a'.repeat(64), stage: 'facts', result: { facts: [], issues: [] }, metadata: { model: 'configured-alias', promptVersion: CV_ANALYSIS_PROMPT_VERSION, reportedModel: 'resolved-model-v2' } };
    assert.equal(cvAnalysisWorkerInput('complete', input).metadata.reportedModel, 'resolved-model-v2');
    assert.throws(() => cvAnalysisWorkerInput('complete', { ...input, metadata: { ...input.metadata, model: 'https://private.example' } }));
    assert.throws(() => cvAnalysisWorkerInput('complete', { ...input, ownerUserId: randomUUID() }));
    assert.throws(() => cvAnalysisWorkerInput('claim', { jobId: randomUUID() }));
});

test('CV review commands carry precise version and operation guards', () => {
    assert.equal(cvAnalysisStaffAction({ action: 'analyze', draftId: randomUUID(), expectedDocumentRevision: 1, operationId: randomUUID() }).action, 'analyze');
    assert.throws(() => cvAnalysisStaffAction({ action: 'retry', analysisId: randomUUID(), expectedAnalysisVersion: null }));
    assert.throws(() => cvAnalysisStaffAction({ action: 'reviewText', analysisId: randomUUID(), expectedAnalysisVersion: 1, decision: 'pending' }));
});
