import { createHash } from 'node:crypto';

// Cache credential liveness only, never membership, permissions or MFA. Each
// credential gets the same 60-second lifetime, including unknown/revoked results.
export function createGoogleCredentialCache({ now = Date.now } = {}) {
    const outcomes = new Map();
    const inFlight = new Map();
    return async function credentialStatus(subject, refreshToken, check) {
        if (!refreshToken) return 'revoked';
        // Full-token digest avoids collisions between credentials with equal
        // suffixes without retaining the refresh token in either cache key.
        const key = `${subject}:${createHash('sha256').update(refreshToken).digest('hex')}`;
        const cached = outcomes.get(key);
        if (cached && now() - cached.at < 60_000) return cached.status;
        if (inFlight.has(key)) return inFlight.get(key);

        const pending = Promise.resolve().then(() => check(refreshToken)).then((status) => {
            outcomes.delete(key);
            outcomes.set(key, { at: now(), status });
            if (outcomes.size > 1000) outcomes.delete(outcomes.keys().next().value);
            return status;
        }).finally(() => {
            inFlight.delete(key);
        });
        inFlight.set(key, pending);
        return pending;
    };
}
