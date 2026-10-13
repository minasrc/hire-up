'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Button } from '@/components/staff-ui/button';
import { workspaceNavigationUrl } from './workspace-navigation-model';
import { WORKSPACE_CHANGED_EVENT } from '@/lib/staff-workspace-fetch';

const StaffWorkspaceContext = createContext<string | null>(null);

export function useStaffWorkspaceId() {
    return useContext(StaffWorkspaceContext);
}

export function WorkspaceBoundary({ children, multiWorkspace = false, organizationId }: { children: React.ReactNode; multiWorkspace?: boolean; organizationId?: string }) {
    const [changed, setChanged] = useState(false);
    useEffect(() => {
        const invalidate = () => setChanged(true);
        const selectionChanged = (event: StorageEvent) => { if (event.key === 'staff-workspace-selection-changed') invalidate(); };
        window.addEventListener(WORKSPACE_CHANGED_EVENT, invalidate);
        window.addEventListener('storage', selectionChanged);
        return () => {
            window.removeEventListener(WORKSPACE_CHANGED_EVENT, invalidate);
            window.removeEventListener('storage', selectionChanged);
        };
    }, []);
    useEffect(() => {
        if (!multiWorkspace) return;
        const navigate = (event: MouseEvent) => {
            const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
            if (!(anchor instanceof HTMLAnchorElement)) return;
            const destination = workspaceNavigationUrl({
                href: anchor.getAttribute('href') || '', currentUrl: window.location.href,
                target: anchor.target, download: anchor.hasAttribute('download'), preview: anchor.hasAttribute('data-preview-trigger'),
                button: event.button, defaultPrevented: event.defaultPrevented,
                metaKey: event.metaKey, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey,
            });
            if (!destination) return;
            event.preventDefault();
            window.location.assign(destination);
        };
        document.addEventListener('click', navigate, true);
        return () => document.removeEventListener('click', navigate, true);
    }, [multiWorkspace]);
    if (changed) return <main className="staff-scope mx-auto max-w-xl space-y-5 px-6 py-20" role="alert">
        <h1 className="text-2xl font-semibold">Your workspace changed</h1>
        <p>A workspace was selected in another tab. Reload before continuing so your changes go to the right workspace.</p>
        <div className="flex flex-wrap gap-3">
            <Button onClick={() => window.location.reload()}>Reload workspace</Button>
            <Button asChild variant="outline"><a href="/staff/workspaces">Choose workspace</a></Button>
        </div>
    </main>;
    return <StaffWorkspaceContext.Provider value={multiWorkspace ? organizationId ?? null : null}>{children}</StaffWorkspaceContext.Provider>;
}
