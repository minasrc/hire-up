import { createWorker, loadConfig } from './worker.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
    const args = process.argv.slice(2);
    let configPath;
    let once = false;
    while (args.length) {
        const argument = args.shift();
        if (argument === '--once') once = true;
        else if (argument === '--config' && args.length && !configPath) configPath = args.shift();
        else throw new Error();
    }
    const config = await loadConfig(configPath);
    const status = await createWorker(config, { signal: controller.signal }).run({ once });
    if (once && !['COMPLETED', 'IDLE', 'STOPPED'].includes(status)) process.exitCode = 1;
} catch {
    console.error('WORKER_CONFIGURATION_ERROR');
    process.exitCode = 1;
} finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
}
