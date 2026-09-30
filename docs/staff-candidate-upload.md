# Recruiter candidate upload

The Candidates page opens an Add candidate form for staff who can write candidate profiles. Creating a candidate requires first name, last name, one primary email, and a PDF or DOCX CV no larger than 4 MB. Up to nine secondary email addresses are optional, as are location, role/headline, compensation preference, profile URL, owner and professional summary.

The upload endpoint checks candidate and document permissions, validates the file contents, and stores the CV in the private `cv-submissions` bucket. It saves the candidate, email identifiers and document records in one database transaction. An email matching an existing candidate returns a conflict and lets the recruiter open that candidate. The primary email remains the profile contact; secondary emails also participate in duplicate detection.

Retries with the same operation and payload return the original candidate. Draft fields and the selected CV stay in the form after a failed request. Uploaded objects are removed only after confirming that no document references them; uncertain database outcomes retain the object rather than risking a broken CV.

## Release

Apply the existing candidate-profile and intake-serialization migrations, then the additive `20261002100000_candidate_upload.sql` migration before enabling this UI. The server needs the existing `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` storage configuration and a private `cv-submissions` bucket. Existing document download controls remain in force. No duplicate-review migrations are modified.

The upload API is `POST /api/staff/candidates/upload`, using multipart `fields` JSON, `cvFile` and `operationId`. The browser never receives storage service credentials.

## Verification

Use Node 22. `npm test` includes upload contracts, actual file validation, API outcomes and safe cleanup. `npm run test:db:candidate-upload` creates a disposable PostgreSQL 17 container to verify persistence, duplicate conflicts, retry behavior, permissions and metadata cleanup. `npm run test:staff-workspace` includes desktop/mobile candidate form checks; its browser upload route uses synthetic storage responses, while the database suite tests the real persistence function. For a focused browser run, use `STAFF_WORKSPACE_CANDIDATES_ONLY=1 node --test tests/staff-workspace/workspace.test.js`.
