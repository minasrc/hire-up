'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardList, Plus } from 'lucide-react';

import { Badge } from '@/components/staff-ui/badge';
import { Button } from '@/components/staff-ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/staff-ui/card';
import { Checkbox } from '@/components/staff-ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/staff-ui/dialog';
import { Input } from '@/components/staff-ui/input';
import { Label } from '@/components/staff-ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/staff-ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/staff-ui/tabs';
import { staffMutation } from '@/lib/staff-mutation';
import { taskCompletionView } from '@/lib/staff-refresh';
import type {
    StaffTask,
    StaffTaskCategory,
    StaffTaskListResult,
} from '@/lib/workspace-types';

const CATEGORIES: { value: 'all' | StaffTaskCategory; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'review', label: 'Review' },
    { value: 'interviews', label: 'Interviews' },
    { value: 'notes', label: 'Notes' },
];

const PAGE_SIZE = 20;

export function StaffTodoList({ writeEnabled }: { writeEnabled: boolean }) {
    const [category, setCategory] = useState<'all' | StaffTaskCategory>('all');
    const [showCompleted, setShowCompleted] = useState(false);
    const [data, setData] = useState<StaffTaskListResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [denied, setDenied] = useState(false);
    const [sessionLost, setSessionLost] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionStatus, setActionStatus] = useState<string | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [addTitle, setAddTitle] = useState('');
    const [addCategory, setAddCategory] = useState<StaffTaskCategory>('review');
    const [addBusy, setAddBusy] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    const taskIdRef = useRef<string>(crypto.randomUUID());
    const requestRef = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const pagingRef = useRef(false);

    const loadTasks = useCallback(async (
        offset = 0,
        { append = false, clear = true }: { append?: boolean; clear?: boolean } = {},
    ) => {
        if (append && pagingRef.current) return;
        if (append) pagingRef.current = true;
        const request = ++requestRef.current;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const stale = () => request !== requestRef.current || controller.signal.aborted;
        setLoading(true);
        if (clear) setData(null);
        setLoadError(null);
        try {
            const params = new URLSearchParams({
                completed: showCompleted ? 'true' : 'false',
                limit: String(PAGE_SIZE),
                offset: String(offset),
            });
            if (category !== 'all') params.set('category', category);
            const response = await fetch(`/api/staff/tasks?${params.toString()}`, {
                headers: { accept: 'application/json' },
                signal: controller.signal,
            });
            if (stale()) return;
            if (response.status === 403) {
                setDenied(true);
                setSessionLost(false);
                setData(null);
                return;
            }
            if (response.status === 401 || response.status === 428) {
                setDenied(false);
                setSessionLost(true);
                setData(null);
                return;
            }
            if (!response.ok) {
                setLoadError('Could not load tasks.');
                return;
            }
            const payload = await response.json().catch(() => null);
            if (stale()) return;
            const result = payload?.result as StaffTaskListResult | undefined;
            if (!result) {
                setLoadError('Could not load tasks.');
                return;
            }
            setDenied(false);
            setSessionLost(false);
            setData((previous) => {
                if (!append || !previous) return result;
                const seen = new Set(previous.tasks.map((task) => task.id));
                return {
                    ...result,
                    tasks: [
                        ...previous.tasks,
                        ...result.tasks.filter((task) => !seen.has(task.id)),
                    ],
                };
            });
        } catch {
            if (stale()) return;
            setLoadError('Could not load tasks.');
        } finally {
            if (!stale()) setLoading(false);
            if (append) pagingRef.current = false;
        }
    }, [category, showCompleted]);

    useEffect(() => () => {
        requestRef.current += 1;
        abortRef.current?.abort();
    }, []);

    useEffect(() => {
        void loadTasks(0);
    }, [loadTasks]);

    const toggleTask = async (task: StaffTask, completed: boolean) => {
        if (busyId || !data || loading || addBusy) return;
        const previous = data;
        // Prevent an older list response from restoring the optimistic row.
        requestRef.current += 1;
        abortRef.current?.abort();
        setData(taskCompletionView(previous, task, completed));
        setBusyId(task.id);
        setActionError(null);
        setActionStatus(null);
        try {
            await staffMutation('/api/staff/tasks', {
                action: 'setCompleted',
                taskId: task.id,
                completed,
                expectedVersion: task.version,
            });
            setActionStatus(completed ? 'Task completed.' : 'Task reopened.');
        } catch (error) {
            setData(previous);
            // A conflict or lost permission must reconcile with the server.
            void loadTasks(0, { clear: false });
            setActionError(
                error instanceof Error ? error.message : 'Could not save. Please try again.');
        } finally {
            setBusyId(null);
        }
    };

    const openAddDialog = () => {
        taskIdRef.current = crypto.randomUUID();
        setAddError(null);
        setAddOpen(true);
    };

    const editAddField = () => {
        if (addError) {
            taskIdRef.current = crypto.randomUUID();
            setAddError(null);
        }
    };

    const submitTask = async () => {
        if (addBusy) return;
        setAddBusy(true);
        setAddError(null);
        try {
            await staffMutation('/api/staff/tasks', {
                action: 'create',
                taskId: taskIdRef.current,
                title: addTitle,
                category: addCategory,
            });
            setAddOpen(false);
            setAddTitle('');
            if (showCompleted || (category !== 'all' && category !== addCategory)) {
                setShowCompleted(false);
                setCategory(addCategory);
            } else {
                void loadTasks(0);
            }
        } catch (error) {
            setAddError(
                error instanceof Error ? error.message : 'Could not save. Please try again.');
        } finally {
            setAddBusy(false);
        }
    };

    const countFor = (value: 'all' | StaffTaskCategory) =>
        data?.counts ? data.counts[value] : '–';

    return (
        <Card id="tasks">
            <CardHeader className="gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2 text-base">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-secondary">
                            <ClipboardList
                                className="h-3.5 w-3.5 text-secondary-foreground"
                                aria-hidden="true"
                            />
                        </span>
                        To-do
                    </CardTitle>
                    <span className="flex items-center gap-2">
                        {writeEnabled && !denied && !sessionLost ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={openAddDialog}
                                disabled={busyId !== null || addBusy}
                            >
                                <Plus aria-hidden="true" />
                                Add task
                            </Button>
                        ) : null}
                        <Button
                            variant="outline"
                            size="sm"
                            aria-pressed={showCompleted}
                            onClick={() => {
                                setShowCompleted((value) => !value);
                                setData(null);
                                setLoading(true);
                            }}
                            disabled={busyId !== null || denied || sessionLost || (loading && !data)}
                        >
                            {showCompleted
                                ? `Showing completed (${data?.counts.completed ?? '–'})`
                                : `Completed (${data?.counts.completed ?? '–'})`}
                        </Button>
                    </span>
                </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {denied ? (
                    <p className="text-sm text-muted-foreground">
                        Task tracking requires the collaboration.read permission.
                    </p>
                ) : sessionLost ? (
                    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                        <p className="text-sm text-muted-foreground">
                            Your session expired. Sign in again.
                        </p>
                        <a
                            href="/staff/sign-in"
                            className="rounded-sm text-sm font-medium text-accent-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            Sign in
                        </a>
                    </div>
                ) : (
                    <>
                        <Tabs
                            value={category}
                            onValueChange={(value) => {
                                setCategory(value as 'all' | StaffTaskCategory);
                                setData(null);
                                setLoading(true);
                            }}
                        >
                            <TabsList
                                aria-label="To-do categories"
                                className="grid grid-cols-2 sm:flex"
                            >
                                {CATEGORIES.map((entry) => (
                                    <TabsTrigger
                                        key={entry.value}
                                        value={entry.value}
                                        disabled={busyId !== null || addBusy}
                                    >
                                        {entry.label}
                                        <Badge variant="secondary">
                                            {countFor(entry.value)}
                                        </Badge>
                                    </TabsTrigger>
                                ))}
                            </TabsList>
                        </Tabs>

                        <span role="status" aria-live="polite" className="sr-only">
                            {actionError ?? actionStatus ?? ''}
                        </span>
                        {actionError ? (
                            <p role="alert" className="text-sm text-destructive">
                                {actionError}
                            </p>
                        ) : null}
                        {loadError && data ? (
                            <p role="alert" className="text-sm text-destructive">
                                {loadError}
                            </p>
                        ) : null}

                        {loading && !data ? (
                            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                                Loading tasks…
                            </p>
                        ) : !data ? (
                            <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-8 text-center">
                                <p className="text-sm text-muted-foreground">
                                    {loadError ?? 'Could not load tasks.'}
                                </p>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void loadTasks(0)}
                                >
                                    Retry
                                </Button>
                            </div>
                        ) : data.tasks.length === 0 ? (
                            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                                {data.total > 0
                                    ? 'More tasks remain in this view. Choose Show more to load them.'
                                    : showCompleted
                                      ? 'No completed tasks in this view'
                                      : category === 'all'
                                        ? 'You’re up to date'
                                        : 'No tasks in this category'}
                            </p>
                        ) : (
                            <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                                {data.tasks.map((task) => (
                                    <li
                                        key={task.id}
                                        className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5"
                                    >
                                        {writeEnabled ? (
                                            <Checkbox
                                                aria-label={
                                                    showCompleted
                                                        ? `Reopen ${task.title}`
                                                        : `Mark ${task.title} complete`
                                                }
                                                checked={showCompleted}
                                                disabled={busyId !== null || loading || addBusy}
                                                onCheckedChange={(checked) =>
                                                    void toggleTask(task, checked === true)
                                                }
                                                className="mt-0.5"
                                            />
                                        ) : null}
                                        <div className="flex min-w-0 flex-col">
                                            <span
                                                className={
                                                    showCompleted
                                                        ? 'text-sm font-medium text-muted-foreground line-through'
                                                        : 'text-sm font-medium text-foreground'
                                                }
                                            >
                                                {task.title}
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {CATEGORIES.find(
                                                    (entry) => entry.value === task.category,
                                                )?.label ?? task.category}
                                            </span>
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {data && data.tasks.length < data.total ? (
                            <Button
                                variant="outline"
                                size="sm"
                                className="self-start"
                                disabled={loading || busyId !== null || addBusy}
                                onClick={() =>
                                    void loadTasks(data.tasks.length, { append: true, clear: false })
                                }
                            >
                                Show more ({data.total - data.tasks.length} remaining)
                            </Button>
                        ) : null}
                    </>
                )}
            </CardContent>

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add task</DialogTitle>
                        <DialogDescription>
                            A personal to-do item — only visible to you.
                        </DialogDescription>
                    </DialogHeader>
                    <form
                        className="flex flex-col gap-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void submitTask();
                        }}
                    >
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="task-title">Title</Label>
                            <Input
                                id="task-title"
                                required
                                maxLength={256}
                                value={addTitle}
                                disabled={addBusy}
                                onChange={(event) => {
                                    setAddTitle(event.target.value);
                                    editAddField();
                                }}
                                placeholder="e.g. Follow up on interview feedback"
                            />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <Label htmlFor="task-category">Category</Label>
                            <Select
                                value={addCategory}
                                disabled={addBusy}
                                onValueChange={(value) => {
                                    setAddCategory(value as StaffTaskCategory);
                                    editAddField();
                                }}
                            >
                                <SelectTrigger id="task-category" aria-label="Task category">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="review">Review</SelectItem>
                                    <SelectItem value="interviews">Interviews</SelectItem>
                                    <SelectItem value="notes">Notes</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        {addError ? (
                            <p role="alert" className="text-sm text-destructive">
                                {addError}
                            </p>
                        ) : null}
                        <div className="flex justify-end gap-2">
                            <Button
                                variant="outline"
                                onClick={() => setAddOpen(false)}
                                disabled={addBusy}
                            >
                                Cancel
                            </Button>
                            <Button
                                type="submit"
                                disabled={addBusy || !addTitle.trim()}
                            >
                                {addBusy ? 'Adding…' : 'Add task'}
                            </Button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
