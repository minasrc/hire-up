'use client';

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { useStaffWorkspaceId } from '@/app/staff/workspace-boundary';

type Props = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
    documentId: string;
    view?: 'inline';
};

// Native GETs cannot carry the AJAX workspace header. Bind the original rendered
// scope in the URL, including SSR links clicked before hydration or in new tabs.
export const StaffDocumentLink = forwardRef<HTMLAnchorElement, Props>(function StaffDocumentLink(
    { documentId, view, ...anchorProps }, ref,
) {
    const organizationId = useStaffWorkspaceId();
    const query = new URLSearchParams();
    if (view) query.set('view', view);
    if (organizationId) query.set('_workspace', organizationId);
    const suffix = query.toString();
    const href = `/api/staff/documents/${encodeURIComponent(documentId)}${suffix ? `?${suffix}` : ''}`;
    return <a {...anchorProps} ref={ref} href={href} />;
});
