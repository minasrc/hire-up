import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function requestMaintenance({ url, secret, fetchImpl = fetch }) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash || target.pathname !== '/api/telegram-maintenance') {
        throw new Error('Invalid maintenance URL');
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret ?? '')) throw new Error('Invalid maintenance credential');
    const response = await fetchImpl(target, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(25000),
        headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Maintenance returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty maintenance response');
    const chunks = []; let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > 4096) { await reader.cancel(); throw new Error('Invalid maintenance response'); }
            chunks.push(Buffer.from(value));
        }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.analysesPurged === undefined) result.analysesPurged = 0;
    if (result.ok !== true) throw new Error('Maintenance did not complete');
    const counts = {};
    for (const key of ['ownersProcessed', 'batchesPurged', 'messagesPurged', 'bytesFreed', 'queriesExpired', 'queryResultRowsDeleted', 'analysesPurged']) {
        if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error('Invalid maintenance response');
        counts[key] = result[key];
    }
    if (typeof result.remainingWork !== 'boolean') throw new Error('Invalid maintenance response');
    return { ...counts, remainingWork: result.remainingWork };
}

export async function drainMaintenance(options, request = requestMaintenance) {
    const totals = { runs: 0, ownersProcessed: 0, batchesPurged: 0, messagesPurged: 0, bytesFreed: 0, queriesExpired: 0, queryResultRowsDeleted: 0, analysesPurged: 0, remainingWork: false };
    // Keep each hosted invocation small while allowing a scheduled run to drain
    // several pages. Held sources cannot cause an unbounded busy loop.
    for (let i = 0; i < 8; i++) {
        const result = await request(options);
        totals.runs++;
        for (const key of ['ownersProcessed', 'batchesPurged', 'messagesPurged', 'bytesFreed', 'queriesExpired', 'queryResultRowsDeleted', 'analysesPurged']) totals[key] += result[key];
        totals.remainingWork = result.remainingWork;
        if (!result.remainingWork || result.batchesPurged + result.queriesExpired + result.queryResultRowsDeleted + result.analysesPurged === 0) break;
    }
    return totals;
}

export async function runMaintenanceCommand({ environment = process.env, drain = drainMaintenance, log = console.log, error = console.error, summary = value => {
    if (environment.GITHUB_STEP_SUMMARY) appendFileSync(environment.GITHUB_STEP_SUMMARY, value);
} } = {}) {
    const url = environment.TELEGRAM_MAINTENANCE_URL;
    const secret = environment.TELEGRAM_MAINTENANCE_SECRET;
    if (!url || !secret) {
        const message = 'Telegram maintenance is not configured; no request sent. Configure both maintenance secrets before enabling Telegram intake.';
        error(message);
        summary(`Telegram cleanup failed: configuration is incomplete. No cleanup request was sent.\n`);
        return 1;
    }
    try {
        const result = await drain({ url, secret });
        log(JSON.stringify(result));
        summary(`Telegram cleanup completed ${result.runs} bounded request(s): ${result.messagesPurged} messages removed, ${result.bytesFreed} bytes freed, ${result.queryResultRowsDeleted} cached results removed.\n`);
        if (result.remainingWork) {
            log('Telegram cleanup still has pending work. Review repeated backlogs and sources held for review.');
            summary('Pending work remains. Sources awaiting review may be held; repeated backlogs require an operator check.\n');
        }
        return 0;
    } catch {
        error('Telegram maintenance failed. Check hosted configuration and service health.');
        summary('Telegram cleanup failed. No successful cleanup is established by this run.\n');
        return 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await runMaintenanceCommand();
}
