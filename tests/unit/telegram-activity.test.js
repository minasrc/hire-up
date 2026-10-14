import assert from 'node:assert/strict';
import test from 'node:test';
import { activeExtractionCount, telegramImportInProgress } from '../../src/app/staff/telegram-intake/telegram-activity-model.js';
import { extractionStatus } from '../../src/app/staff/telegram-intake/extraction/extraction-model.js';

test('paused backlog is not active work; mixed queues still show genuine processing', () => {
    assert.equal(activeExtractionCount({ counts: { active: 0, paused: 75, queued: 75 } }), 0);
    assert.equal(activeExtractionCount({ counts: { active: 2, paused: 75, queued: 77 } }), 2);
    assert.equal(activeExtractionCount({ counts: { queued: 1, leased: 0, waiting: 0 }, jobs: [{ status: 'queued', extractionEnabled: false }] }), 0);
    assert.equal(extractionStatus({ status: 'queued', extractionEnabled: false }), 'Paused');
    assert.equal(extractionStatus({ status: 'leased', extractionEnabled: false, processingPaused: false }), 'Extracting');
    assert.equal(extractionStatus({ status: 'leased', extractionEnabled: false, processingPaused: true }), 'Paused');
});
test('ongoing sync does not pretend to be an initial candidate import', () => {
    assert.equal(telegramImportInProgress([{ historyCompleted: true, import: { status: 'queued' } }]), false);
    assert.equal(telegramImportInProgress([{ historyCompleted: false, import: { status: 'leased' } }]), true);
    assert.equal(telegramImportInProgress([{ historyCompleted: false, import: { status: 'paused' } }]), false);
    assert.equal(telegramImportInProgress([]), false);
});
