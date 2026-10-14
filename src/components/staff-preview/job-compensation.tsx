'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Button } from '@/components/staff-ui/button';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/staff-ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/staff-ui/select';
import { compensationDisplay, compensationValue } from '@/lib/job-form-ui.js';

const popular = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'SGD', 'AED', 'INR', 'JPY'];
const currencies = Array.from(new Set([...popular, ...Intl.supportedValuesOf('currency')]));
const currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' });
const periods: Record<string, string> = { year: 'Per year', month: 'Per month', day: 'Per day', hour: 'Per hour' };
const currencySymbols = Object.fromEntries(currencies.map((code) => [code, new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? code]));
const symbol = (code: string) => currencySymbols[code] ?? code;
const label = (code: string) => `${code} · ${currencyNames.of(code) ?? code}${symbol(code) !== code ? ` (${symbol(code)})` : ''}`;

function AmountInput({ id, name, initial, error, onValueChange }: {
    id: string; name: string; initial: string; error?: string; onValueChange: (value: string) => void;
}) {
    const [value, setValue] = useState(compensationDisplay(initial));
    const ref = useRef<HTMLInputElement>(null);
    return <Input ref={ref} id={id} name={name} inputMode="decimal" autoComplete="off"
        value={value} placeholder={name === 'compensationMin' ? '80,000' : '110,000'}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => {
            const input = event.target;
            const characters = compensationValue(input.value.slice(0, input.selectionStart ?? input.value.length)).length;
            const formatted = compensationDisplay(input.value);
            setValue(formatted);
            onValueChange(compensationValue(formatted));
            requestAnimationFrame(() => {
                if (document.activeElement !== ref.current) return;
                let position = 0;
                let seen = 0;
                while (position < formatted.length && seen < characters) {
                    if (formatted[position] !== ',') seen++;
                    position++;
                }
                ref.current?.setSelectionRange(position, position);
            });
        }} />;
}

export function JobCompensation({ initial, errors, onDirty, onFieldsChange }: {
    initial?: { compensationMin: string | null; compensationMax: string | null; currency: string | null; payPeriod: string | null };
    errors: Record<string, string>; onDirty: () => void;
    onFieldsChange?: (fields: { compensationMin?: string; compensationMax?: string; currency?: string; payPeriod?: string }) => void;
}) {
    const [min, setMin] = useState(initial?.compensationMin ?? '');
    const [max, setMax] = useState(initial?.compensationMax ?? '');
    const [currency, setCurrency] = useState(initial?.currency ?? '');
    const [period, setPeriod] = useState(initial?.payPeriod ?? '');
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [highlighted, setHighlighted] = useState(0);
    const matches = currencies.filter((code) => label(code).toLowerCase().includes(query.toLowerCase()));
    const select = (code: string) => { setCurrency(code); onFieldsChange?.({ currency: code }); setOpen(false); setQuery(''); setHighlighted(0); onDirty(); };
    const field = (title: string, id: string, error: string | undefined, content: ReactNode) => (
        <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={id}>{title}</Label>{content}
            {error && <p role="alert" id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
        </div>
    );
    return (
        <div className="flex flex-col gap-3">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)_140px]">
                {field('Currency', 'job-currency', errors.currency, <>
                    <input type="hidden" name="currency" value={currency} />
                    <Popover open={open} onOpenChange={(value) => { setOpen(value); if (!value) { setQuery(''); setHighlighted(0); } }}>
                        <PopoverTrigger asChild>
                            <Button id="job-currency" variant="outline" role="combobox" aria-expanded={open}
                                aria-controls="currency-options" aria-invalid={errors.currency ? true : undefined}
                                aria-describedby={errors.currency ? 'job-currency-error' : undefined} className="w-full justify-between border-input bg-card px-3 font-normal hover:bg-card">
                                {currency ? `${currency} · ${symbol(currency)}` : 'Select'}<ChevronsUpDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-72 max-w-[calc(100vw-32px)] p-1">
                            <div className="relative mb-1 border-b border-border pb-1">
                                <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                                <Input aria-label="Search currencies" role="combobox" aria-expanded="true" aria-controls="currency-options"
                                    aria-activedescendant={matches[highlighted] ? `currency-${matches[highlighted]}` : undefined}
                                    className="border-0 pl-9 focus-visible:ring-0" placeholder="Search currencies" value={query}
                                    onChange={(event) => { setQuery(event.target.value); setHighlighted(0); }}
                                    onKeyDown={(event) => {
                                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                            event.preventDefault();
                                            const index = matches.length ? (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0;
                                            setHighlighted(index);
                                            document.getElementById(`currency-${matches[index]}`)?.scrollIntoView({ block: 'nearest' });
                                        } else if (event.key === 'Enter') {
                                            event.preventDefault();
                                            if (matches[highlighted]) select(matches[highlighted]);
                                        }
                                    }} />
                            </div>
                            {!query && <button type="button" className="w-full rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-hover" onClick={() => select('')}>No currency</button>}
                            <div id="currency-options" role="listbox" aria-label="Currencies" className="max-h-64 overflow-y-auto">
                                {matches.map((code, index) => <button type="button" role="option" id={`currency-${code}`}
                                    key={code} aria-selected={currency === code} tabIndex={-1}
                                    className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left text-sm ${highlighted === index ? 'bg-accent text-accent-foreground' : 'hover:bg-hover'}`}
                                    onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlighted(index)} onClick={() => select(code)}>
                                    <span>{label(code)}</span>{currency === code && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                                </button>)}
                                {!matches.length && <p className="px-3 py-3 text-sm text-muted-foreground">No matching currencies</p>}
                            </div>
                        </PopoverContent>
                    </Popover>
                </>)}
                {field('Minimum', 'job-comp-min', errors.compensationMin, <AmountInput id="job-comp-min" name="compensationMin" initial={min} error={errors.compensationMin} onValueChange={(value) => { setMin(value); onFieldsChange?.({ compensationMin: value }); onDirty(); }} />)}
                {field('Maximum', 'job-comp-max', errors.compensationMax, <AmountInput id="job-comp-max" name="compensationMax" initial={max} error={errors.compensationMax} onValueChange={(value) => { setMax(value); onFieldsChange?.({ compensationMax: value }); onDirty(); }} />)}
                {field('Pay period', 'job-pay-period', errors.payPeriod, <>
                    <input type="hidden" name="payPeriod" value={period} />
                    <Select value={period || '__none__'} onValueChange={(value) => { setPeriod(value === '__none__' ? '' : value); onFieldsChange?.({ payPeriod: value === '__none__' ? '' : value }); onDirty(); }}>
                        <SelectTrigger id="job-pay-period" aria-invalid={errors.payPeriod ? true : undefined} aria-describedby={errors.payPeriod ? 'job-pay-period-error' : undefined}><SelectValue placeholder="Select" /></SelectTrigger>
                        <SelectContent><SelectItem value="__none__">Select</SelectItem>{Object.entries(periods).map(([value, title]) => <SelectItem key={value} value={value}>{title}</SelectItem>)}</SelectContent>
                    </Select>
                </>)}
            </div>
            {(min || max) && (!min || !max || Number(min) <= Number(max)) && <p className="rounded-lg bg-secondary/50 px-3 py-2 text-sm font-medium tabular-nums">
                {currency && <span>{symbol(currency)}{symbol(currency) === currency ? ' ' : ''}</span>}{compensationDisplay(min) || '—'} – {compensationDisplay(max) || '—'}{period && ` ${periods[period].toLowerCase()}`}
            </p>}
        </div>
    );
}
