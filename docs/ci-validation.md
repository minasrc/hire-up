# CI validation policy

Run checks affected by the change, not every suite for every PR. `scripts/ci-selection.mjs` selects jobs and records the selection in the Actions summary. Documentation-only changes skip application checks. Narrow staff directory and document preview changes run workspace checks; candidate pages also run their dependent review/search suites. Shared layouts run all affected browser workflows without dedicated database-only jobs. Shared authorization changes run staff suites. Unreviewed schema changes, dependencies, shared test infrastructure and unknown paths get full coverage. Manual CI dispatch explicitly requests full validation; do not use it to run a narrow PR.

A reviewed migration that changes only a feature's existing function may be mapped to its owning suite when that suite applies the migration and tests its security boundaries. The selector pins the reviewed file's SHA-256: modified, deleted or unknown migrations restore full coverage. The document preview migration runs authenticated workspace coverage, including document access, revoked membership/permissions, lifecycle, file version and audit checks. Other changed paths still add their own required suites; a scoped migration never cancels shared-layout or authorization coverage.

A merge into main reuses a successful PR CI run only when the merge tree exactly equals the PR head tree and the latest CI run for that same repository/head succeeded. A changed merge result, direct push, missing proof or API error runs the affected checks instead. This preserves the main CI workflow completion event used by database releases.

`CI validation` is the aggregate check: failed, cancelled or unexpectedly skipped selected jobs fail it. If branch protection is configured, require that check rather than every optional suite. Do not remove required checks through this change.

For local work, run focused checks while editing and broaden once when shared boundaries change. After checks pass, repeat only for new code, a failure, a changed merge result or an unresolved risk. An identical tested merge needs no new local suite run.

When adding a feature or suite, update the selector and its tests. Unknown files deliberately select all jobs until their dependencies are mapped.

The current workflows use only `actions/checkout@v4`, `actions/setup-node@v4`, `actions/setup-python@v5` and `supabase/setup-cli@1dedf2c611547ede7232d26866dd3c56ab903bbb`. Allow these exact references in repository Actions permissions. CI validates code; database migration is a separate production-gated release workflow. Telegram maintenance is scheduled operational work, not PR validation.
