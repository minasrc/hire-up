import assert from 'node:assert/strict';
import test from 'node:test';
import { compensationDisplay, compensationValue, friendlyJobErrors, jobPreviewLocations } from '../../src/lib/job-form-ui.js';

test('compensation display preserves decimal precision and strips pasted grouping and currency', () => {
    assert.equal(compensationValue('GBP £80,000.50'), '80000.50');
    assert.equal(compensationDisplay('80000.50'), '80,000.50');
    assert.equal(compensationDisplay('80000.'), '80,000.');
    assert.equal(compensationValue('-100'), '-100');
    assert.equal(compensationDisplay('abc'), 'abc');
});

test('job validation explains the bad location and salary range without exposing field paths', () => {
    const messages = friendlyJobErrors({
        'remoteRegions[1]': 'select a supported location',
        compensationMax: 'must be greater than or equal to compensationMin',
        currency: 'must be three uppercase letters',
    }, { remoteRegions: ['London', 'Unknown place'], compensationMin: '80000' });
    assert.deepEqual(messages, {
        remoteRegions: 'Choose a location from the suggestions for “Unknown place”.',
        compensationMax: 'Maximum must be at least 80,000.',
        currency: 'Choose a currency.',
    });
    assert.equal(friendlyJobErrors({ 'bonuses[0].type': 'duplicate type' }).bonuses, 'Use each bonus type only once.');
    assert.equal(friendlyJobErrors({ descriptionDocument: 'doc.content[0] is not allowed here' }).descriptionDocument.includes('doc.content'), false);
});

test('job preview shows each place once and omits remote eligibility for onsite roles', () => {
    assert.deepEqual(jobPreviewLocations(['New York'], ['new york', 'London'], 'hybrid'), ['New York', 'London']);
    assert.deepEqual(jobPreviewLocations(['New York'], ['London'], 'onsite'), ['New York']);
});
