// Only QR provisioning labels change. Existing credential secrets and codes do
// not depend on the authenticator label and are never replaced here.
export function mfaEnrollmentLabel(accountName, workspaceName, multiWorkspace = false) {
    return multiWorkspace && workspaceName ? `${accountName} (${workspaceName})` : accountName;
}
