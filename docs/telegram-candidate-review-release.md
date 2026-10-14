# Telegram candidate intake

Telegram is an intake source. The main flow is Connect → Choose chats → Review proposals. Approved information is saved to the candidate database. The candidate directory has one search box and table: direct name/email matches use the directory lookup; when there is no direct match, descriptive queries rank saved profiles (including accessible retained CV text). The old separate search page redirects to the directory.

- First-time visitors see a compact Connect → Choose chats → Review guide. Starting an import records onboarding completion for that recruiter and workspace. Later Telegram visits open proposals; Manage chats remains available. Removing chats or disconnecting does not restart onboarding. Existing imports are recognized automatically.
- Overview To-do includes pending candidate proposal links and a count, derived from the private review inbox. Resolved proposals disappear on the next overview visit.
- After Start, the chat page stays in the processing phase. A single Review proposals action appears beside the progress bar as soon as pending proposals exist; reviewers can start before all chats finish. An empty completed import says No new candidates found.
- Available and Connected tabs have account-wide counts and independently paged/searchable results. Only Available chats have selection checkboxes and Start. Connected chats show Syncing, Synced, Paused, or Needs attention, with Pause/Resume controls; removed chats remain there with their reimport action. Start rejects previously connected chats in the backend. Resume and reimport also enable candidate extraction, preserving the single pipeline.
- Chat selections survive search and pagination. Start atomically enables importing and candidate extraction for up to 50 selected chats.
- Review shows a profile preview, highlights changes against an existing candidate, and offers Approve, Edit, and Reject. Existing profile updates offer Approve, Reject, and inline Edit on each changed field, followed by Save updates. Rejected values revert to the current profile; rejecting every change closes the proposal without saving a profile update. CVs, individual suggestions, and message evidence are available on demand. A name is required; email and CV are optional for this intake flow.
- Exact email or Telegram user identifiers suggest an existing candidate only when there is one visible active match. Reviewers can search for and explicitly select a different existing candidate. Names alone never automatically merge records.
- Approvals preserve unmentioned fields, reject stale candidate versions and unseen proposal changes, and use the existing candidate save/indexing procedures. Refresh rebases saved proposed changes onto the latest profile for another review.
- Rejecting a proposal saves an independent snapshot in the inbox’s Archived view, preserving profile information and an attached CV. Restore returns it to review; existing profile updates rebase onto the latest candidate. Saved candidates stay unchanged and later extraction can still propose new updates. Archived snapshots do not retain raw chat history. Earlier rejections that already cleared their fields cannot be reconstructed.
- New extraction batches request source release automatically. The existing maintenance worker deletes sources only after all associated proposals, drafts, context dependencies, and CV work permit it. Existing sources associated with an opened proposal adopt the same policy. Candidate records and their audit history remain.

## Release

Apply `20261013180000_telegram_candidate_review.sql`, `20261014100000_telegram_onboarding.sql`, `20261014110000_telegram_review_archive.sql`, `20261014120000_candidate_ranked_directory.sql`, `20261014130000_telegram_chat_groups.sql`, and `20261014140000_candidate_hybrid_search.sql` before deploying these application changes. Keep the existing Telegram connector, extraction worker, semantic worker/local embedding service, and maintenance worker running. This change does not replace the embedding model or deploy any services.

## Focused verification

Node 22: `npm run typecheck`. Focused database and browser checks: `node --test tests/database/telegram-candidate-review.test.js tests/staff-workspace/telegram-candidate-flow.test.js`. These use disposable local PostgreSQL databases and synthetic authenticated sessions. Browser screenshots are saved under `test-results/candidate-flow-*.png`.

## Local interactive demo

With Node 22 and Docker Desktop running, run `npm run dev:telegram-fixture` from this checkout and open `http://127.0.0.1:3013/`. The launcher signs you into a disposable workspace with sample chats, new candidate proposals, and an existing candidate update. Approve, edit, reject, and manual matching use the real database operations. Stop the launcher with Ctrl+C to remove its temporary database; restarting resets the sample data.

The demo does not sign into a real Telegram account, process live messages, or run an embedding worker. Live import and ranked search require the existing configured workers.

## Live extraction demo

`npm run proxy:setup` installs the pinned, checksum-verified CLIProxyAPI release. `npm run proxy:login` authorizes model access, and `npm run proxy:start` keeps the loopback backend running. `npm run proxy:check` checks GPT-6 Luna availability. Then run `npm run dev:telegram-ai` and open `http://127.0.0.1:3013/`. All six sample chats contain candidate messages. Talent network proposes changes to the existing Maya Chen profile: headline, location, summary, and salary preference. Select chats and press Start: the real extraction worker sends their synthetic messages to GPT-6 Luna and new proposals appear as each batch completes.

The review page uses an inline candidate list and detail pane with independent scrolling. Background arrivals refresh the list without resetting open profile edits.

## CV policy

The candidate table allows a null current document; the older upload workflow requires a CV. Telegram profile creation and enrichment intentionally allow no CV. Recommended policy: keep intake searchable without a CV, then require a CV at client submission when that process needs one. This change does not add a new submission requirement.

## Unified search locally

The current interactive demo has a semantic worker using the pinned MiniLM model on `127.0.0.1:8827`. This is separate from the older E5 service on 8817. Its private worker configuration is in ignored `.runtime/unified-search/semantic.json`; its demo credential expires when the disposable demo is stopped. For another workspace or a new demo run, follow `services/semantic-worker/README.md` to configure the current workspace worker credential and the matching local model. Search never presents unavailable inference as an empty successful result.

Candidate directory search matches names, emails, titles, locations, and profile summaries before using semantic fallback. Explicit year constraints use recorded profile experience (word and numeric forms); bare years mean an exact value, while “at least” and “6+” mean a minimum. Unknown experience is excluded. Semantic directory results require cosine similarity of at least 0.2 and at least 90% of the best candidate score for the query (the same cutoff on every page); this is a tunable relevance floor, not a match probability.
