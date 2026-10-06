'use client';

import { useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { Search, UserCog, X } from 'lucide-react';

import { Button } from '@/components/staff-ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/staff-ui/card';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/staff-ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/staff-ui/table';
import { EmptyState, PageHeader, StatusBadge } from '@/components/staff-preview/shared';
import { cn } from '@/lib/utils';
import { optionParam, textParam } from '../filter-params';

import { MemberMfaResetForm } from './mfa-reset-form';

import { InviteDomainsForm, MemberInviteForm, MemberRevokeButton } from '../workspace-forms';

interface MemberRow {
    membershipId: string;
    displayName: string | null;
    invitedEmail: string | null;
    status: string;
    roleId: string;
    roleKey: string;
    roleName: string | null;
    version: string;
}

export interface MemberFiltersState {
    query: string;
    status: string;
}

const STATUS_OPTIONS = [
    { value: 'all', label: 'All statuses' },
    { value: 'active', label: 'Active' },
    { value: 'invited', label: 'Invited' },
    { value: 'revoked', label: 'Revoked' },
];

const statusTone = (status: string) =>
    status === 'active'
        ? 'success'
        : status === 'invited'
          ? 'warning'
          : 'secondary';

const STATUS_VALUES = STATUS_OPTIONS.map((option) => option.value);

const parseFilters = (params: { get(name: string): string | null }): MemberFiltersState => ({
    query: textParam(params, 'q'),
    status: optionParam(params, 'status', STATUS_VALUES, 'all'),
});

function syncUrl(filters: MemberFiltersState) {
    const params = new URLSearchParams();
    if (filters.query.trim()) params.set('q', filters.query);
    if (filters.status !== 'all') params.set('status', filters.status);
    const query = params.toString();
    window.history.replaceState(
        null, '', `/staff/members${query ? `?${query}` : ''}`);
}

export function MembersBrowser({
    members,
    roles,
    inviteDomains,
    capped,
    currentMembershipId,
}: {
    members: MemberRow[];
    roles: { id: string; name: string; key: string }[];
    inviteDomains: string[];
    capped: boolean;
    currentMembershipId?: string;
}) {
    const searchParams = useSearchParams();
    const filters = parseFilters(searchParams);

    const update = (next: MemberFiltersState) => {
        syncUrl(next);
    };

    const visible = useMemo(() => {
        const needle = filters.query.trim().toLowerCase();
        return members.filter((member) => {
            if (filters.status !== 'all' && member.status !== filters.status) return false;
            if (needle) {
                const haystack =
                    `${member.displayName ?? ''} ${member.invitedEmail ?? ''}`.toLowerCase();
                if (!haystack.includes(needle)) return false;
            }
            return true;
        });
    }, [members, filters]);

    const filtersActive = filters.query.trim() !== '' || filters.status !== 'all';
    const clearFilters = () => update({ query: '', status: 'all' });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Workspace"
                title="Members"
            />

            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-end">
                <div className="flex flex-1 flex-col gap-1.5">
                    <Label htmlFor="member-search">Search</Label>
                    <div className="relative">
                        <Search
                            className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <Input
                            id="member-search"
                            className="pl-9"
                            placeholder="Search name or email…"
                            value={filters.query}
                            onChange={(event) =>
                                update({ ...filters, query: event.target.value })
                            }
                        />
                    </div>
                </div>
                <div className="flex flex-col gap-1.5 md:w-44">
                    <Label htmlFor="member-status-filter">Status</Label>
                    <Select
                        value={filters.status}
                        onValueChange={(value) => update({ ...filters, status: value })}
                    >
                        <SelectTrigger id="member-status-filter" aria-label="Filter members by status">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {STATUS_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                {filtersActive ? (
                    <Button variant="ghost" size="sm" onClick={clearFilters}>
                        <X aria-hidden="true" />
                        Clear filters
                    </Button>
                ) : null}
            </div>

            <p role="status" className="text-xs text-muted-foreground">
                {visible.length} member{visible.length === 1 ? '' : 's'}
                {capped ? ' · Listing is capped at 500 records' : ''}
            </p>

            {visible.length === 0 ? (
                <EmptyState
                    icon={UserCog}
                    title="No members found"
                    description="Try a different search or status."
                    action={
                        filtersActive ? (
                            <Button variant="outline" onClick={clearFilters}>
                                Clear filters
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Name</TableHead>
                                <TableHead className="hidden sm:table-cell">Email</TableHead>
                                <TableHead>Role</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {visible.map((member) => (
                                <TableRow
                                    key={member.membershipId}
                                    className={cn(
                                        member.status === 'invited' && 'bg-muted',
                                    )}
                                >
                                    <TableCell className="font-medium text-foreground">
                                        {member.displayName ?? '—'}
                                    </TableCell>
                                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                                        {member.invitedEmail ?? '—'}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {member.roleName ?? member.roleKey}
                                    </TableCell>
                                    <TableCell>
                                        <StatusBadge tone={statusTone(member.status)}>
                                            {member.status}
                                        </StatusBadge>
                                    </TableCell>
                                    <TableCell>
                                        {member.status === 'active' && member.membershipId !== currentMembershipId && (
                                            <MemberMfaResetForm membershipId={member.membershipId} version={member.version}
                                                displayName={member.displayName ?? member.invitedEmail ?? 'this member'} />
                                        )}
                                        {member.status !== 'revoked' && (
                                            <MemberRevokeButton
                                                membershipId={member.membershipId}
                                                roleId={member.roleId}
                                                version={member.version}
                                            />
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}

            <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Invite member</CardTitle>
                        <CardDescription>
                            The invite is bound to this email — the person signs in with
                            that Google account and is linked automatically on first
                            sign-in. Recording an invite does not send email.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <MemberInviteForm roles={roles} inviteDomains={inviteDomains} />
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Invite domains</CardTitle>
                        <CardDescription>
                            When set, only these email domains can be invited. Pending
                            invites on other domains stop working the moment this changes.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <InviteDomainsForm domains={inviteDomains} />
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
