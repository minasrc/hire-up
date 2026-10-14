'use client';

import { useState } from 'react';
import { Button } from './button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

export function useDiscardConfirmation() {
    const [action, setAction] = useState<(() => void) | null>(null);
    return {
        requestDiscard: (dirty: boolean, discard: () => void) => {
            if (dirty) setAction(() => discard);
            else discard();
        },
        discardDialog: <Dialog open={action !== null} onOpenChange={(open) => { if (!open) setAction(null); }}>
            <DialogContent>
                <DialogHeader><DialogTitle>Discard unsaved changes?</DialogTitle><DialogDescription>Your unsaved edits will be lost.</DialogDescription></DialogHeader>
                <DialogFooter><Button variant="outline" onClick={() => setAction(null)}>Keep editing</Button><Button variant="destructive" onClick={() => { action?.(); setAction(null); }}>Discard changes</Button></DialogFooter>
            </DialogContent>
        </Dialog>,
    };
}
