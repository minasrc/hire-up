'use client';

import type { ComponentProps, ReactNode } from 'react';
import { Select, SelectContent, SelectTrigger, SelectValue } from './select';

type Props = Omit<ComponentProps<typeof SelectTrigger>, 'onChange' | 'children'> & {
    value: string; onChange: (value: string) => void; children: ReactNode; placeholder?: string;
};

export function ControlledSelect({ value, onChange, children, placeholder = 'Select', ...props }: Props) {
    return <Select value={value} onValueChange={onChange}>
        <SelectTrigger {...props}><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>{children}</SelectContent>
    </Select>;
}
