'use client';

import { cn } from '@/lib/utils';

import { TagPill } from './shared';
import type { Candidate } from './types';

export function CandidateSummary({
    candidate,
    compact = false,
}: {
    candidate: Pick<Candidate, 'summary' | 'experience' | 'skills'>;
    compact?: boolean;
}) {
    const experience = candidate.experience ?? [];
    const skills = candidate.skills ?? [];

    return (
        <div className={cn('flex flex-col', compact ? 'gap-4' : 'gap-5')}>
            <div className="flex flex-col gap-1.5">
                <h3 className="text-xs font-semibold tracking-wide text-foreground uppercase">
                    Summary
                </h3>
                {candidate.summary ? (
                    <p className="text-sm leading-6 text-muted-foreground">{candidate.summary}</p>
                ) : (
                    <p className="text-sm text-muted-foreground">No summary recorded.</p>
                )}
            </div>
            <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold tracking-wide text-foreground uppercase">
                    Experience
                </h3>
                {experience.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No experience recorded.</p>
                ) : (
                    <ol className="flex flex-col gap-3">
                        {experience.map((entry) => (
                            <li
                                key={`${entry.role}-${entry.period}`}
                                className="flex flex-col gap-0.5 border-l-2 border-accent pl-3"
                            >
                                <span className="text-sm font-medium text-foreground">
                                    {entry.role} · {entry.company}
                                </span>
                                <span className="text-xs text-muted-foreground">{entry.period}</span>
                                <span className="text-sm text-muted-foreground">
                                    {entry.description}
                                </span>
                            </li>
                        ))}
                    </ol>
                )}
            </div>
            <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold tracking-wide text-foreground uppercase">
                    Skills
                </h3>
                {skills.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No skills recorded.</p>
                ) : (
                    <div className="flex flex-wrap gap-1.5">
                        {skills.map((skill) => (
                            <TagPill key={skill}>{skill}</TagPill>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
