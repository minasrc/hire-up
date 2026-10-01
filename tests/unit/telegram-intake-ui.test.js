import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const compiled = ts.transpileModule(
    readFileSync(new URL('../../src/app/staff/telegram-intake/intake-model.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const { editableFields, fieldsForSave, errorFields, draftStatus } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('profile editor does not submit the immutable Telegram user ID or evidence', () => {
    const fields = editableFields({ firstName: 'Ada', telegramUserId: '90001', telegramUsername: 'ada_dev', evidence: 'private message', secondaryEmails: ['ada@example.test'] });
    const payload = fieldsForSave(fields);
    assert.equal(payload.firstName, 'Ada');
    assert.equal(payload.telegramUsername, 'ada_dev');
    assert.equal(Object.hasOwn(payload, 'telegramUserId'), false);
    assert.equal(Object.hasOwn(payload, 'evidence'), false);
    assert.deepEqual(payload.secondaryEmails, ['ada@example.test']);
});

test('secondary emails retain separate addresses when pasted as lines or comma-separated text', () => {
    assert.deepEqual(fieldsForSave({ secondaryEmails: 'one@example.test, two@example.test\nthree@example.test;\n' }).secondaryEmails,
        ['one@example.test', 'two@example.test', 'three@example.test']);
    assert.deepEqual(fieldsForSave({ secondaryEmails: '' }).secondaryEmails, []);
});

test('approval shows every missing requirement and server validation message', () => {
    assert.deepEqual(errorFields(['firstName', 'lastName', 'primaryEmail', 'cv']), {
        firstName: 'First name is required.', lastName: 'Last name is required.',
        primaryEmail: 'Primary email is required.', cv: 'CV is required.',
    });
    assert.deepEqual(errorFields({ primaryEmail: ['Enter an email.', 'Email is invalid.'], cv: 'Upload a validated CV.' }), {
        primaryEmail: 'Enter an email. Email is invalid.', cv: 'Upload a validated CV.',
    });
});

test('complete snoozed and duplicate drafts do not present as ready', () => {
    for (const [status, label] of [['snoozed', 'Snoozed'], ['duplicate', 'Duplicate'], ['approved', 'Approved'], ['discarded', 'Discarded']]) {
        assert.equal(draftStatus({ status, missingFields: [] }), label);
    }
    assert.equal(draftStatus({ status: 'pending', missingFields: ['cv'] }), 'Needs information');
    assert.equal(draftStatus({ status: 'pending', missingFields: [] }), 'Ready');
});
