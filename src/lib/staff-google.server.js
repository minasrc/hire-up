import 'server-only';
import { cookies } from 'next/headers';
import { getToken } from 'next-auth/jwt';
import { googleRefreshGrantStatus } from './staff-google-check';
import { createGoogleCredentialCache } from './staff-google-cache';

// Staff sessions carry a Google refresh token (minted with access_type=offline).
// Each staff request re-verifies that credential against Google's token
// endpoint so a suspended or deleted Google account loses staff access on its
// next request instead of riding out the session/MFA cookie TTLs.
//
// Outcomes are cached briefly per credential — enough to absorb a burst of
// page loads, short enough that a Workspace suspension propagates within a
// minute inside a warm instance.
const SESSION_COOKIE = 'next-auth.session-token';

const credentialStatus = createGoogleCredentialCache();

async function readStaffToken() {
    const cookieStore = await cookies();
    const jar = {};
    for (const cookie of cookieStore.getAll()) {
        jar[cookie.name] = cookie.value;
    }
    try {
        return await getToken({
            req: { cookies: jar },
            secret: process.env.NEXTAUTH_SECRET,
            cookieName: SESSION_COOKIE,
        });
    } catch {
        return null;
    }
}

/** @returns {Promise<'active' | 'revoked' | 'unknown'>} */
export async function staffGoogleCredentialStatus(subject) {
    const token = await readStaffToken();
    const refreshToken = typeof token?.googleRefreshToken === 'string'
        ? token.googleRefreshToken
        : null;
    // A missing offline credential still denies access until reauthentication.
    return credentialStatus(subject, refreshToken, (credential) =>
        googleRefreshGrantStatus(credential, {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        }));
}
