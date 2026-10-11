# Public repository safety

Keep credentials, local environment files, private runtime data, and generated
build output out of Git. Commit only placeholders in `.env.example`.

The **Public repository safety** workflow checks tracked files and scans new
commits for secrets. Manual runs scan all fetched history. Findings are redacted.

Use your GitHub-provided `users.noreply.github.com` email for commits. Keep
sensitive findings and remediation records in private documentation.
