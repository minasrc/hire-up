# Private imported-chat removal

Removal applies to one owned imported chat, including its retained message text,
source snapshots, quotes, attachment routing, copied extraction context and
unapproved derived drafts. Affected unapproved drafts are discarded with their
fields, private embeddings and analysis copies cleared. Private CV objects enter
the existing storage cleanup queue. Approved candidate profiles, reviewed CV
text and approved documents remain separately managed. Original Telegram
messages are never deleted.

The authenticated staff operation accepts only a chat UUID; the server derives
organization and owner. `preview` returns the chat version, retained message/byte
counts, affected unapproved draft count, approved candidate count and fixed scope
copy. Counts are advisory and may change before confirmation. `request` requires
`expectedVersion`, a UUID `operationId` and the exact confirmation
`remove_imported_history`. The operation receipt is owner scoped: identical
retries succeed, changed chat/version fails. Cross-owner identifiers return no
preview or status information.

Request deselects the chat, disables extraction and fences import/extraction/CV,
source sweep and native leases immediately. Triggers prevent new imports,
extraction retries, CV retrieval and approval from removal-pending source.
Removal is irreversible after confirmation; it has no cancellation action.

The ordinary independent maintenance entry point runs bounded removal work
before reviewed-source retention. Each removal turn processes at most five
extraction batches plus 1,000 remaining raw messages, and up to 1,000 entries
from each identity-only source/context ledger. CV analyses are cleared in batches
of at most 50 per affected draft or extraction batch. Actual deleted row bytes
and counts decrement owner capacity exactly once. Removal-owned batches cannot
be purged by ordinary retention outside this accounting seam. Existing raw-delete
hooks redact dependent immutable snapshots, including `contextOnly`, before
source deletion commits. Removal finalizes dependent source batches before their
origins and admits raw deletion only after all referring snapshots are gone,
keeping dependency fanout bounded. Busy consumer locks postpone a batch; retries preserve
progress. Removal works when no extraction worker or AI provider is configured.

Status adds `removalState` and `removal` to each of the existing history DTO's at
most 50 chats. States are `none`, `pending`, `device_pending`, `completed`.
The removal record reports `serverPurged`, `deviceCleanupPending` and
`storageCleanupPending` separately. Display “Server history removed; device
cleanup pending” when the server is finished but the connector is offline.
Completion waits for every device cleanup page acknowledgement and the queued
private CV-object deletions; it never promises physical cleanup after SQL alone.

The restricted connector claims an owner-and-original-worker-scoped cleanup page:

```js
{ cleanup: null /* or */ {
  removalId, chatId, connectionId, accountUserId,
  peer: { kind, id }, historyJobId,
  cvJobIds: [/* at most 50 UUIDs */], cleanupToken
} }
```

A repeated claim returns the exact same page until acknowledged. The authenticated
acknowledgement takes `removalId` and `cleanupToken`; its durable receipt allows
lost responses to retry, including after the next page was issued. The last page
marks device cleanup acknowledged. No Telegram account access is needed for
local file deletion, so disconnected connectors still process cleanup.

The connector must fence its running work before applying the page. It removes
the target peer cache; `pending-page` only when `payload.jobId` matches;
`pending-source-update` only when `payload.chatId` or legacy `payload.jobId` matches; `pending-cv` only
when its job ID is listed; and each listed CV job's eight possible chunk files.
An account-wide `pending-native-update` may mix chats, so the server first fences
native account/channel leases; the connector may discard that uncertain page
and only the target channel page. Server native cursors remain authoritative.
Other chat peer metadata, pending history/CV/source pages and chunks survive.
Identity keys and Telegram sessions survive. Missing local files are already
cleaned, not a reason to manufacture an acknowledgement before deletion finishes.

`reimport` is a separate explicit operation permitted only after completion and
with the same connected Telegram account. It resets history to a fresh run and
empty cursor. Old completed source receipts remain non-content replay records;
old message tombstones and candidate context refs are removed in bounded
finalization before fresh import is allowed. Consequently old approved provenance
cannot resolve newly imported text under reused Telegram message IDs, and old
page acknowledgements fail the new run fence. New extraction remains disabled
until separately enabled.

Private functions: `telegram_chat_removal_step_v1(chat)` returns progress/counts;
`telegram_chat_removal_maintenance_v1(limit)` has a 1–5 owner bound and is callable
only through trusted executor-owned maintenance. Staff and worker runtime roles
cannot list global removal scopes or call deletion helpers. The staff API uses
`telegramChatRemovalOperation`; it accepts `preview`, `status`, `request`, and
`reimport` with the validated fields above. The service bridge calls the existing
maintenance entry point after its own service lease validation.

Completion covers the imported-history server records, the original connector's
scoped encrypted cache and its queued private storage objects. It does not mean
that backups or every external system have erased every physical copy. The pilot
runs with AI processing off. When AI processing is enabled, external provider
retention follows that provider's separately configured policy; removal does not
issue a provider-account deletion request. An online extraction worker discards
its separate pending result queue when the server returns the terminal 409 fence.
An offline AI worker may retain its private pending queue until it resumes; that
queue is outside the connector cleanup acknowledgement described here.
