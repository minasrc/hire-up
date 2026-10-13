import { staffWorkspaceFetch } from '../../../../lib/staff-workspace-fetch.js';
export class PrivateProvenanceTimeout extends Error {}

// Cover both headers and JSON reads. Obsolete/auth/unmount cancellation remains
// distinct from a deadline so callers can offer retry without restoring data.
export async function readPrivateProvenance(url, signal, timeoutMs = 15000) {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    if (signal.aborted) cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
        const response = await staffWorkspaceFetch(url, { cache: 'no-store', signal: controller.signal });
        // Unread fetch bodies can keep Chromium's network activity pending even
        // after a flag-off404 completes on the server. Release all error bodies.
        let data = null;
        if (response.ok) data = await response.json();
        else void response.body?.cancel().catch(() => {}); // Handle known auth status immediately.
        return { status: response.status, ok: response.ok, data };
    } catch (error) {
        if (timedOut && !signal.aborted) throw new PrivateProvenanceTimeout('Private source links took too long to load. Retry when your connection is available.');
        throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.abort(); }
}
