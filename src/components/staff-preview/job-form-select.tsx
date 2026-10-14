'use client';

import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/staff-ui/select';

export function JobFormSelect({ id, name, initial = '', placeholder = 'Select', options, required, clearable, invalid, describedBy, onChange }: {
    id: string; name: string; initial?: string; placeholder?: string;
    options: { value: string; label: string }[]; required?: boolean; clearable?: boolean; invalid?: boolean;
    describedBy?: string; onChange: (value: string) => void;
}) {
    const [value, setValue] = useState(initial);
    return <>
        <input type="hidden" name={name} value={value} />
        <Select value={value} onValueChange={(next) => { const selected = next === '__none__' ? '' : next; setValue(selected); onChange(selected); }}>
            <SelectTrigger id={id} aria-required={required || undefined} aria-invalid={invalid || undefined} aria-describedby={describedBy}>
                <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
                {(clearable ?? !required) && <SelectItem value="__none__">Not specified</SelectItem>}
                {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
        </Select>
    </>;
}
