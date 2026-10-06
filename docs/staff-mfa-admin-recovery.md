# Administrator-assisted authenticator recovery

Apply `20261007090000_staff_mfa_admin_recovery.sql` after the stable-enrollment migration and before deploying the reset endpoint.

If a member loses both their authenticator and saved backup codes, a staff administrator can open **Members**, select **Reset authenticator** for that active member, and choose a reason. Verify the member's identity outside the application first. Enter a fresh code from your own authenticator and confirm the reset.

The reset keeps the member's Google identity, membership and permissions. It revokes every active or pending authenticator in the organization. Existing MFA proofs and all backup codes for those credentials stop working on the next access check. The member must open the staff workspace, sign in with the same Google account, enroll an authenticator again, and save a new backup-code set.

Reset requires `staff.manage`, a verified staff session, and a fresh, unused authenticator code. Backup codes cannot authorize a reset. Administrators cannot reset themselves through this workflow. A sole administrator who loses all recovery factors still needs an operator recovery process; this workflow does not bypass that boundary.

The selected membership version must still match, and the reset advances it. Concurrent or stale reset requests fail without repeating the reset. The administrator's code replay counter, credential revocations, membership version and audit event commit together. The audit event records the administrator, selected member and reason without storing codes or secrets.

Reset attempts share the administrator's ten-attempt, ten-minute MFA budget. A network failure after commit may hide a completed reset. Reload the Members page and ask the member to open the workspace before trying again. No automatic email is sent.
