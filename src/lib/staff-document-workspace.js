const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only read-only document navigation uses this query expectation. It selects no
// workspace and grants no access; the normal gate checks cookie, membership,
// MFA and document permissions before signing or returning bytes.
export function documentWorkspaceExpectation(url) {
    const values = new URL(url).searchParams.getAll('_workspace');
    if (!values.length) return null;
    return values.length === 1 && UUID.test(values[0]) ? values[0] : 'invalid';
}
