'use client';

import { refreshStaffWorkspace } from '@/lib/staff-workspace-fetch';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { Button } from '@/components/staff-ui/button';

export function SummaryRetry() {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    return (
        <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
                startTransition(() => {
                    refreshStaffWorkspace(router);
                    window.dispatchEvent(new Event('staff-workspace-updated'));
                })
            }
        >
            {pending ? 'Retrying…' : 'Retry'}
        </Button>
    );
}
