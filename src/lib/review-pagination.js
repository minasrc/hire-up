/**
 * Finds adjacent applications using the current queue's ordering boundary.
 * Revisiting one server page avoids skipping rows when earlier decisions have
 * removed applications from a filtered directory and shifted its page offsets.
 * @template {{ applicationId: string, receivedAt: string }} T
 * @param {{ queue: T[], direction: -1 | 1, frontier: number, offset: number, pageSize?: number, loadPage: (page: number) => Promise<{applications: T[], total: number, pageSize: number}>, isCurrent?: () => boolean }} input
 */
export async function loadAdjacentReviewPage({ queue, direction, frontier, offset, pageSize = 25, loadPage, isCurrent = () => true }) {
    const anchor = direction === 1 ? queue[queue.length - 1] : queue[0];
    if (!anchor) return null;
    const known = new Set(queue.map((row) => row.applicationId));
    let page = direction === 1 ? Math.max(1, frontier - 1) : Math.max(1, Math.floor(offset / pageSize));
    while (page > 0) {
        const directory = await loadPage(page);
        if (!isCurrent()) return null;
        const rows = directory.applications.filter((row) => {
            if (known.has(row.applicationId)) return false;
            const order = row.receivedAt.localeCompare(anchor.receivedAt) || row.applicationId.localeCompare(anchor.applicationId);
            return direction === 1 ? order < 0 : order > 0;
        });
        if (rows.length) return { rows, page };
        if ((direction === 1 && page * directory.pageSize >= directory.total) || (direction === -1 && page === 1)) break;
        page += direction;
    }
    return null;
}
