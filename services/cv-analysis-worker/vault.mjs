import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, openSync, closeSync, writeFileSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { privateDirectory, readPrivateFile } from '../telegram-connector/vault.mjs';

const MAX_PLAIN = 1048576 + 4096;
export function createPendingStore({ root, server, workerToken }) {
    const scope = `cv-analysis-v1:${new URL(server).origin}:${createHash('sha256').update(workerToken).digest('hex')}`;
    privateDirectory(resolve(root));
    const directory = join(resolve(root), createHash('sha256').update(scope).digest('hex')); privateDirectory(directory);
    const path = join(directory, 'pending.json'); const keyPath = join(directory, 'key.json');
    const syncDirectory = () => { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
    const write = (target, text) => {
        const temporary = `${target}.${randomBytes(12).toString('hex')}.tmp`; const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(temporary, target); syncDirectory();
    };
    if (!existsSync(keyPath)) write(keyPath, JSON.stringify({ key: randomBytes(32).toString('base64') }));
    const key = Buffer.from(JSON.parse(readPrivateFile(keyPath)).key, 'base64');
    if (key.length !== 32) throw new Error('INVALID_LOCAL_STATE');
    return {
        load() {
            if (!existsSync(path)) return null;
            const record = JSON.parse(readPrivateFile(path, 1500000));
            const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64')); decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
            const clear = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
            if (clear.length > MAX_PLAIN) throw new Error('INVALID_LOCAL_STATE');
            try { return JSON.parse(clear.toString('utf8')); } finally { clear.fill(0); }
        },
        save(value) {
            const clear = Buffer.from(JSON.stringify(value)); if (clear.length > MAX_PLAIN) throw new Error('INVALID_LOCAL_STATE');
            const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(scope));
            try { const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]); write(path, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })); }
            finally { clear.fill(0); }
        },
        clear() { try { unlinkSync(path); syncDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
    };
}
