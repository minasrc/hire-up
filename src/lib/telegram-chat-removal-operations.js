import { withStaffTransaction } from './staff-authorization.js';
import { telegramChatRemovalInput } from './telegram-chat-removal-contracts.js';

export function telegramChatRemovalOperation(pool, identity, org, input) {
    const p = telegramChatRemovalInput(input);
    const args = [p.chatId];
    let sql;
    if (p.action === 'request') {
        sql = 'select app.telegram_chat_removal_request_v1($1,$2,$3,$4) result';
        args.push(p.expectedVersion, p.operationId, p.confirmation);
    } else if (p.action === 'reimport') {
        sql = 'select app.telegram_chat_removal_reimport_v1($1,$2,$3) result';
        args.push(p.expectedVersion, p.operationId);
    } else {
        sql = p.action === 'preview'
            ? 'select app.telegram_chat_removal_preview_v1($1) result'
            : 'select app.telegram_chat_removal_status_v1($1) result';
    }
    return withStaffTransaction(
        pool, identity, org, ['candidates.read', 'candidates.write'],
        async ({ client }) => (await client.query(sql, args)).rows[0].result,
    );
}
