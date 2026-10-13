import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROXY_VERSION = '8.0.27';
export const EXTRACTION_MODEL = 'gpt-6-luna';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const proxyDirectory = join(root, '.runtime/cli-proxy');
export const providerTokenFile = join(proxyDirectory, 'provider.token');
export const providerBaseUrl = 'http://127.0.0.1:8317/v1';
const binary = join(proxyDirectory, 'cli-proxy-api');
const config = join(proxyDirectory, 'config.yaml');

export async function verifyProxyModel() {
    if (!existsSync(providerTokenFile)) throw new Error('Run npm run proxy:setup first.');
    const authDirectory = join(proxyDirectory, 'auth');
    if (!existsSync(authDirectory) || !readdirSync(authDirectory).some(name => name.endsWith('.json'))) throw new Error('Complete npm run proxy:login first.');
    const response = await fetch(`${providerBaseUrl}/models`, { redirect: 'error', headers: { Authorization: `Bearer ${readFileSync(providerTokenFile, 'utf8').trim()}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('CLIProxyAPI is unavailable or requires sign-in. Start it and run npm run proxy:login.');
    const result = await response.json();
    const models = result.data?.map(item => item.id).filter(id => typeof id === 'string') ?? [];
    if (!models.includes(EXTRACTION_MODEL)) throw new Error(`${EXTRACTION_MODEL} is not available. ${models.length ? `Available GPT models: ${models.filter(id => id.startsWith('gpt-')).join(', ')}` : 'Complete npm run proxy:login first.'}`);
    return EXTRACTION_MODEL;
}
async function setup() {
    mkdirSync(proxyDirectory, { recursive: true, mode: 0o700 }); chmodSync(proxyDirectory, 0o700);
    if (!existsSync(binary)) {
        const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
        const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'amd64' : null;
        if (!platform || !arch) throw new Error('This launcher supports macOS and Linux on ARM64 or x64.');
        const name = `CLIProxyAPI_${PROXY_VERSION}_${platform}_${arch}.tar.gz`;
        const release = `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${PROXY_VERSION}`;
        const archiveResponse = await fetch(`${release}/${name}`);
        const checksumResponse = await fetch(`${release}/checksums.txt`);
        if (!archiveResponse.ok || !checksumResponse.ok) throw new Error('Official CLIProxyAPI release download failed.');
        const archive = Buffer.from(await archiveResponse.arrayBuffer());
        const expected = (await checksumResponse.text()).split('\n').find(line => line.trim().endsWith(name))?.split(/\s+/)[0];
        if (!expected || createHash('sha256').update(archive).digest('hex') !== expected) throw new Error('CLIProxyAPI checksum verification failed.');
        const path = join(proxyDirectory, name); writeFileSync(path, archive, { mode: 0o600 });
        execFileSync('tar', ['-xzf', path, '-C', proxyDirectory, 'cli-proxy-api', 'config.example.yaml', 'LICENSE']);
        chmodSync(binary, 0o700);
    }
    mkdirSync(join(proxyDirectory, 'auth'), { mode: 0o700, recursive: true });
    if (!existsSync(providerTokenFile)) writeFileSync(providerTokenFile, randomBytes(36).toString('base64url') + '\n', { mode: 0o600 });
    if (!existsSync(config)) {
        const token = readFileSync(providerTokenFile, 'utf8').trim();
        writeFileSync(config, `config-version: 8\nserver:\n  host: "127.0.0.1"\n  port: 8317\naccess:\n  api-keys:\n    - ${JSON.stringify(token)}\noauth:\n  auth-dir: ${JSON.stringify(join(proxyDirectory, 'auth'))}\nmanagement:\n  secret-key: ""\n  disable-control-panel: true\nobservability:\n  logs:\n    debug: false\n    request-log: false\n  usage:\n    usage-statistics-enabled: false\n`, { mode: 0o600 });
    }
    console.log(`CLIProxyAPI ${PROXY_VERSION} is configured on localhost:8317.`);
}
async function main(command) {
    if (command === 'setup') return setup();
    if (command === 'check') { console.log(`Extraction model ready: ${await verifyProxyModel()}`); return; }
    if (!['start','login'].includes(command)) throw new Error('Use setup, start, login or check.');
    if (!existsSync(binary) || !existsSync(config)) throw new Error('Run npm run proxy:setup first.');
    const child = spawn(binary, ['-config', config, ...(command === 'login' ? ['-codex-device-login', '-no-browser'] : [])], { cwd: proxyDirectory, stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await new Promise(resolve => child.once('exit', code => { process.exitCode = code ?? 1; resolve(); }));
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
