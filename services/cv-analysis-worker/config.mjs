import { resolve, dirname } from 'node:path';
import { readPrivateFile, validateConfig } from '../telegram-extraction-worker/config.mjs';
import { DEFAULT_PARSER_IMAGE } from './sandbox.mjs';
export { readToken } from '../telegram-extraction-worker/config.mjs';
export async function loadConfig(path, env = process.env) {
    let raw = {};
    if (path) { try { raw = JSON.parse(await readPrivateFile(resolve(path))); } catch { const error = new Error('INVALID_CONFIG'); error.code = 'INVALID_CONFIG'; throw error; } }
    const base = path ? dirname(resolve(path)) : process.cwd();
    const merged = {};
    for (const [name, variable] of Object.entries({ serverUrl: 'SERVER_URL', workerTokenFile: 'WORKER_TOKEN_FILE', providerBaseUrl: 'PROVIDER_BASE_URL', providerModel: 'PROVIDER_MODEL', providerTokenFile: 'PROVIDER_TOKEN_FILE' })) merged[name] = env[`CV_ANALYSIS_${variable}`] ?? raw[name];
    for (const name of ['workerTokenFile', 'providerTokenFile']) if (merged[name]) merged[name] = resolve(base, merged[name]);
    merged.stateDirectory = resolve(base, env.CV_ANALYSIS_STATE_DIRECTORY ?? raw.stateDirectory ?? 'services/cv-analysis-worker/.runtime');
    const config = validateConfig(merged);
    return { ...config, parserImage: env.CV_ANALYSIS_PARSER_IMAGE ?? raw.parserImage ?? DEFAULT_PARSER_IMAGE };
}
