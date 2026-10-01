import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sandboxArguments, parserLaunchLabel, runIsolatedParser } from '../../services/cv-analysis-worker/sandbox.mjs';

const original = ['run', '--rm', '--pull=never', '--name', 'synthetic-container', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=512m', '--memory-swap=512m', '--cpus=1', '--user=65534:65534', '--tmpfs=/tmp:rw,noexec,nosuid,size=32m', '-i', 'agora-cv-parser:v1', 'pdf'];
function environment(t, value) {
    const previous = process.env.AGORA_MAC_LAUNCH_ID;
    if (value === undefined) delete process.env.AGORA_MAC_LAUNCH_ID; else process.env.AGORA_MAC_LAUNCH_ID = value;
    t.after(() => { if (previous === undefined) delete process.env.AGORA_MAC_LAUNCH_ID; else process.env.AGORA_MAC_LAUNCH_ID = previous; });
}

test('standalone parser retains exact original Docker flags and no launch label', t => {
    environment(t, undefined);
    assert.deepEqual(sandboxArguments('synthetic-container', 'agora-cv-parser:v1', 'pdf'), original);
    assert.deepEqual(parserLaunchLabel(), []);
});
test('launcher environment adds exactly one ownership label without relaxing sandbox limits', t => {
    const launch = randomUUID(); environment(t, launch);
    const args = sandboxArguments('synthetic-container', 'agora-cv-parser:v1', 'pdf');
    const position = args.indexOf('--label'); assert.ok(position > 0 && position < args.indexOf('-i'));
    assert.equal(args[position + 1], `agora.mac-launch=${launch}`);
    args.splice(position, 2); assert.deepEqual(args, original);
    assert.deepEqual(parserLaunchLabel(randomUUID()).slice(0, 1), ['--label']);
});
test('invalid launch metadata fails with a fixed code before parser work', async t => {
    for (const value of ['', 'secret-token', `${randomUUID()}\nsecret`, '--privileged', 'https://secret.example', null, 12]) {
        assert.throws(() => parserLaunchLabel(value), error => error.code === 'WORKER_ERROR' && error.message === 'WORKER_ERROR');
    }
    environment(t, 'private-invalid-launch-marker');
    await assert.rejects(runIsolatedParser(Buffer.from('synthetic document'), { extension: 'pdf' }), error => error.code === 'WORKER_ERROR' && !String(error).includes('private-invalid-launch-marker'));
});
