import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';
import { normalizeTelegramDraftFields } from './telegram-intake-contracts.js';

export const EXTRACTION_SCHEMA_VERSION = 'candidate-extraction-v1';
export const EXTRACTION_PROMPT_VERSION = 'candidate-extraction-prompt-v1';
export const EXTRACTION_BODY_LIMIT = 131072;
export const EXTRACTION_SOURCE_LIMIT = 49152;
export const EXTRACTION_SINGLE_SOURCE_LIMIT = 327680;
export const EXTRACTION_MESSAGE_LIMIT = 40;
export const EXTRACTION_FIELDS = ['firstName', 'lastName', 'primaryEmail', 'secondaryEmails', 'headline', 'location', 'professionalUrl', 'professionalSummary', 'compensationPreference'];
const objectSchema = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const messageIdSchema = { type: 'string', pattern: '^[1-9][0-9]{0,9}$' };
const evidenceSchema = objectSchema({ messageId: messageIdSchema, quote: { type: 'string', minLength: 1, maxLength: 2000 } });
export const EXTRACTION_RESULT_SCHEMA = objectSchema({ subjects: { type: 'array', maxItems: 12, items: objectSchema({
    key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,40}$' },
    identity: { anyOf: [{ type: 'null' }, objectSchema({ kind: { type: 'string', enum: ['email'] }, email: { type: 'string', maxLength: 254 } }), objectSchema({ kind: { type: 'string', enum: ['telegram_sender'] }, messageId: messageIdSchema, quote: { type: 'string', minLength: 1, maxLength: 2000 } })] },
    facts: { type: 'array', minItems: 1, maxItems: 12, items: objectSchema({ field: { type: 'string', enum: EXTRACTION_FIELDS }, value: { anyOf: [{ type: 'string', minLength: 1, maxLength: 8000 }, { type: 'array', minItems: 1, maxItems: 9, items: { type: 'string', maxLength: 254 } }] }, evidence: { type: 'array', minItems: 1, maxItems: 3, items: evidenceSchema } }) },
    attachments: { type: 'array', maxItems: 8, items: objectSchema({ messageId: messageIdSchema, attachmentIndex: { type: 'integer', minimum: 0, maximum: 15 } }) },
}) } });
const invalid = () => { throw new ClientJobContractError({ result: 'The extraction result has invalid fields or source references.' }); };
function object(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function list(value, min, max) { if (!Array.isArray(value) || value.length < min || value.length > max) invalid(); }
const text = (v, max) => typeof v === 'string' && v.isWellFormed() && v.length > 0 && v.length <= max;

// Quote validation establishes provenance, not semantic truth. Recruiters review
// every generated draft; the model never receives authority over approved data.
export function validateExtractionResult(input, source) {
    object(input, ['subjects']); list(input.subjects, 0, 12);
    const messages = new Map(source.messages.map(m => [m.messageId, m]));
    const quote = e => {
        object(e, ['messageId', 'quote']);
        const m = messages.get(e.messageId);
        if (!m || !text(e.quote, 2000) || !e.quote.trim() || !m.text.includes(e.quote)) invalid();
        return { messageId: e.messageId, quote: e.quote };
    };
    const keys = new Set();
    const subjects = input.subjects.map(s => {
        object(s, ['key', 'identity', 'facts', 'attachments']);
        if (typeof s.key !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(s.key) || keys.has(s.key)) invalid(); keys.add(s.key);
        list(s.facts, 1, 12); list(s.attachments, 0, 8);
        const fields = new Set();
        const facts = s.facts.map(f => {
            object(f, ['field', 'value', 'evidence']);
            if (!EXTRACTION_FIELDS.includes(f.field) || fields.has(f.field)) invalid(); fields.add(f.field);
            if (f.field === 'secondaryEmails') { list(f.value, 1, 9); if (f.value.some(v => !text(v, 254))) invalid(); }
            else if (!text(f.value, 8000) || !f.value.trim()) invalid();
            const value = normalizeTelegramDraftFields({ [f.field]: f.value }, { partial: true })[f.field];
            list(f.evidence, 1, 3); const evidence = f.evidence.map(quote);
            if (new Set(evidence.map(e => `${e.messageId}\0${e.quote}`)).size !== evidence.length) invalid();
            if (['firstName', 'lastName', 'primaryEmail', 'secondaryEmails'].includes(f.field)) {
                for (const v of Array.isArray(value) ? value : [value]) if (!evidence.some(e => e.quote.toLowerCase().includes(v.toLowerCase()))) invalid();
            }
            return { field: f.field, value, evidence };
        });
        // Validate primary/secondary consistency together, not only individual facts.
        normalizeTelegramDraftFields(Object.fromEntries(facts.map(f => [f.field, f.value])), { partial: true });
        let identity = null;
        if (s.identity !== null) {
            if (s.identity?.kind === 'email') {
                object(s.identity, ['kind', 'email']);
                const email = normalizeTelegramDraftFields({ primaryEmail: s.identity.email }, { partial: true }).primaryEmail;
                if (!email || !facts.some(f => f.field === 'primaryEmail' && f.value === email || f.field === 'secondaryEmails' && f.value.includes(email))) invalid();
                identity = { kind: 'email', email };
            } else if (s.identity?.kind === 'telegram_sender') {
                object(s.identity, ['kind', 'messageId', 'quote']);
                quote({ messageId: s.identity.messageId, quote: s.identity.quote });
                const m = messages.get(s.identity.messageId);
                if (m.sender?.peer?.kind !== 'user' || !/^[1-9][0-9]{0,29}$/.test(m.sender.peer.id) || m.forwardedFrom !== null) invalid();
                identity = { ...s.identity };
            } else invalid();
        }
        const attachmentKeys = new Set();
        const attachments = s.attachments.map(a => {
            object(a, ['messageId', 'attachmentIndex']);
            const m = messages.get(a.messageId); const key = `${a.messageId}:${a.attachmentIndex}`;
            if (!m || !Number.isInteger(a.attachmentIndex) || a.attachmentIndex < 0 || !m.attachments[a.attachmentIndex] || attachmentKeys.has(key)) invalid();
            attachmentKeys.add(key); return { ...a };
        });
        return { key: s.key, identity, facts, attachments };
    });
    return { subjects };
}

export function extractionStaffAction(input) {
    if (input?.action === 'setExtraction') {
        object(input, ['action', 'chats', 'enabled']); list(input.chats, 1, 50);
        if (typeof input.enabled !== 'boolean') invalid();
        const chats = input.chats.map(c => { object(c, ['chatId', 'expectedVersion']); if (!Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 1) invalid(); return { chatId: assertUuid(c.chatId, 'chatId'), expectedVersion: c.expectedVersion }; });
        if (new Set(chats.map(c => c.chatId)).size !== chats.length) invalid(); return { action: input.action, chats, enabled: input.enabled };
    }
    if (input?.action === 'sourceRetention') {
        object(input, ['action', 'jobId', 'expectedSourceVersion', 'mode']);
        if (!Number.isSafeInteger(input.expectedSourceVersion) || input.expectedSourceVersion < 1 || !['keep', 'release_after_review'].includes(input.mode)) invalid();
        return { ...input, jobId: assertUuid(input.jobId, 'jobId') };
    }

    if (input?.action === 'enqueue') {
        object(input, ['action', 'chatIds']); list(input.chatIds, 1, 50);
        const chatIds = input.chatIds.map(id => assertUuid(id, 'chatIds'));
        if (new Set(chatIds).size !== chatIds.length) invalid(); return { action: input.action, chatIds };
    }
    if (['retry', 'reviewBatch'].includes(input?.action)) { object(input, ['action', 'jobId']); return { action: input.action, jobId: assertUuid(input.jobId, 'jobId') }; }
    if (input?.action === 'resolve') {
        object(input, ['action', 'proposalId', 'decision', 'expectedDraftVersion']);
        if (!['apply', 'dismiss'].includes(input.decision) || !Number.isSafeInteger(input.expectedDraftVersion) || input.expectedDraftVersion < 1) invalid();
        return { ...input, proposalId: assertUuid(input.proposalId, 'proposalId') };
    }
    invalid();
}
export function extractionWorkerInput(action, input) {
    if (action === 'claim') { object(input, []); return {}; }
    if (action === 'complete') {
        object(input, ['jobId', 'leaseToken', 'sourceDigest', 'result', 'metadata']);
        object(input.metadata, ['model', 'promptVersion', 'reportedModel']);
        const model = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(value) && !value.includes('://');
        if (!model(input.metadata.model) || input.metadata.promptVersion !== EXTRACTION_PROMPT_VERSION || input.metadata.reportedModel !== null && !model(input.metadata.reportedModel)) invalid();
        if (!/^[0-9a-f]{64}$/.test(input.sourceDigest)) invalid();
    } else if (action === 'fail') {
        object(input, ['jobId', 'leaseToken', 'code', 'retryAfterSeconds']);
        if (!['PROVIDER_UNAVAILABLE', 'INVALID_RESULT', 'WORKER_ERROR'].includes(input.code) || !Number.isInteger(input.retryAfterSeconds) || input.retryAfterSeconds < 1 || input.retryAfterSeconds > 3600) invalid();
    } else invalid();
    return { ...input, jobId: assertUuid(input.jobId, 'jobId'), leaseToken: assertUuid(input.leaseToken, 'leaseToken') };
}
