# Public repository safety

Keep environment files, paired-device credentials, Telegram session files,
private runtime directories and Next.js output outside Git. `.env.example` may
contain placeholders only. Ignore rules protect ordinary `git add`; the separate
**Public repository safety** workflow also rejects these files when force-added.
It uses a pinned, checksum-verified Gitleaks release, scans the tracked source and
scans every introduced commit so deleting a secret in a later commit does not
hide it. Exceptions cover three exact public test vectors in their fixture files;
they do not exclude those files from other secret checks. Findings are redacted.

The check installs no application dependencies and starts no app, database,
worker or model service. It is independent of application CI selection. A manual
run scans all locally fetched history; it will still fail on the historical
development build keys until the separate history cleanup is applied.

Use your GitHub-provided `users.noreply.github.com` email for new commits. Configure
it in your own clone rather than changing another writer's checkout. A public
mailmap containing old private addresses would expose those addresses again.

## Historical cleanup requires a coordinated pause

The October 2026 audit found generated Next.js development encryption/preview
keys and personal email addresses in February history. The old notification
recipient is already absent from current source. Adding ignore rules or deleting
files in a new commit does not erase historical versions.

Prepare cleanup in a separate private mirror: remove `.next` output, replace the
private addresses in old file contents/messages, and map private author/committer
addresses to noreply identities while preserving contributor names. Keep the
original addresses and replacement maps out of this public repository. Verify
all rewritten refs and compare every branch tip's files against the original;
application files should be unchanged except any explicitly reviewed private
address substitutions. Save a private rollback bundle and the commit map.

Before publishing rewritten history, pause all writers and workflows that push,
finish or preserve their work, and refresh the mirror. Abort if the remote ref
inventory or any recorded branch tip has changed. Publish only reviewed branch
updates using an atomic push and an explicit force-with-lease for every branch;
never use an unconditional force or a mirror push. Writers must then re-clone or
rebase preserved work onto the new history rather than merge old history back.

GitHub-managed pull-request refs and cached views cannot be rewritten through a
normal push. Review them after the branch cleanup and request GitHub assistance
if sensitive cached content remains. Existing forks and downloads cannot be
retracted. Keep private rollback material outside the public repository.

Rebuild any deployment that still uses an affected historical build so its
generated keys are fresh. CI browser artifacts use development credentials and
must not be deployed to production. Do not print old keys, addresses or session
data in PRs, logs or remediation reports.
