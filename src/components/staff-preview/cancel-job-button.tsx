'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/staff-ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/staff-ui/dialog';

export function CancelJobButton({ dirty, disabled, href, onDiscard }: {
    dirty: boolean; disabled?: boolean; href: string; onDiscard: () => void;
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const discard = () => {
        onDiscard();
        setOpen(false);
        router.push(href);
    };
    return <>
        <Button variant="ghost" disabled={disabled} onClick={() => { if (dirty) setOpen(true); else discard(); }}>Cancel</Button>
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Discard unsaved changes?</DialogTitle>
                    <DialogDescription>Your unsaved edits will be lost. Anything already saved will remain.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOpen(false)}>Keep editing</Button>
                    <Button variant="destructive" onClick={discard}>Discard changes</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </>;
}
