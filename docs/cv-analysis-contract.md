# CV analysis and reviewed draft, version 1

This checkpoint adds an explicit attachment-to-candidate workflow and analyzes validated PDF/DOCX CV bytes. It does not change semantic search, add OCR, guess that every Telegram document is a candidate CV, or infer the candidate's identity from its sender. Parsed text and suggestions stay private until the recruiter approves the candidate. A separately reviewed text artifact is retained on approval for a later permission-aware search checkpoint; it is not indexed here.

Migration owner: backend, `20261002200000_cv_analysis.sql`. Existing `TELEGRAM_INTAKE_ENABLED`, staff MFA, organization selection and same-origin mutation rules apply. No production setup, pairing UI or new consent gate is part of this checkpoint.

## Attachment bootstrap

Existing GET `/api/staff/telegram-cv` additionally accepts `extractionJobId=UUID` instead of `draftId`, with optional `after=messageId:attachmentIndex`. Both together are invalid. Result:

`{extractionJobId,sourceVersion,sourceAvailable,connectionIssue,attachments,nextAfter}`

At most50 attachments, ordered by numeric message ID then index. Each is `{messageId,attachmentIndex,filename,mimeType,sizeBytes,documentId,eligible,reason,existingDraftIds}`. Existing draft IDs are scoped private links, at most12. Reasons use existing CV eligibility codes plus `ALREADY_LINKED`; purged/missing batch source gives `sourceAvailable:false`, empty attachments. Eligibility requires a completed batch with retained immutable source, a concrete PDF/DOCX document within the existing4MiB bound and the same connected Telegram account. Source data may include an attachment without any extracted subject or facts. The UI labels the action **Create candidate draft from this CV** and presents an explicit file choice.

POST existing `/api/staff/telegram-cv` adds:

`{action:"createDraft",extractionJobId,messageId,attachmentIndex,expectedSourceVersion,operationId}`

Response `{draftId,cvJobId,analysisId,candidateId,replayed}`; nullable fields are `analysisId` and `candidateId`. The transaction creates an empty, private, unapproved draft, associates the exact source attachment, and queues existing CV retrieval. It records intent to analyze that exact successful retrieval. Names/email remain missing until extracted or supplied. Required fields, normal candidate duplicate review and existing manual upload remain authoritative.

The attachment identity `(owner,batch,message,index)` has a durable bootstrap receipt; retries reuse its draft and do not create duplicates. The operation ID also binds the complete request; changed reuse returns409. Replay can return a closed draft/candidate and does not create another profile. An attachment already linked by text extraction is `ALREADY_LINKED`: open its existing draft(s), never choose or merge between them automatically. File reuse is not person identity. No sender username/ID is inserted into this empty profile.

The bootstrap acquires the existing owner quota lock, batch row, then draft/attachment locks. It checks sourceVersion and unpurged source before adding a consumer. Purge cannot race a new draft. Existing CV account/generation/permission/lease/replacement guards apply unchanged. A completed matching retrieval queues analysis only if that exact file remains the draft's current document. If manual upload wins, the retrieval is cancelled; analyzing the manually supplied file requires an explicit Analyze CV action.

## Staff analysis API and review

GET `/api/staff/cv-analysis?draftId=UUID[&after=analysisUUID]` requires `candidates.read`, `candidates.write`, `documents.download`. It returns:

`{draftId,documentRevision,canAnalyze,analysisReviewRequired,current,jobs,nextAfter,proposals,nextProposalAfter}`

`current` is null or the analysis for the current document revision. `jobs` is the current analysis first, then most recent older analyses, at most20. `nextAfter` pages only older jobs by `(createdAt,id)` using the returned UUID; it does not repeat current. Pending CV proposals are returned separately, at most50, ordered by proposal UUID; optional `proposalAfter=UUID` is an exclusive cursor. `nextProposalAfter` is null or the last displayed UUID when more remain. All job rows use AnalysisSummary:

`{id,draftId,documentRevision,documentSha256,filename,stage,status,errorCode,attempts,availableAt,version,textDecision,blockCount,textByteLength,pendingProposalCount,issues,canRetry}`

Stage `parse|facts`; status `queued|leased|waiting|failed|completed|cancelled`; textDecision `pending|include|exclude`. Before parsing, text length/count are0. `issues` is the bounded model issue list below. No storage path or credential appears.

GET `/api/staff/cv-analysis?analysisId=UUID[&blockAfter=ordinal]` returns `{analysis,blocks,nextBlockAfter,textAvailable}`. At most50 blocks per page, exclusive ordinal cursor; blocks are the exact immutable Block objects below. Analysis ID and draft ID are mutually exclusive. `textAvailable:false` explicitly identifies cleaned private text. This is an authorized text/evidence view, never HTML rendering.

POST `/api/staff/cv-analysis` requires the same permissions; document writes require `documents.write` only when existing CV actions/approval already require it:

* `{action:"analyze",draftId,expectedDocumentRevision,operationId}` → `{analysis:AnalysisSummary}`. Only open drafts with validated current CVs. Same document revision reuses its current analysis; no invisible rerun. A fresh manual CV/replacement has a new revision.
* `{action:"cancel",analysisId,expectedAnalysisVersion}` → `{analysis}`. Queued/leased/waiting/failed analysis only. Cancels future work and excludes its unreviewed text. It never removes the CV or edits profile fields.
* `{action:"retry",analysisId,expectedAnalysisVersion}` → `{analysis}`. Failed/cancelled work only, same current open draft/document. Resets attempt budget and resumes parse or facts from an existing immutable parsed artifact. A reused artifact resets textDecision to pending. A committed facts-stage receipt is never reopened or applied twice; cancelled/failed pre-completion work has no committed effects. Does not repeat committed field effects.
* `{action:"resolve",analysisId,proposalId,expectedDraftVersion,decision:"apply"|"dismiss"}` → `{draft}`. Versioned common field-normalization rules; closed drafts permit dismiss only.
* `{action:"reviewText",analysisId,expectedAnalysisVersion,decision:"include"|"exclude"}` → `{analysis}`. Requires completed analysis with retained text and the same current document. Include means the recruiter reviewed the full extracted text and wants it retained with the approved candidate; Exclude means only individually reviewed profile fields will survive. Decisions can change before candidate approval. UI must not say this enables search yet.

Draft DTOs add `analysisReviewRequired:boolean` and `pendingCvProposalCount:integer`; existing `pendingProposalCount` becomes the total Telegram+CV unresolved count. Required-fields/readiness/list/approval use the same aggregate. An active/failed current analysis, pending text decision, or unresolved CV proposal blocks approval with `cvAnalysis`/`proposals` guidance. Cancel/skip resolves an unfinished analysis; completed analysis requires Include/Exclude plus resolving its proposals. Draft field edits continue during parsing and are not invalidated by job completion.

## Suggestions and identity

Use sibling CV proposal rows and a separate CV review panel; never fabricate Telegram messages or change the existing Telegram proposal API. The CV status response exposes at most50 pending proposals `{id,analysisId,draftId,field,currentValue,suggestedValue,evidence,documentSha256,createdAt}` with the proposal cursor above. Resolve uses the CV action, preserving expectedDraftVersion and normal field validation. UI displays current versus suggested value and document page/paragraph quotes, protects dirty fields, and permits dismissal for closed drafts. The draft readiness/approval aggregate includes both proposal types. Existing Telegram suggestion rendering stays unchanged.

CV model output is `{facts,issues}`. Facts max12, unique field, use the existing normalized fields: firstName,lastName,primaryEmail,secondaryEmails,headline,location,professionalUrl,professionalSummary,compensationPreference. Each fact is `{field,value,evidence}`; evidence1–3 BlockEvidence objects. Empty facts are legal and leave a visibly incomplete draft. Issues are unique values from `NOT_A_CV|MULTIPLE_PEOPLE|NO_CANDIDATE_INFORMATION`, max3; nonempty issues require empty facts. A filename, quoted reference, previous employer or sender is not automatically the subject.

`BlockEvidence={blockOrdinal,startByte,endByte,quote}` uses zero-based half-open UTF8 byte offsets in that exact block. Quote nonempty, at most2000 characters/8000 UTF8 bytes; boundaries must be valid UTF8 and quote must equal the selected bytes. Names and email values need literal support in their evidence, with the existing normalized email rules. Host validates complete output before any writes. Literal quote validation is provenance, not proof that an inference is true.

Untouched empty draft fields may be filled; existing values and human-edited/cleared fields become reviewable proposals. Human locks are computed from actual changed values. Late completion rechecks current fields under the draft lock. No name/username merge, model-supplied target, arbitrary Telegram identity or automatic canonical update is allowed. Candidate duplicate checks remain part of approval. Optional fields may remain empty; first name, last name, primary email and validated CV stay required.

## Worker protocol

Existing scoped Mac worker bearer tokens and `app_telegram_worker` context are reused, no Origin accepted. Every phase checks current owner membership, candidates.read/write and documents.download. The job refers to a stored validated CV, so Telegram connectivity is not required after retrieval. No database credential, service storage credential, storage path, signed general-purpose URL or model-supplied owner/draft ID is passed.

POST `/api/cv-analysis/worker/claim` `{}` returns `{job:null}` or `{job:{id,leaseToken,leaseExpiresAt,stage,sourceDigest,source}}`. A lease is120seconds, at most5 attempts per stage. Claim oldest available private job; one bounded stage per tick, allowing existing higher-priority connection/query work between ticks. Source:

`{draftId,documentRevision,documentSha256,sizeBytes,filename,extension,parserVersion,promptVersion,blocks}`

`blocks` is null for parse and the complete immutable parsed block array for facts. Extension `pdf|docx`. Constants: parserVersion `pdfjs-5.7.284-docx-xml-0.8.15-v1`, promptVersion `cv-facts-prompt-v1`, schemaVersion `cv-facts-v1`. SourceDigest is the server SHA256 of the immutable stage source. Source contains no storage locator. The claim response is bounded to1MiB. Workers reject unsupported versions.

POST `/api/cv-analysis/worker/content` JSON `{jobId,leaseToken,sourceDigest}` returns raw application/octet-stream bytes for the active parse stage, at most4194304 bytes. Host authenticates and resolves the private object before storage I/O, fetches with a10second abort deadline outside a transaction, verifies actual byte count and SHA256 against the job, then rechecks current lease/document/owner permissions before returning. Response is private/no-store and never redirects. Mac repeats hash/size validation before parsing. Stale job, replaced/closed draft or expired lease returns409; revoked permission403. No plaintext bytes in logs.

POST `/api/cv-analysis/worker/complete`:

* Parse `{jobId,leaseToken,sourceDigest,stage:"parse",result:{parserVersion,documentSha256,textSha256,blocks}}`.
* Facts `{jobId,leaseToken,sourceDigest,stage:"facts",result:{facts,issues},metadata:{model,promptVersion,reportedModel}}`.

Parse receipt `{ok:true,analysisId,stage:"parse",nextStage:"facts"}`. Facts receipt `{ok:true,analysisId,stage:"facts",draftId,draftVersion,proposalCount}`. First receipt commits immutable parsed text and queues facts with a fresh sourceDigest. Second applies validated field effects atomically and marks completed, textDecision pending. Both stages retain immutable completion digest/receipt separately. Matching committed stage replay is checked before expired lease/current stage rejection, including after private source cleanup; still requires current owner authorization. Different committed payload returns409. Never rerun provider or reapply fields on uncertain ACK. A stale uncommitted completion409 can be discarded/reclaimed;5xx retains exact encrypted pending request.

POST `/api/cv-analysis/worker/fail` `{jobId,leaseToken,sourceDigest,stage,code,retryAfterSeconds}` → `{ok:true}`. Delay1–3600 seconds. Retryable `STORAGE_UNAVAILABLE|PROVIDER_UNAVAILABLE|WORKER_ERROR`; visible terminal `INVALID_DOCUMENT|ENCRYPTED_DOCUMENT|OCR_REQUIRED|DOCUMENT_LIMIT|TEXT_LIMIT|INVALID_RESULT|UNSUPPORTED_VERSION`. Five failed attempts become visible `ATTEMPTS_EXHAUSTED`, never an unclaimable waiting row. Lease failure receipts are idempotent after lost ACK. Provider errors/empty transport never become successful empty facts. HTTP401/403 stops the worker;400/413/422 becomes bounded INVALID_RESULT failure;409 drops stale local work;5xx retains pending work. Errors and logs use fixed codes, never document/provider bodies.

## Parser boundaries and document evidence

Block is one of `{ordinal,kind:"pdf_page",page,text,sha256}` or `{ordinal,kind:"docx_paragraph",part,paragraph,text,sha256}`. Ordinals are contiguous from0; SHA256 is lower-case SHA256 of exact UTF8 block text. PDF page1–50 is contiguous, one block per page including genuine blank pages. DOCX `part` is exactly `word/document.xml`, `word/headerN.xml`, `word/footerN.xml` (N1–100), `word/footnotes.xml` or `word/endnotes.xml`; paragraph is positive and contiguous within each part, max2000 total blocks. Traverse document body first (including table paragraphs), referenced header/footer parts in lexical path order, then footnotes and endnotes. Preserve genuine empty paragraphs. Ignore separator notes, deleted tracked text and archive parts unrelated to visible document content. Parser never follows external relationships or executes embedded content. Direct bounded XML parsing is required: Mammoth raw-text extraction omits header/footer content and cannot provide these stable paragraph locators.

File max4MiB; total extracted text max65536 UTF8 bytes; parse body max1MiB; facts completion max131072 bytes. All text is well-formed UTF8, NUL-free, LF newlines. The canonical full text is block texts joined with two LF characters; its complete byte count must also fit65536. The server verifies each block SHA256 and computes/verifies textSha256 from that exact representation, not the model's summary. No truncation accepted: over-limit documents fail explicitly. Individual text blocks may be empty; all-whitespace output is OCR_REQUIRED for PDF and INVALID_DOCUMENT for DOCX. Images are not OCRed and UI explains extracted text may miss image content; review the original CV.

The parser runs locally in an isolated container with enforced memory, CPU, wall-clock and output limits; no network, read-only input, bounded temporary space and no host credentials. Initial target limits:512MiB memory,1CPU,45second wall limit,32MiB temporary/archive expansion,256 ZIP entries and no path traversal/symlink entries. Reject encryption and malformed archives/documents rather than running office macros, external commands or URLs. Pinned parser image/dependency versions are recorded separately from parserVersion and must be tested with real PDF/DOCX fixtures. Generic PDF signature validation is not a malware scan or a full parsing guarantee.

## Approval, replacement and source cleanup

Analysis jobs/proposals/blocks are owner-private with forced RLS. Current documentRevision and SHA256 fence every new read/commit. Revocation of documents.download fences in-flight content/results and canonical artifact reads; existing profile search remains unchanged. Ordinary field edits do not cancel parsing. A document replacement or draft closure cancels unfinished jobs and prevents late field changes. Pending old-document proposals are cancelled rather than applied to a replacement CV; already applied profile values remain for recruiter review. No stale parse result overwrites a manual CV.

Before candidate approval, pending analysis/text review/proposals must be resolved. Approval with Include copies the exact reviewed full text, document hash, parser version and block coordinates into a canonical document-specific reviewed-text artifact in the same transaction as candidate creation. Exclude copies no raw text; reviewed structured fields remain. Canonical artifact is accessible only with candidate access AND documents.download, bound to the approved document ID, and never exposed by current profile search. Document replacement/restriction/merge must preserve document-specific binding; future search will explicitly handle lifecycle/version invalidation. No parse output updates an already approved candidate.

Retention consumer checks add bootstrap receipts, active analysis jobs, pending CV proposals and unresolved text decisions. Batch release still requires explicit full-source review. Shared source data remains until every draft/consumer resolves. On closed draft + resolved analysis, private parsed blocks/proposal quotes can be cleared by bounded hosted maintenance; Include preserves the canonical reviewed artifact, Exclude/discard preserves no raw parse text. Minimal source/file hashes and stage receipts survive for retry idempotence. A bootstrap cannot bind a purged source, and cleanup cannot race a new analysis/source consumer. Cleanup keeps the existing quota→batch→sorted draft→consumer lock ordering with bounded NOWAIT deferral.

## Implementation seams and tests

Backend exports planned `cvAnalysisStatus(pool,identity,org,filters)`, `cvAnalysisAction(pool,identity,org,input)`, `cvAnalysisWorkerOperation(pool,token,action,input)`, and `readCvAnalysisContent(pool,token,input,storage)` (returns verified Uint8Array). Pure contracts/schema live in `src/lib/cv-analysis-contracts.js`; no DB/auth imports. Bootstrap extends existing telegram-cv contracts/operations/routes. Worker owns a separate CV analysis service and isolated parser. UI owns batch attachment creation, analysis progress/retry/skip, block viewer, typed suggestion evidence, text Include/Exclude, and dirty-edit preservation. Root owns release/CI and real-parser end-to-end fixtures. No semantic-search changes in this checkpoint.

Acceptance: attachment-only batch→explicit draft→retrieval→real PDF and DOCX parsing→quote-backed facts→human edit/conflict→text decision→approval; exact canonical CV hash/text; wrong document, image-only/encrypted/bomb/oversize visible errors; manual replacement, approval, permission revocation and cleanup races; lost parse/facts ACK with encrypted restart; source purge after all consumers without deleting canonical reviewed text; no document text leakage to another owner or a user without document permission. Existing pairing/admin provisioning remains sufficient for the demo.
