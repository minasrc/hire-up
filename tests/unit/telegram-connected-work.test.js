import assert from 'node:assert/strict';
import test from 'node:test';
import { createConnectedWork } from '../../services/telegram-connector/connected-work.mjs';

test('history, CV retrieval and source repair get one fair lane per tick despite a failed lane', async () => {
    const calls = [], context = { connectionId: 'synthetic' };
    const lane = name => ({ tick: async actual => {
        assert.equal(actual, context); calls.push(name);
        if (calls.length === 1) throw Error('temporary provider failure');
        return name;
    } });
    const schedule = createConnectedWork({ cv: lane('cv'), history: lane('history'), updates: lane('source') });
    await assert.rejects(schedule(context), /temporary provider failure/);
    for (let index = 0; index < 8; index++) await schedule(context);
    assert.deepEqual(calls, ['cv','history','source','cv','history','source','cv','history','source']);
});
