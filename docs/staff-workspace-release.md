# Invitation-only workspace release

Apply migrations `20261013130000` and `20261013140000` after the required checks
pass. Deploy the matching application, then set `STAFF_MULTI_WORKSPACE_ENABLED=1`
and redeploy. The flag defaults off; disabling it restores the configured legacy
workspace and ignores stale selection cookies. Fresh membership and MFA checks
remain required in either mode.

The original platform administrators receive workspace creation access. New
customer administrators cannot grant themselves platform provisioning access.
The pilot permits 100 created workspaces per platform root and ten active
Telegram enrollments across the local service. Capacity errors identify the
limit instead of suggesting that another retry will fix it.

To invite an outside administrator:

1. Sign in to the original workspace and finish its MFA verification.
2. Open **Choose workspace**, then **Create workspace**.
3. Enter the workspace name and the administrator’s Google email address.
4. Copy the invitation link shown in the receipt and share it with that person.
5. The invitee signs in with that exact Google account, opens the invitation,
   accepts it, and enrolls the workspace’s authenticator.
6. They open **Telegram**, click **Connect Telegram**, approve the QR sign-in
   in the Telegram mobile app, and enter their Telegram two-step password if
   required. They choose which chats to import and can then search or open them.

Invitees do not need Supabase, Vercel, command-line tools, or app secrets. Each
workspace uses its own membership, permissions and authenticator credential;
Telegram source records are also scoped to the individual owner. Invitation
links are routing hints and cannot replace identity or membership checks.

The Mac service must remain online and awake for sign-in and synchronization.
Already imported conversations remain searchable when it is offline. Its
configured app credentials are shared infrastructure; user sessions remain in
separate private encrypted vaults. Move the same service protocol to an
always-on host when pilot availability or capacity requires it.

Ordinary staff links replace the whole workspace document. Filters and other
programmatic navigation preserve focus through an explicit workspace
expectation. Stale API requests fail before business operations, and stale tabs
show a reload/chooser notice. The browser fixture covers both real cross-tab
storage events and disabled localStorage.
