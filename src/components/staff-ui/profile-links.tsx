import { Globe, Link as LinkIcon } from 'lucide-react';
import { FaGithub, FaLinkedinIn, FaXTwitter } from 'react-icons/fa6';

const platforms = {
    linkedin: { label: 'LinkedIn', icon: FaLinkedinIn },
    x: { label: 'X', icon: FaXTwitter },
    github: { label: 'GitHub', icon: FaGithub },
};

export function ProfileLinks({ website, links = [] }: {
    website?: string | null;
    links?: { platform: string; url: string }[] | null;
}) {
    const profiles = [
        ...(website ? [{ url: website, label: 'Website', icon: Globe }] : []),
        ...(links ?? []).map((link) => ({
            ...link,
            ...(platforms[link.platform as keyof typeof platforms] ?? { label: 'Other profile', icon: LinkIcon }),
        })),
    ];
    if (!profiles.length) return null;
    return <ul aria-label="Company profiles" className="flex flex-wrap gap-2">
        {profiles.map(({ url, label, icon: Icon }) => <li key={`${label}:${url}`}>
            <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`${label} (opens in a new tab)`} title={label}
                className="flex size-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Icon className="size-4" aria-hidden="true" />
            </a>
        </li>)}
    </ul>;
}
