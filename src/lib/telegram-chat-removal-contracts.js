import { ClientJobContractError } from './client-job-contracts.js';
import { assertUuid } from './candidate-profile-contracts.js';

export function telegramChatRemovalInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ClientJobContractError({ input: 'Invalid removal request.' });
    }
    const keys = input.action === 'request'
        ? ['action', 'chatId', 'expectedVersion', 'operationId', 'confirmation']
        : input.action === 'reimport'
            ? ['action', 'chatId', 'expectedVersion', 'operationId']
            : ['action', 'chatId'];
    if (!['preview', 'status', 'request', 'reimport'].includes(input.action)
        || Object.keys(input).some(key => !keys.includes(key))) {
        throw new ClientJobContractError({ action: 'Invalid removal action.' });
    }
    const result = { action: input.action, chatId: assertUuid(input.chatId, 'chatId') };
    if (['request', 'reimport'].includes(input.action)) {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
            throw new ClientJobContractError({ expectedVersion: 'Refresh this chat before continuing.' });
        }
        result.expectedVersion = input.expectedVersion;
        result.operationId = assertUuid(input.operationId, 'operationId');
    }
    if (input.action === 'request') {
        if (input.confirmation !== 'remove_imported_history') {
            throw new ClientJobContractError({ confirmation: 'Confirm removal of imported history.' });
        }
        result.confirmation = input.confirmation;
    }
    return result;
}
