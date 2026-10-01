export class StaffMutationError extends Error {
    status: number;
    code?: string;
    fieldErrors: Record<string, string>;

    constructor(
        status: number,
        message: string,
        options: { code?: string; fieldErrors?: Record<string, string> } = {},
    ) {
        super(message);
        this.name = 'StaffMutationError';
        this.status = status;
        this.code = options.code;
        this.fieldErrors = options.fieldErrors ?? {};
    }
}

const stringFieldErrors = (payload: unknown): Record<string, string> => {
    const fields = (payload as { fields?: unknown } | null)?.fields;
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        return {};
    }
    return Object.fromEntries(
        Object.entries(fields).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
};

export async function staffMutation(url: string, body: unknown) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const fieldErrors = response.status === 400
            ? stringFieldErrors(payload)
            : {};
        throw new StaffMutationError(
            response.status,
            response.status === 409
                ? 'This record changed. Reload and try again.'
                : response.status === 401 || response.status === 428
                  ? 'Your session expired. Sign in again.'
                  : response.status === 403
                    ? 'You do not have permission to make this change.'
                    : response.status === 400 && payload?.fields !== undefined
                      ? 'Some fields need attention. Please check your entries.'
                      : 'Could not save. Please try again.',
            {
                code: typeof payload?.code === 'string' ? payload.code : undefined,
                fieldErrors,
            },
        );
    }
    window.dispatchEvent(new CustomEvent('staff-workspace-updated', {
        detail: { scope: url === '/api/staff/tasks' ? 'tasks' : 'workspace' },
    }));
    return payload;
}
