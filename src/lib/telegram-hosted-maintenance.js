import { hostedControlInput, hostedUuid } from './telegram-hosted-contracts.js';

async function transaction(pool, sql, args) {
    const client = await pool.connect();
    try {
        await client.query("begin; set local role app_telegram_hosted_service; set local statement_timeout='10s'; set local lock_timeout='500ms'");
        const result = (await client.query(sql, args)).rows[0].result;
        await client.query('commit');
        return result;
    } catch (error) {
        await client.query('rollback').catch(() => {});
        throw error;
    } finally { client.release(); }
}

// Storage keys stay inside this server helper. The Mac gets aggregate status
// only, and cannot supply a destination or request an arbitrary object deletion.
export async function cleanupHostedTelegramStorage(pool, serviceId, input, storage) {
    hostedUuid(serviceId);
    const { instanceId, leaseToken } = hostedControlInput(input);
    if (input.action !== 'maintenance' || !storage) return { removed: 0, deferred: 0 };
    const args = [serviceId, instanceId, leaseToken];
    const objects = await transaction(pool, 'select app.telegram_hosted_storage_claim_v1($1,$2,$3) result', args);
    if (!Array.isArray(objects) || objects.length > 2) throw new Error('INVALID_CLEANUP_RESULT');
    const summary = { removed: 0, deferred: 0 };
    for (const object of objects) {
        try {
            hostedUuid(object.organizationId); hostedUuid(object.ownerUserId); hostedUuid(object.removalId);
            const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
            if (typeof object.objectKey !== 'string' || !new RegExp(`^staff/${object.organizationId}/${uuid}/${uuid}\\.(pdf|docx)$`, 'i').test(object.objectKey)) throw new Error('INVALID_CLEANUP_RESULT');
            const response = await storage.storage.from('cv-submissions').remove([object.objectKey]);
            if (!response || response.error) throw new Error('STORAGE_UNAVAILABLE');
            const finished = await transaction(pool, 'select app.telegram_hosted_storage_finish_v1($1,$2,$3,$4,$5) result',
                [...args, object.removalId, object.objectKey]);
            if (finished !== true) throw new Error('CLEANUP_DEFERRED');
            summary.removed++;
        } catch {
            summary.deferred++;
            // Keep the deleting fence, but durably defer a failed provider call.
            await transaction(pool, 'select app.telegram_hosted_storage_finish_v1($1,$2,$3,$4,$5,false) result',
                [...args, object.removalId, object.objectKey]).catch(() => {});
        }
    }
    return summary;
}
