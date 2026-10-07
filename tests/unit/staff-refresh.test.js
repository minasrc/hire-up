import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaffRefresh, taskCompletionView } from '../../src/lib/staff-refresh.js';

test('refresh bursts share one read and in-flight updates receive one trailing read', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    let finish;
    const refresh = createStaffRefresh(() => {
        calls += 1;
        return new Promise((resolve) => { finish = resolve; });
    });
    refresh.schedule();
    refresh.schedule();
    t.mock.timers.tick(100);
    assert.equal(calls, 1);
    refresh.schedule();
    refresh.schedule();
    t.mock.timers.tick(100);
    assert.equal(calls, 1);
    finish();
    await Promise.resolve();
    t.mock.timers.tick(100);
    assert.equal(calls, 2);
    finish();
    await Promise.resolve();
    refresh.dispose();
});

test('disposing a pending refresh prevents requests after unmount', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const refresh = createStaffRefresh(async () => { calls += 1; });
    refresh.schedule();
    refresh.dispose();
    refresh.schedule();
    t.mock.timers.tick(1000);
    assert.equal(calls, 0);
});

test('completing a task updates open-view counts and paging without mutating rollback state', () => {
    const task = { id: 'first', category: 'review' };
    const nextTask = { id: 'next', category: 'notes' };
    const previous = {
        tasks: [task, nextTask], total: 3,
        counts: { open: 4, completed: 2, all: 4, review: 3, notes: 1, interviews: 0 },
    };
    const next = taskCompletionView(previous, task, true);
    assert.deepEqual(next.tasks, [nextTask]);
    assert.equal(next.total, 2);
    assert.deepEqual(next.counts, { open: 3, completed: 3, all: 3, review: 2, notes: 1, interviews: 0 });
    assert.equal(previous.tasks.length, 2);
    assert.equal(previous.counts.open, 4);
});

test('reopening a task updates completed-view category and global counts', () => {
    const task = { id: 'first', category: 'interviews' };
    const previous = {
        tasks: [task], total: 1,
        counts: { open: 4, completed: 2, all: 2, review: 1, notes: 0, interviews: 1 },
    };
    const next = taskCompletionView(previous, task, false);
    assert.deepEqual(next.tasks, []);
    assert.equal(next.total, 0);
    assert.deepEqual(next.counts, { open: 5, completed: 1, all: 1, review: 1, notes: 0, interviews: 0 });
});

test('completing the last loaded task preserves the unloaded remainder for pagination', () => {
    const task = { id: 'last-loaded', category: 'review' };
    const previous = {
        tasks: [task], total: 3,
        counts: { open: 3, completed: 0, all: 3, review: 3, notes: 0, interviews: 0 },
    };
    const next = taskCompletionView(previous, task, true);
    assert.deepEqual(next.tasks, []);
    assert.equal(next.total, 2);
    assert.equal(next.counts.all, 2);
    // The next page starts at the remaining loaded length, now zero.
    assert.equal(next.total - next.tasks.length, 2);
});
