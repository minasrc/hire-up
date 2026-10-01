import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ParserError } from './errors.mjs';

const execute = promisify(execFile);
export const DEFAULT_PARSER_IMAGE = 'agora-cv-parser:v1';
export function sandboxArguments(name, image, extension) {
    return ['run', '--rm', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--user=65534:65534', '--tmpfs=/tmp:rw,noexec,nosuid,size=32m', '-i', image, extension];
}
async function assertLocalEngine() {
    try {
        // Never send private CV bytes to a remote Docker context.
        const { stdout } = await execute('docker', ['context', 'inspect'], { timeout: 3000, maxBuffer: 65536 });
        const hosts = [JSON.parse(stdout)?.[0]?.Endpoints?.docker?.Host, ...(process.env.DOCKER_HOST ? [process.env.DOCKER_HOST] : [])];
        if (hosts.some(host => typeof host !== 'string' || (!host.startsWith('unix://') && !host.startsWith('npipe://')))) throw new Error();
    } catch { throw new ParserError('WORKER_ERROR'); }
}
export async function runIsolatedParser(bytes, { extension, signal, image = DEFAULT_PARSER_IMAGE } = {}) {
    if (!['pdf', 'docx'].includes(extension) || !Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 4194304) throw new ParserError('INVALID_DOCUMENT');
    if (typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]{0,240}$/u.test(image)) throw new ParserError('WORKER_ERROR');
    if (signal?.aborted) throw new ParserError('STOPPED');
    await assertLocalEngine();
    const name = `agora-cv-parser-${randomUUID()}`;
    let child; let timer; let abort; let forced;
    try {
        // Finish creation before sending any document bytes. A cancellation can
        // then always remove an existing named container instead of racing run.
        const args = sandboxArguments(name, image, extension); args[0] = 'create';
        try { await execute('docker', args, { timeout: 5000, maxBuffer: 1024, ...(signal ? { signal } : {}) }); }
        catch { throw new ParserError(signal?.aborted ? 'STOPPED' : 'WORKER_ERROR'); }
        if (signal?.aborted) throw new ParserError('STOPPED');
        return await new Promise((resolve, reject) => {
            const chunks = []; let count = 0;
            child = spawn('docker', ['start', '-a', '-i', name], { stdio: ['pipe', 'pipe', 'ignore'] });
            const stop = code => { forced = code; child.kill('SIGKILL'); void execute('docker', ['rm', '-f', name], { timeout: 5000, maxBuffer: 1024 }).catch(() => {}); };
            abort = () => stop('STOPPED'); signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => stop('DOCUMENT_LIMIT'), 45000);
            child.on('error', () => reject(new ParserError('WORKER_ERROR')));
            child.stdout.on('data', data => { count += data.length; if (count > 1048576) stop('DOCUMENT_LIMIT'); else chunks.push(data); });
            child.stdin.on('error', () => {}); child.stdin.end(bytes);
            child.on('close', code => {
                if (forced) return reject(new ParserError(forced));
                if (code !== 0) return reject(new ParserError(code === 137 ? 'DOCUMENT_LIMIT' : 'WORKER_ERROR'));
                try {
                    const output = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (output.ok === true && output.result) return resolve(output.result);
                    if (output.ok === false && ['INVALID_DOCUMENT', 'ENCRYPTED_DOCUMENT', 'OCR_REQUIRED', 'DOCUMENT_LIMIT', 'TEXT_LIMIT'].includes(output.code)) return reject(new ParserError(output.code));
                } catch { /* Never echo raw stdout or Docker errors. */ }
                reject(new ParserError('INVALID_RESULT'));
            });
            if (signal?.aborted) abort();
        });
    } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        // Explicitly reap a timed-out container even if killing the Docker client
        // raced container creation; no parser is left running after cancellation.
        await execute('docker', ['rm', '-f', name], { timeout: 5000, maxBuffer: 1024 }).catch(() => {});
    }
}
