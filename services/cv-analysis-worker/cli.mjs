#!/usr/bin/env node
import { createHostedCredentialGuard } from '../worker-pairing/hosted-credential.mjs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, unlockStoppedProcess } from '../telegram-connector/vault.mjs';
import { loadConfig, readToken } from './config.mjs';
import { requestJson, createContentReader } from './transport.mjs';
import { createCvAnalysisWorker } from './worker.mjs';
import { createCvAnalysisProvider } from './provider.mjs';
import { createPendingStore } from './vault.mjs';
import { runIsolatedParser } from './sandbox.mjs';
import { ParserError } from './errors.mjs';

const SAFE = new Set(['INVALID_CONFIG', 'PROVIDER_NOT_CONFIGURED', 'CREDENTIAL_UNAVAILABLE', 'INVALID_JOB', 'INVALID_LOCAL_STATE', 'HTTP_UNAVAILABLE', 'INVALID_RESPONSE', 'INVALID_PAYLOAD', 'WORKER_ERROR', 'STOPPED', 'CONNECTOR_ALREADY_LOCKED', 'CONNECTOR_STILL_RUNNING', 'CANNOT_VERIFY_LOCK']);
export const safeErrorCode = error => SAFE.has(error?.code ?? error?.message) ? error.code ?? error.message : 'WORKER_ERROR';
export async function main(args = process.argv.slice(2)) {
    if (process.versions.node.split('.')[0] !== '22') throw new ParserError('INVALID_CONFIG');
    if (args[0] === '--help') { process.stdout.write('Usage: node services/cv-analysis-worker/cli.mjs --config /private/config.json [--once | --unlock]\n'); return; }
    let path; let once = false; let unlock = false;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--config' && args[i + 1]) path = args[++i]; else if (args[i] === '--once') once = true; else if (args[i] === '--unlock') unlock = true; else throw new ParserError('INVALID_CONFIG');
    }
    const config = await loadConfig(path);
    if (unlock) { unlockStoppedProcess(config.stateDirectory); return; }
    const release = acquireLock(config.stateDirectory); const shutdown = new AbortController(); const stop = () => shutdown.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        const credential = await createHostedCredentialGuard(config, readToken);
        const workerToken = credential.workerToken;
        const checkToken = () => credential.check();
        const host = async (action, body, { signal } = {}) => { await checkToken(); return requestJson(`${config.serverUrl}/api/cv-analysis/worker/${action}`, workerToken, body, { signal, timeoutMs: 15000, maxRequestBytes: body.stage === 'parse' && action === 'complete' ? 1048576 : 131072, maxResponseBytes: action === 'claim' ? 1048576 : 131072 }); };
        const worker = createCvAnalysisWorker({ host, readContent: createContentReader({ serverUrl: config.serverUrl, workerToken, checkToken }), parse: (bytes, options) => runIsolatedParser(bytes, { ...options, image: config.parserImage }), extract: createCvAnalysisProvider(config), vault: createPendingStore({ root: config.stateDirectory, server: config.serverUrl, workerToken }) });
        let failures = 0;
        do {
            let pause;
            try { const status = await worker.tick({ signal: shutdown.signal }); failures = 0; pause = status === 'idle' ? 5000 : 50; if (once) process.stdout.write(`${status}\n`); }
            catch (error) {
                if (shutdown.signal.aborted) break;
                process.stderr.write(`${safeErrorCode(error)}\n`);
                if (once || [401, 403].includes(error.status) || ['INVALID_JOB', 'INVALID_LOCAL_STATE', 'CREDENTIAL_UNAVAILABLE'].includes(error.code)) throw new ParserError(safeErrorCode(error));
                pause = Math.min(30000, 1000 * 2 ** Math.min(++failures, 5));
            }
            if (!once && !shutdown.signal.aborted) await delay(pause, undefined, { signal: shutdown.signal }).catch(() => {});
        } while (!once && !shutdown.signal.aborted);
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`${safeErrorCode(error)}\n`); process.exitCode = 1; });
