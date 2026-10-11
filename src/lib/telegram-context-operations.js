import { withStaffTransaction } from './staff-authorization.js';
import { ClientJobContractError } from './client-job-contracts.js';
import { contextPost, contextGet } from './telegram-context-contracts.js';
async function run(pool, identity, org, name, input) {
    return withStaffTransaction(pool, identity, org, ['candidates.read'], async ({ client }) => {
        try {
            const result = (await client.query(`select app.${name}($1::jsonb) as result`, [JSON.stringify(input)])).rows[0].result;
            if (result.nextAfter) result.nextAfter = Buffer.from(JSON.stringify(result.nextAfter)).toString('base64url');
            return result;
        } catch (error) {
            if (error.code === '22023') throw new ClientJobContractError({ query: error.message === 'positive search term required' ? 'Enter a positive search term; punctuation or exclusions alone cannot be searched.' : 'Invalid search request or pagination cursor. Restart the search.' });
            throw error;
        }
    });
}
export const telegramContextSearch = (pool, identity, org, input) => run(pool, identity, org, 'telegram_context_search_v1', contextPost(input));
export const telegramContextView = (pool, identity, org, input) => run(pool, identity, org, 'telegram_context_view_v1', contextGet(input));
