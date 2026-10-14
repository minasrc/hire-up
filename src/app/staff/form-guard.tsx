'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/staff-ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/staff-ui/dialog';

interface GuardRegistration {
    id: symbol;
    isDirty: () => boolean;
    save?: () => Promise<boolean>;
}

interface FormGuardActions {
    register: (registration: Omit<GuardRegistration, 'id'>) => () => void;
}

const FormGuardContext = createContext<FormGuardActions | null>(null);

export function useFormGuard(): FormGuardActions | null {
    return useContext(FormGuardContext);
}

export function useUnsavedChangesGuard({
    dirty,
    save,
}: {
    dirty: boolean;
    save?: () => Promise<boolean> | boolean;
}) {
    const guard = useFormGuard();
    const dirtyRef = useRef(dirty);
    const saveRef = useRef(save);
    useEffect(() => {
        dirtyRef.current = dirty;
        saveRef.current = save;
    });
    useEffect(() => {
        if (!guard) return undefined;
        return guard.register({
            isDirty: () => dirtyRef.current,
            save: saveRef.current
                ? async () => (await saveRef.current!()) !== false
                : undefined,
        });
    }, [guard]);
}

function shouldIntercept(target: Element | null, event: MouseEvent): string | null {
    if (!(target instanceof Element)) return null;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return null;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return null;
    }
    if (anchor.target && anchor.target !== '_self') return null;
    if (anchor.hasAttribute('download')) return null;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return null;
    if (anchor.hasAttribute('data-preview-trigger')) return null;
    const sameLocation =
        url.pathname === window.location.pathname
        && url.search === window.location.search;
    if (sameLocation && url.hash) return null;
    if (sameLocation && !url.hash && !window.location.hash) return null;
    return url.pathname + url.search + url.hash;
}

export function FormGuardProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
    const guardsRef = useRef<GuardRegistration[]>([]);
    const [pendingHref, setPendingHref] = useState<string | null>(null);
    const [pendingDirtyCount, setPendingDirtyCount] = useState(0);
    const [pendingCanSave, setPendingCanSave] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');

    const register = useCallback(
        (registration: Omit<GuardRegistration, 'id'>) => {
            const record: GuardRegistration = { ...registration, id: Symbol('guard') };
            guardsRef.current = [...guardsRef.current, record];
            return () => {
                guardsRef.current = guardsRef.current.filter((entry) => entry !== record);
            };
        },
        [],
    );

    const dirtyGuards = useCallback(
        () => guardsRef.current.filter((entry) => entry.isDirty()),
        [],
    );

    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            const href = shouldIntercept(event.target as Element | null, event);
            if (!href) return;
            const dirty = dirtyGuards();
            if (dirty.length === 0) return;
            event.preventDefault();
            event.stopPropagation();
            setSaveError('');
            setPendingDirtyCount(dirty.length);
            setPendingCanSave(
                dirty.every((entry) => typeof entry.save === 'function'),
            );
            setPendingHref(href);
        };
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            if (dirtyGuards().length === 0) return;
            event.preventDefault();
        };
        document.addEventListener('click', onClick, true);
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => {
            document.removeEventListener('click', onClick, true);
            window.removeEventListener('beforeunload', onBeforeUnload);
        };
    }, [dirtyGuards]);

    const stay = useCallback(() => {
        setPendingHref(null);
        setSaveError('');
    }, []);

    const leave = useCallback(() => {
        const href = pendingHref;
        setPendingHref(null);
        setSaveError('');
        if (href) router.push(href);
    }, [pendingHref, router]);

    const saveAndLeave = useCallback(async () => {
        const dirty = dirtyGuards().filter((entry) => entry.save);
        if (dirty.length === 0) return;
        setSaving(true);
        setSaveError('');
        try {
            for (const entry of dirty) {
                const ok = await entry.save!();
                if (!ok) throw new Error('Could not save. Please try again.');
            }
            leave();
        } catch (error) {
            setSaveError(
                error instanceof Error ? error.message : 'Could not save. Please try again.',
            );
        } finally {
            setSaving(false);
        }
    }, [dirtyGuards, leave]);

    const canSaveAndLeave = pendingHref !== null && pendingCanSave;

    return (
        <FormGuardContext.Provider value={{ register }}>
            {children}
            <Dialog
                open={pendingHref !== null}
                onOpenChange={(open) => {
                    if (!open && !saving) stay();
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Unsaved changes</DialogTitle>
                        <DialogDescription>
                            {pendingDirtyCount > 1
                                ? `You have unsaved changes in ${pendingDirtyCount} forms on this page.`
                                : 'You have unsaved changes on this page.'}
                        </DialogDescription>
                    </DialogHeader>
                    {saveError ? (
                        <p role="alert" className="text-sm text-destructive">
                            {saveError}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button variant="ghost" disabled={saving} onClick={stay}>
                            Stay
                        </Button>
                        <Button variant="outline" disabled={saving} onClick={leave}>
                            Discard and continue
                        </Button>
                        {canSaveAndLeave ? (
                            <Button
                                variant="default"
                                disabled={saving}
                                onClick={() => void saveAndLeave()}
                            >
                                {saving ? 'Saving…' : 'Save and continue'}
                            </Button>
                        ) : null}
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </FormGuardContext.Provider>
    );
}
