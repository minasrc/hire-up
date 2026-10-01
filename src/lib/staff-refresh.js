// Collapse bursts without aborting work the server has already started. An update
// received during a read gets one trailing read so a mutation is never missed.
/** @param {() => Promise<void>} refresh */
export function createStaffRefresh(refresh, delay = 100) {
    let timer;
    let running = false;
    let pending = false;
    let disposed = false;
    const schedule = () => {
        if (disposed) return;
        pending = true;
        if (running || timer) return;
        timer = setTimeout(async () => {
            timer = undefined;
            pending = false;
            running = true;
            try {
                await refresh();
            } finally {
                running = false;
                if (pending) schedule();
            }
        }, delay);
    };
    return {
        schedule,
        dispose() {
            disposed = true;
            clearTimeout(timer);
        },
    };
}

/**
 * @param {import('./workspace-types').StaffTaskListResult} data
 * @param {import('./workspace-types').StaffTask} task
 * @param {boolean} completed
 */
export function taskCompletionView(data, task, completed) {
    const delta = completed ? 1 : -1;
    return {
        ...data,
        tasks: data.tasks.filter((entry) => entry.id !== task.id),
        total: data.total - 1,
        counts: {
            ...data.counts,
            open: data.counts.open - delta,
            completed: data.counts.completed + delta,
            all: data.counts.all - 1,
            [task.category]: data.counts[task.category] - 1,
        },
    };
}
