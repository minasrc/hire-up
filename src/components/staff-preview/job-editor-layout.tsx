'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';

const sections = [
    ['role', 'Role essentials'],
    ['location', 'Workplace & location'],
    ['description', 'Job description'],
    ['compensation', 'Compensation & benefits'],
];

export function JobEditorNavigation() {
    const [active, setActive] = useState('role');
    useEffect(() => {
        let frame = 0;
        const update = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const passed = sections.filter(([id]) => {
                    const section = document.getElementById(id);
                    return section && section.getBoundingClientRect().top <= 120;
                });
                setActive(passed.at(-1)?.[0] ?? 'role');
            });
        };
        update();
        window.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('scroll', update);
            window.removeEventListener('resize', update);
        };
    }, []);
    return (
        <aside className="min-w-0">
            <div className="sticky top-6 flex flex-col gap-6">
                <nav aria-label="Job form sections" className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
                    <p className="mb-2 hidden px-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase lg:block">Your job draft</p>
                    {sections.map(([id, label], index) => (
                        <button type="button" key={id} aria-current={active === id ? 'step' : undefined}
                            className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${active === id ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}
                            onClick={() => {
                                setActive(id);
                                document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
                            }}>
                            <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${active === id ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>{index + 1}</span>{label}
                        </button>
                    ))}
                </nav>

            </div>
        </aside>
    );
}

export function JobEditorSection({ id, number, title, icon: Icon, children }: {
    id: string; number: string; title: string; icon: LucideIcon; children: ReactNode;
}) {
    return (
        <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-6 rounded-xl border border-border bg-card shadow-sm">
            <div className="flex items-center gap-3 border-b border-border px-5 py-5 sm:px-6">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Icon className="h-5 w-5" aria-hidden="true" /></div>
                <div><h2 id={`${id}-heading`} className="text-base font-semibold"><span className="mr-2 text-xs font-normal text-muted-foreground">{number}</span>{title}</h2></div>
            </div>
            <div className="flex flex-col gap-5 p-5 sm:p-6">{children}</div>
        </section>
    );
}
