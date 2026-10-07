export async function staffMutation(url: string, body: unknown) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401 || response.status === 428) {
            window.dispatchEvent(new CustomEvent('staff-auth-required', {
                detail: { mfa: response.status === 428 },
            }));
        }
        throw new Error(
            payload.error === 'invite already exists'
                ? 'This email already has a membership or pending invitation. Check the member directory.'
                : response.status === 409
                ? 'This record changed. Reload and try again.'
                : response.status === 428
                  ? 'Verify your authenticator in another tab, then retry. Your changes have not been saved.'
                  : response.status === 401
                    ? 'Sign in again in another tab, then retry. Your changes have not been saved.'
                  : response.status === 403
                    ? 'You do not have permission to make this change.'
                    : response.status === 503
                    ? 'The workspace is temporarily unavailable. Your changes have not been saved. Please retry.'
                    : payload.fields
                      ? `Check these fields: ${Object.keys(payload.fields).join(', ')}`
                      : 'Could not save. Please try again.',
        );
    }
    window.dispatchEvent(new CustomEvent('staff-workspace-updated', {
        detail: { scope: url === '/api/staff/tasks' ? 'tasks' : 'workspace' },
    }));
    return payload;
}
