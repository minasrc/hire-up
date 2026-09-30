'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Plus, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/staff-ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/staff-ui/dialog';
import { Input } from '@/components/staff-ui/input';
import { Textarea } from '@/components/staff-ui/textarea';
import { Label } from '@/components/staff-ui/label';
import { CV_ACCEPT_ATTRIBUTE, validateCvFileMetadata } from '@/lib/application';
import { isUuid } from '@/lib/candidate-profile-contracts';
import type { CandidateProfileOptions } from './candidate-profile-dialog';

export function CandidateUploadDialog({ options, onCreated }: {
    options: CandidateProfileOptions;
    onCreated: (candidateId: string) => void;
}) {
    const [open, setOpen] = useState(false);
    return <>
        <Button size="sm" onClick={() => setOpen(true)}><Plus aria-hidden="true" />Add candidate</Button>
        {open && <UploadForm options={options} onCreated={onCreated} onClose={() => setOpen(false)} />}
    </>;
}

function UploadForm({ options, onCreated, onClose }: {
    options: CandidateProfileOptions;
    onCreated: (candidateId: string) => void;
    onClose: () => void;
}) {
    const [draft, setDraft] = useState({ firstName: '', lastName: '', primaryEmail: '', location: '', headline: '', compensationPreference: '', professionalUrl: '', professionalSummary: '', ownerMembershipId: options.currentMembershipId });
    const [secondary, setSecondary] = useState<{ id: string; value: string }[]>([]);
    const [file, setFile] = useState<File | null>(null);
    const [fileError, setFileError] = useState('');
    const [error, setError] = useState('');
    const [duplicate, setDuplicate] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const busy = useRef(false);
    const operation = useRef(crypto.randomUUID());
    const input = useRef<HTMLInputElement>(null);
    const dirty = file !== null || Object.entries(draft).some(([key, value]) => key !== 'ownerMembershipId' && !!value) || draft.ownerMembershipId !== options.currentMembershipId || secondary.some(row => row.value);
    useEffect(() => {
        if (!dirty) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
    }, [dirty]);
    const close = () => {
        if (!busy.current && (!dirty || window.confirm('Discard this candidate draft?'))) onClose();
    };
    const chooseFile = (selected: File | null) => {
        if (!selected) return;
        const result = validateCvFileMetadata(selected);
        setFile(result.ok ? selected : null);
        setFileError(result.ok ? '' : result.message ?? 'Choose a PDF or DOCX up to 4 MB.');
        if (!result.ok && input.current) input.current.value = '';
    };
    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (busy.current) return;
        setError(''); setDuplicate(null);
        if (!file) { setFileError('Upload a CV to create this candidate.'); return; }
        if (!draft.firstName.trim() || !draft.lastName.trim()) { setError('Enter first and last names.'); return; }
        const emails = [draft.primaryEmail, ...secondary.map(row => row.value)].map(value => value.trim().toLowerCase());
        if (new Set(emails).size !== emails.length) { setError('Each email address must be different.'); return; }
        if (`${draft.firstName.trim()} ${draft.lastName.trim()}`.length > 120) { setError('Keep the full name within 120 characters.'); return; }
        busy.current = true; setPending(true);
        try {
            const body = new FormData();
            body.set('fields', JSON.stringify({ ...draft,
                firstName: draft.firstName.trim(), lastName: draft.lastName.trim(),
                primaryEmail: emails[0], secondaryEmails: emails.slice(1),
                ownerMembershipId: draft.ownerMembershipId === 'none' ? null : draft.ownerMembershipId,
            }));
            body.set('cvFile', file, file.name);
            body.set('operationId', operation.current);
            const response = await fetch('/api/staff/candidates/upload', { method: 'POST', body });
            const payload = await response.json().catch(() => null);
            if (response.status === 409 && payload?.code === 'DUPLICATE_CANDIDATE' && isUuid(payload.candidateId)) {
                setDuplicate(payload.candidateId);
                setError('A candidate with one of these email addresses already exists.');
                return;
            }
            if (!response.ok || payload?.ok !== true || !isUuid(payload?.result?.candidateId)) {
                const details = payload?.fields && typeof payload.fields === 'object'
                    ? Object.values(payload.fields).filter(value => typeof value === 'string').join(' ') : '';
                setError(response.status === 401 || response.status === 428 ? 'Your session expired. Sign in again; your draft is still here.'
                    : response.status === 403 ? 'You do not have permission to add candidates with a CV.'
                    : details || (typeof payload?.error === 'string' ? payload.error : '') || 'Could not create the candidate. Your draft is still here; try again.');
                return;
            }
            window.dispatchEvent(new Event('staff-workspace-updated'));
            onClose(); onCreated(payload.result.candidateId);
        } catch { setError('Could not reach the server. Your draft is still here; try again.'); }
        finally { busy.current = false; setPending(false); }
    };
    return <Dialog open onOpenChange={next => { if (!next) close(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader><DialogTitle>Add candidate</DialogTitle><DialogDescription>Enter their name, primary email and CV. Other details are optional.</DialogDescription></DialogHeader>
            <form onSubmit={submit} className="flex flex-col gap-5">
                <fieldset disabled={pending} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
                    <div className="grid gap-4 sm:grid-cols-2">
                        {(['firstName', 'lastName', 'primaryEmail'] as const).map(name => <div key={name} className={`flex flex-col gap-1.5 ${name === 'primaryEmail' ? 'sm:col-span-2' : ''}`}>
                            <Label htmlFor={`candidate-${name}`}>{name === 'firstName' ? 'First name' : name === 'lastName' ? 'Last name' : 'Primary email'} <span aria-hidden="true">*</span></Label>
                            <Input id={`candidate-${name}`} name={name} required type={name === 'primaryEmail' ? 'email' : 'text'} maxLength={name === 'primaryEmail' ? 254 : 60} autoComplete={name === 'firstName' ? 'given-name' : name === 'lastName' ? 'family-name' : 'email'} value={draft[name]} onChange={event => setDraft({ ...draft, [name]: event.target.value })} />
                        </div>)}
                    </div>
                    {secondary.map((row, index) => <div key={row.id} className="flex items-end gap-2">
                        <div className="flex flex-1 flex-col gap-1.5"><Label htmlFor={row.id}>Secondary email {index + 1}</Label><Input id={row.id} type="email" required maxLength={254} value={row.value} onChange={event => setSecondary(secondary.map(item => item.id === row.id ? { ...item, value: event.target.value } : item))} /></div>
                        <Button type="button" variant="ghost" size="icon" aria-label={`Remove secondary email ${index + 1}`} onClick={() => setSecondary(secondary.filter(item => item.id !== row.id))}><Trash2 aria-hidden="true" /></Button>
                    </div>)}
                    <Button type="button" variant="outline" size="sm" className="self-start" disabled={secondary.length >= 9} onClick={() => setSecondary([...secondary, { id: crypto.randomUUID(), value: '' }])}><Plus aria-hidden="true" />Add secondary email</Button>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="candidate-cv">CV <span aria-hidden="true">*</span></Label>
                        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-4" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!pending) { if (event.dataTransfer.files.length !== 1) { setFile(null); setFileError('Choose one CV file.'); if (input.current) input.current.value = ''; } else { if (input.current) input.current.files = event.dataTransfer.files; chooseFile(event.dataTransfer.files[0]); } } }}>
                            <Upload className="mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
                            <p id="cv-help" className="mb-3 text-sm text-muted-foreground">Choose a file or drop it here. PDF or DOCX, up to 4 MB.</p>
                            <Input ref={input} id="candidate-cv" type="file" accept={CV_ACCEPT_ATTRIBUTE} aria-describedby="cv-help cv-error" aria-invalid={!!fileError} onChange={event => chooseFile(event.target.files?.[0] ?? null)} />
                            {file && <div className="mt-3 flex items-center justify-between gap-2"><p className="min-w-0 break-words text-sm" role="status">{file.name} · {Math.ceil(file.size / 1024)} KB</p><Button type="button" variant="ghost" size="sm" onClick={() => { setFile(null); setFileError(''); if (input.current) input.current.value = ''; }}>Remove CV</Button></div>}
                        </div>
                        <p id="cv-error" role={fileError ? 'alert' : undefined} className="text-sm text-destructive">{fileError}</p>
                    </div>
                    <details><summary className="cursor-pointer text-sm font-medium">Optional details</summary><div className="mt-3 grid gap-4 sm:grid-cols-2">{(['headline', 'location', 'compensationPreference', 'professionalUrl'] as const).map(name => <div key={name} className="flex flex-col gap-1.5"><Label htmlFor={`candidate-${name}`}>{name === 'headline' ? 'Role / headline' : name === 'location' ? 'Location' : name === 'compensationPreference' ? 'Compensation preference' : 'Profile URL'}</Label><Input id={`candidate-${name}`} maxLength={name === 'professionalUrl' ? 2048 : name === 'compensationPreference' ? 500 : 200} value={draft[name]} onChange={event => setDraft({ ...draft, [name]: event.target.value })} /></div>)}
                        <div className="flex flex-col gap-1.5"><Label htmlFor="candidate-owner">Owner</Label><select id="candidate-owner" className="rounded-md border border-input bg-card px-3 py-2 text-sm" value={draft.ownerMembershipId} onChange={event => setDraft({ ...draft, ownerMembershipId: event.target.value })}><option value="none">Unassigned</option>{options.owners.map(owner => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></div>
                        <div className="flex flex-col gap-1.5 sm:col-span-2"><Label htmlFor="candidate-summary">Professional summary</Label><Textarea id="candidate-summary" rows={3} maxLength={8000} value={draft.professionalSummary} onChange={event => setDraft({ ...draft, professionalSummary: event.target.value })} /></div>
                    </div></details>
                </fieldset>
                {error && <p role="alert" className="text-sm text-destructive">{error} {duplicate && <Link className="underline" href={`/staff/candidates/${duplicate}`}>Open existing candidate</Link>}</p>}
                <DialogFooter><Button type="button" variant="outline" disabled={pending} onClick={close}>Cancel</Button><Button type="submit" disabled={pending}>{pending ? 'Uploading and saving…' : 'Add candidate'}</Button></DialogFooter>
            </form>
        </DialogContent>
    </Dialog>;
}
