# Candidate Applications

## Deployment safety

Local edits and commits do not affect Vercel. Pushing this feature branch may create a preview deployment, but it must not change production unless Vercel is explicitly configured to treat this branch as its production branch.

The database migration is additive and must be applied before deploying the application code. If the code is deployed first, submissions will fail safely and uploaded CVs will be removed, but candidates will not be able to complete applications.

An `APPLICATION_SAVE_FAILED` response means the CV upload succeeded but the application result could not be confirmed. On Preview, verify that its Supabase project has the intake migration before debugging the file upload. For an uncertain database outcome, the API retains the uploaded object rather than risk deleting a CV belonging to a committed application; orphan reconciliation remains an operational follow-up.

## Canonical branch migration

The Next.js application currently runs from Vercel's `production-v1` branch while GitHub's default branch is `main`. Use this order to make `main` canonical without interrupting production:

1. Apply the additive Supabase migration and verify the production bucket before deploying application code.
2. Merge the tested Next.js migration PR into `main` while Vercel still treats `production-v1` as its Production Branch. The existing production deployment remains live.
3. Let Vercel build the resulting `main` commit as a Preview and run smoke tests against that exact deployment.
4. In Vercel Project Settings, change the Production Branch to `main` and deploy or promote the tested `main` commit.
5. Verify `/`, `/jobs`, Google staff sign-in, and one controlled candidate submission on the production domain.
6. Keep the previous Vercel production deployment available for immediate rollback. Stop using `production-v1` for new work after the cutover.

Vercel deployments are immutable and the production alias changes only after a successful deployment, so the existing site continues serving during the build. Do not delete `production-v1` or the previous deployment as part of the cutover.

GitHub Actions now validates pull requests and pushes to `main`; it does not deploy the site. Vercel remains the only application deployment system. The former GitHub Pages workflow was removed because a server-rendered Next.js API cannot be deployed as a static `dist` artifact.

## Local setup

Prerequisites are Node 22 and a running Docker-compatible container runtime.

1. Run `nvm use` if you use nvm, then run `npm ci`.
2. Run `npm run local:start`.
3. Copy `.env.example` to `.env.local` and replace the Supabase values with those printed by `npm run local:status`.
4. Run `npm run local:reset` to rebuild the local database, apply every migration, and seed it.
5. Run `npm run dev` and open `http://127.0.0.1:3000/jobs`.

`SUPABASE_SERVICE_ROLE_KEY` is server-only. Never prefix it with `NEXT_PUBLIC_`, expose it to browser code, commit `.env.local`, or use a production key for local development. The standard keys printed by the local Supabase CLI are development credentials and are safe only for this isolated local stack.

Useful local services:

| Service | URL |
| --- | --- |
| Application | `http://127.0.0.1:3000` |
| Supabase API | `http://127.0.0.1:54321` |
| Supabase Studio | `http://127.0.0.1:54323` |
| Local email inbox | `http://127.0.0.1:54324` |

Use `npm run local:status` to inspect the stack and `npm run local:stop` when finished. Local Supabase data persists between normal stops; `npm run local:reset` intentionally deletes and recreates only the local database.

## Public intake architecture

`/jobs` reads published, publicly listed, open jobs through `app.list_public_jobs_v1` over the `INTAKE_DATABASE_URL` connection (`app_intake` role, anonymous context — no staff actor). When intake is not configured the page falls back to the bundled static listing; a configured listing that fails renders empty rather than silently falling back. Stealth clients are projected through the reviewed publication snapshot, so private names, contacts and identifiers never reach the board. Jobs can be hidden from the board per job via the `publicly_listed` flag (staff toggle on the job workspace) without withdrawing publication, independently of client stealth.

`POST /api/submit-signal` validates the form against the live public listing, uploads the CV to `cv-submissions`, hashes the bytes (SHA-256) and calls `app.submit_public_application_v1`. Each new anonymous submission creates a provisional candidate and a separate application; an unverified email or identical CV never links it to another person. The procedure re-validates the job, places the application on the pipeline's initial stage with an intake-audited history row, and registers the blob/document chain in one transaction. At the database step, a stable submission ID and content digest return the original application on a retry while rejecting changed content under the same ID. The HTTP route still checks job availability and Storage first, so a retry can fail before reaching that database step if either becomes unavailable. Known rejected writes remove their uploaded object; uncertain outcomes retain it for reconciliation. Spam control is a honeypot (successful-looking `202` without processing), a per-IP sliding-window limit (5 per 10 minutes, best-effort in-memory) and a durable per-address daily cap in the procedure. Submissions no longer touch `public.applicants`.

## Duplicate review

Staff with `candidates.read` and `duplicates.review` can open `/staff/candidates/duplicates`. Exact normalized-email and CV-byte-hash matches create ordered review pairs within the organization. Reviewers can confirm a match or mark a pair as different people. These review decisions alone do not change applications or CVs. An administrator with `candidates.merge` can choose the primary profile and email, then merge the pair in one database transaction. Applications, sources, identifiers, notes and documents move to the surviving candidate; identical live CV blobs are consolidated without changing application-document IDs. Other email identifiers remain searchable and appear on the surviving profile. The retired candidate redirects to the surviving profile. Merge provenance and review decisions are retained separately.

The merge refuses records with privacy cases, disclosures, processing purposes, legacy links or archived source-file history. These require a separately reviewed privacy-aware resolution; do not work around the refusal by editing tables directly. The merge does not delete physical CV bytes. For release, apply `20261001090000_public_intake_duplicate_review.sql` and then `20261001100000_candidate_merge.sql` to each nonproduction database before deploying this code. Rehearse against synthetic data, including an identical CV and a prior privacy request. Production migration and deployment require the database/Vercel maintainers; local tests do not update those services.

For a no-secrets UI preview, run the development server and open `/dev/duplicate-review`; this route uses synthetic in-memory data, and returns 404 in production. For the real database and authenticated browser checks on disposable local PostgreSQL, run `npm run test:duplicate-review` with Node 22 and Docker running. Do not run the browser check concurrently with another Next dev/build process in the same checkout.

## Verification

Run the fast checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The normal E2E suite intercepts the submission API and cannot write candidate data.

To exercise the complete API, storage, and database flow against local Supabase:

```bash
npm run test:e2e:backend
```

The shared Playwright configuration rejects non-allowlisted Supabase targets before starting any test, including filtered backend cases. Only `http://127.0.0.1:54321` and `http://localhost:54321` (with an optional trailing slash) are permitted. Backend mode also requires the local `SERVICE_ROLE_KEY` JWT printed by `supabase status`, not a hosted project key. The credential check is an accidental-environment safeguard, not JWT authentication; the local service authenticates the actual requests.

Playwright always starts its own app server. Stop any existing app on port 3000 before running the suite so it cannot reuse a server initialized with different credentials. Do not forward these allowed loopback ports to a remote database/API. Extending the suite to preview requires a reviewed environment identity guard; changing an environment variable does not authorize production testing.

The integration cases seed a published public job, submit structurally valid synthetic PDF and DOCX files through the board UI, verify the `app.*` candidate/application/document chain over a direct database connection, compare downloaded private bytes, and remove their own rows and objects. Backend mode needs `INTAKE_DATABASE_URL` (and `STAFF_ORGANIZATION_ID`) pointing at the local stack — `postgresql://postgres:postgres@127.0.0.1:54322/postgres` by default.

See [the architecture implementation documents](architecture/README.md) for the proposed schema, outstanding decisions and acceptance gates.

## Maintainer handoff

The maintainer must:

1. Review and apply `supabase/migrations/20260911120000_candidate_applications.sql` to Supabase.
2. Confirm the existing `cv-submissions` bucket is private and accepts `application/pdf` and `application/vnd.openxmlformats-officedocument.wordprocessingml.document` files up to 4 MB. The migration deliberately does not overwrite an existing bucket's settings.
3. Confirm Preview and Production have `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STAFF_DATABASE_URL`, `STAFF_ORGANIZATION_ID`, and `INTAKE_DATABASE_URL` configured. `INTAKE_DATABASE_URL` must use a login role whose only membership is `app_intake`.
4. Verify the Vercel preview before merging.
5. Run one controlled production submission after deployment and confirm the applicant row and private CV object.
