// Full navigation prevents a retained App Router layout from presenting another
// workspace's server page under the previous workspace's chrome.
export function workspaceNavigationUrl({ href, currentUrl, target, download, preview, button = 0, defaultPrevented, metaKey, ctrlKey, shiftKey, altKey }) {
    if (defaultPrevented || button !== 0 || metaKey || ctrlKey || shiftKey || altKey || download || preview
        || (target && target.toLowerCase() !== '_self') || href.startsWith('#')) return null;
    try {
        const current = new URL(currentUrl);
        const destination = new URL(href, current);
        if (destination.origin !== current.origin || !/^\/staff(?:\/|$)/.test(destination.pathname)) return null;
        if (destination.pathname === current.pathname && destination.search === current.search && destination.hash) return null;
        return destination.href;
    } catch { return null; }
}
