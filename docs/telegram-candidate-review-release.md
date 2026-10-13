# Telegram candidate intake

Telegram is an intake source. The main flow is Connect → Choose chats → Review proposals. Approved information is saved to the candidate database; candidate search defaults to approved profiles, independently of Telegram.

- First-time visitors see a compact Connect → Choose chats → Review guide. Starting an import records onboarding completion for that recruiter and workspace. Later Telegram visits open proposals; Manage chats remains available. Removing chats or disconnecting does not restart onboarding. Existing imports are recognized automatically.
- Overview To-do includes pending candidate proposal links and a count, derived from the private review inbox. Resolved proposals disappear on the next overview visit.
- Chat selections survive search and pagination. Start atomically enables importing and candidate extraction for up to 50 selected chats.
- Review shows a profile preview, highlights changes against an existing candidate, and offers Approve, Edit, and Reject. Existing profile updates require an Approve or Reject choice for each changed field before Save updates. Rejected values revert to the current profile; rejecting every change closes the proposal without saving a profile update. CVs, individual suggestions, and message evidence are available on demand. A name is required; email and CV are optional for this intake flow.
- Exact email or Telegram user identifiers suggest an existing candidate only when there is one visible active match. Reviewers can search for and explicitly select a different existing candidate. Names alone never automatically merge records.
- Approvals preserve unmentioned fields, reject stale candidate versions and unseen proposal changes, and use the existing candidate save/indexing procedures. Refresh rebases saved proposed changes onto the latest profile for another review.
- Rejecting an update leaves the candidate unchanged and permits future proposals for that person.
- New extraction batches request source release automatically. The existing maintenance worker deletes sources only after all associated proposals, drafts, context dependencies, and CV work permit it. Existing sources associated with an opened proposal adopt the same policy. Candidate records and their audit history remain.

## Release

Apply `20261013180000_telegram_candidate_review.sql` and `20261014100000_telegram_onboarding.sql` before deploying these application changes. Keep the existing Telegram connector, extraction worker, semantic worker/local embedding service, and maintenance worker running. This change does not replace the embedding model or deploy any services.

## Focused verification

Node 22: `npm run typecheck`. Focused database and browser checks: `node --test tests/database/telegram-candidate-review.test.js tests/staff-workspace/telegram-candidate-flow.test.js`. These use disposable local PostgreSQL databases and synthetic authenticated sessions. Browser screenshots are saved under `test-results/candidate-flow-*.png`.

## Local interactive demo

With Node 22 and Docker Desktop running, run `npm run dev:telegram-fixture` from this checkout and open `http://127.0.0.1:3013/`. The launcher signs you into a disposable workspace with sample chats, new candidate proposals, and an existing candidate update. Approve, edit, reject, and manual matching use the real database operations. Stop the launcher with Ctrl+C to remove its temporary database; restarting resets the sample data.

The demo does not sign into a real Telegram account, process live messages, or run an embedding worker. Live import and ranked search require the existing configured workers.

## Live extraction demo

`npm run proxy:setup` installs the pinned, checksum-verified CLIProxyAPI release. `npm run proxy:login` authorizes model access, and `npm run proxy:start` keeps the loopback backend running. `npm run proxy:check` checks GPT-6 Luna availability. Then run `npm run dev:telegram-ai` and open `http://127.0.0.1:3013/`. Select the sample chats and press Start: the real extraction worker sends their synthetic messages to GPT-6 Luna and new proposals appear as each batch completes.

The review page uses an inline candidate list and detail pane with independent scrolling. Background arrivals refresh the list without resetting open profile edits.

## CV policy

The candidate table allows a null current document; the older upload workflow requires a CV. Telegram profile creation and enrichment intentionally allow no CV. Recommended policy: keep intake searchable without a CV, then require a CV at client submission when that process needs one. This change does not add a new submission requirement.
