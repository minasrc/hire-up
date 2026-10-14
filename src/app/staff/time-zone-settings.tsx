'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button } from '@/components/staff-ui/button';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/staff-ui/card';
import { useStaffTimeZone, useStaffTimeZoneControls } from './time-zone-provider';

function ErrorMessage() {
    const controls = useStaffTimeZoneControls();
    if (!controls.error) return null;
    return <div className="flex items-center gap-2"><p role="alert" className="text-sm text-destructive">{controls.error}</p>{controls.errorKind === 'conflict' ? <Button type="button" variant="outline" size="sm" onClick={controls.reload}>Reload settings</Button> : null}</div>;
}

export function StaffTimeZoneBanner() {
    const data = useStaffTimeZone();
    const controls = useStaffTimeZoneControls();
    if (!controls.prompt) return null;
    return <aside aria-label="Time zone preference" className="mx-3 mt-2 flex flex-wrap items-center gap-2 rounded-md bg-muted/50 px-3 py-1.5 md:mx-4">
        <p className="min-w-0 flex-1 break-words text-xs text-muted-foreground">{data.savedTimeZone === null
            ? `Use ${controls.prompt.timeZone}?`
            : `Use ${controls.prompt.timeZone} instead of ${data.timeZone}?`}</p>
        <Button type="button" size="sm" className="h-6 px-2 text-xs" disabled={controls.saving} onClick={() => void controls.saveTimeZone(controls.prompt!.timeZone, 'device')}>{controls.saving ? 'Saving…' : controls.error ? 'Retry' : 'Switch'}</Button>
        <Button type="button" size="sm" className="h-6 px-2 text-xs" variant="ghost" disabled={controls.saving} onClick={controls.keepCurrentZone}>Keep current</Button>
        <ErrorMessage />
    </aside>;
}

export function TimeZoneSettings() {
    const data = useStaffTimeZone();
    const controls = useStaffTimeZoneControls();
    const [draft, setDraft] = useState(data.savedTimeZone ?? 'UTC');
    const [dirty, setDirty] = useState(false);
    const [saved, setSaved] = useState(false);
    const [zones, setZones] = useState<string[]>([]);
    useEffect(() => {
        const timer = setTimeout(() => {
            const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
            setZones(Array.from(new Set(['UTC', data.timeZone, ...supported])));
        }, 0);
        return () => clearTimeout(timer);
    }, [data.timeZone]);
    useEffect(() => {
        const timer = setTimeout(() => { if (!dirty) setDraft(data.savedTimeZone ?? 'UTC'); }, 0);
        return () => clearTimeout(timer);
    }, [data.savedTimeZone, dirty]);
    const options = useMemo(() => zones.map(zone => <option key={zone} value={zone} />), [zones]);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setSaved(false);
        if (await controls.saveTimeZone(draft, 'manual')) { setDirty(false); setSaved(true); }
    };
    return <Card><CardHeader><CardTitle>Time zone</CardTitle></CardHeader><CardContent className="space-y-4">
        <p>Dates are shown in {data.timeZone}.</p>
        {data.savedTimeZone === null ? <p className="text-sm text-muted-foreground">No time zone has been chosen; UTC is the default.</p> : null}
        <form className="space-y-3" onSubmit={submit}>
            <Label htmlFor="staff-time-zone">Time zone</Label>
            <Input id="staff-time-zone" list="staff-time-zone-options" value={draft} disabled={controls.saving} onChange={event => { setDraft(event.target.value); setDirty(true); setSaved(false); }} />
            <datalist id="staff-time-zone-options">{options}</datalist>
            <Button type="submit" disabled={controls.saving}>{controls.saving ? 'Saving…' : 'Save time zone'}</Button>
        </form>
        {saved ? <p role="status">Time zone saved.</p> : null}
        <ErrorMessage />
        <p className="text-sm text-muted-foreground">Calendar-only dates do not change with the time zone.</p>
    </CardContent></Card>;
}
