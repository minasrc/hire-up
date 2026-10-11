import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const checker = fileURLToPath(new URL('../../scripts/check-public-files.mjs', import.meta.url));

test('public file check accepts examples and rejects force-added secrets and build output', (t) => {
    const repo = mkdtempSync(join(tmpdir(), 'hire-up-public-files-'));
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    const add = (file) => {
        const path = join(repo, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'placeholder only\n');
        execFileSync('git', ['add', '--force', '--', file], { cwd: repo });
    };
    add('.env.example');
    add('services/example/.env.example');
    add('src/config.js');
    assert.equal(spawnSync(process.execPath, [checker], { cwd: repo }).status, 0);

    const forbidden = ['.env', '.env.production', 'services/example/.env.test',
        '.next/server/server-reference-manifest.json', '.runtime/session.json',
        'private/credential.json', 'private/telegram.session', 'private/telegram.session-journal'];
    for (const file of forbidden) add(file);
    const result = spawnSync(process.execPath, [checker], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 1);
    for (const file of forbidden) assert.ok(result.stderr.includes(file), file);
    assert.ok(!result.stderr.includes('placeholder only'));
});
