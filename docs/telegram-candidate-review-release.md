# Telegram candidate intake

Telegram is an intake source. The main flow is Connect → Choose chats → Review proposals. Approved information is saved to the candidate database; candidate search defaults to approved profiles, independently of Telegram.

- Chat selections survive search and pagination. Start atomically enables importing and candidate extraction for up to 50 selected chats.
- Review shows a profile preview, highlights changes against an existing candidate, and offers Approve, Edit, and Reject. CVs, individual suggestions, and message evidence are available on demand. A name is required; email and CV are optional for this intake flow.
- Exact email or Telegram user identifiers suggest an existing candidate only when there is one visible active match. Reviewers can search for and explicitly select a different existing candidate. Names alone never automatically merge records.
- Approvals preserve unmentioned fields, reject stale candidate versions and unseen proposal changes, and use the existing candidate save/indexing procedures. Refresh rebases saved proposed changes onto the latest profile for another review.
- Rejecting an update leaves the candidate unchanged and permits future proposals for that person.
- New extraction batches request source release automatically. The existing maintenance worker deletes sources only after all associated proposals, drafts, context dependencies, and CV work permit it. Existing sources associated with an opened proposal adopt the same policy. Candidate records and their audit history remain.

## Release

Apply `20261013180000_telegram_candidate_review.sql` before deploying these application changes. Keep the existing Telegram connector, extraction worker, semantic worker/local embedding service, and maintenance worker running. This change does not replace the embedding model or deploy any services.

## Focused verification

Node 22: `npm run typecheck`. Focused database and browser checks: `node --test tests/database/telegram-candidate-review.test.js tests/staff-workspace/telegram-candidate-flow.test.js`. These use disposable local PostgreSQL databases and synthetic authenticated sessions. Browser screenshots are saved under `test-results/candidate-flow-*.png`.
