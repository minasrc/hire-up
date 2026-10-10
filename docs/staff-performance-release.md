# Staff responsiveness release

This change streams dashboard data after navigation renders, pages jobs and clients in groups of 50, reuses recent previews within the active browser session, and avoids flashing skeletons for loads shorter than 150 ms.

## Deployment

Apply these additive migrations to the target database before deploying the application:

1. `20261002110000_staff_shell_capabilities.sql`
2. `20261002120000_staff_list_pagination.sql`

They add authorized read functions; existing callers remain supported. The automatic production migration workflow runs after main CI, so it does not guarantee migration-before-Vercel ordering. Confirm the target migration history before release. Application rollback can use the previous deployment without removing these functions.

## Measure after release

The app already includes Vercel Speed Insights. Temporarily set `STAFF_PERFORMANCE_LOGS=1` to capture server-side `staff-read` durations for capabilities and summary reads. These logs contain fixed operation names and milliseconds, with no user or record identifiers. Disable the flag when the sample is sufficient.

Compare cold and warm navigation, first and subsequent previews, search, pagination, and save actions using the same account and dataset. Record median and p95 timings, plus response sizes. Server read durations include connection acquisition and authorization; they are not SQL-only measurements. Use database query plans and function traces if those readings remain slow.

Verify the configured Vercel execution region is close to the database region before changing either. Region placement and production latency are not established by local synthetic tests. Do not increase connection limits without accounting for serverless instance count and database connection capacity.

## Loading behavior

Navigation remains mounted while page content changes. Skeletons use neutral greys and a CSS-only 150 ms visibility delay; content itself is never delayed. List filters and page changes use transitions so existing rows remain visible with an updating indicator. Candidate stage and note saves keep their controls busy until refreshed data arrives.

Preview data lives only in the mounted preview component's memory: at most five records, retained for 15 seconds for reopening. Mutations, session changes, authorization failures, and window visibility/focus changes invalidate it. It is never persisted to browser storage or shared between users.

## Staff time-zone preference rollout

Merge the time-zone foundation before its workspace UI follow-up. Both pull requests target main so the repository's normal CI runs; the UI diff includes the foundation until that prerequisite is merged.

Apply `20261011090000_staff_time_zone.sql` before releasing the account settings and time-zone prompt. The foundation read falls back to UTC before migration, but preference saves require the new database function. The production migration workflow and Vercel deployment can complete in either order; confirm the migration history before enabling the UI.

The saved preference belongs to the staff account. Browser detection runs after hydration and when a visible page returns, at most once per minute. It never saves automatically. Switching or choosing a manual zone sends one authenticated preference write, then refreshes server content once after acknowledgement. “Keep current zone” stores only an account/saved-zone/device-zone dismissal in that browser. Calendar-only values retain their original date.

Verify a midnight timestamp in a preview and its full page, reload the chosen zone, and check another account remains independent. Current production directories have no date-range filters or CSV/report exports; their sample design-preview filters use calendar-only dates. When adding live date filters or reports, convert the selected zone's day boundaries to UTC and label the report/export zone explicitly.
