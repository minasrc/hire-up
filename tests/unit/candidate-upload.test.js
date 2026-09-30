import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCandidateUploadFields, assertCandidateCvFilename } from '../../src/lib/candidate-upload-contracts.js';
import { cleanupCandidateUpload, candidateCvObjectKey } from '../../src/lib/candidate-upload-storage.js';
import { ClientJobContractError } from '../../src/lib/client-job-contracts.js';
const fields = { firstName: ' Ada ', lastName: 'Lovelace', primaryEmail: 'ADA@EXAMPLE.TEST', secondaryEmails: [' Other@Example.test '], headline: '', location: 'Madrid', professionalUrl: '', ownerMembershipId: null, professionalSummary: '', compensationPreference: ' EUR 100k ' };
test('required upload fields normalize independently and optional fields persist', () => {
    assert.deepEqual(validateCandidateUploadFields(fields), { firstName: 'Ada', lastName: 'Lovelace', primaryEmail: 'ada@example.test', secondaryEmails: ['other@example.test'], headline: null, location: 'Madrid', professionalUrl: null, ownerMembershipId: null, professionalSummary: null, compensationPreference: 'EUR 100k' });
    assert.deepEqual(validateCandidateUploadFields({ ...fields, secondaryEmails: [] }).secondaryEmails, []);
});
test('names, primary email and unique secondary emails are required and bounded', () => {
    for (const patch of [{ firstName: '' }, { lastName: '' }, { firstName: 'a'.repeat(61) }, { primaryEmail: '' }, { secondaryEmails: ['ADA@example.test'] }, { secondaryEmails: ['one@example.test', 'ONE@EXAMPLE.TEST'] }, { secondaryEmails: ['bad'] }, { secondaryEmails: Array.from({ length: 10 }, (_, i) => `${i}@example.test`) }, { compensationPreference: 'a'.repeat(501) }]) {
        assert.throws(() => validateCandidateUploadFields({ ...fields, ...patch }), ClientJobContractError);
    }
});
test('unusable CV filenames rejected; object names contain no user filename', () => {
    for (const value of ['', 'a\nb.pdf', 'a'.repeat(513)]) assert.throws(() => assertCandidateCvFilename(value), ClientJobContractError);
    assert.match(candidateCvObjectKey('org', 'candidate', 'pdf'), /^staff\/org\/candidate\/[a-f0-9-]+\.pdf$/);
});
test('cleanup removes only definitely unreferenced objects, retaining ambiguous commits', async () => {
    let removed = 0;
    const remove = async () => { removed++; };
    for (const referenced of [true, null, undefined]) await cleanupCandidateUpload({ check: async () => referenced, remove });
    assert.equal(removed, 0);
    await cleanupCandidateUpload({ check: async () => { throw { code: 'CONNECTION_LOST' }; }, remove });
    assert.equal(removed, 0);
    await cleanupCandidateUpload({ check: async () => false, remove });
    assert.equal(removed, 1);
});
