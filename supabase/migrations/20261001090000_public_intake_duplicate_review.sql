begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
begin
    if current_setting('server_version_num')::integer / 10000 <> 17 then
        raise exception 'Foundation requires PostgreSQL 17';
    end if;
    if not (select rolsuper from pg_catalog.pg_roles where rolname = session_user) then
        execute format('grant app_executor to %I with set true, inherit false', session_user);
    end if;
end
$$;

set local role app_owner;
grant create on schema app to app_executor;

alter table app.applications
    add column intake_request_id uuid,
    add column intake_digest bytea;
create unique index applications_intake_request_idx
    on app.applications (organization_id, intake_request_id)
    where intake_request_id is not null;
grant insert (intake_request_id, intake_digest)
    on app.applications to app_executor;

create table app.candidate_duplicate_reviews (
    id uuid primary key default pg_catalog.gen_random_uuid(),
    organization_id uuid not null references app.organizations (id),
    candidate_a_id uuid not null,
    candidate_b_id uuid not null,
    status text not null default 'pending'
        check (status in ('pending', 'same_person', 'different_people')),
    evidence jsonb not null default '{}'::jsonb,
    decision_evidence jsonb,
    reviewer_membership_id uuid,
    reviewed_at timestamptz,
    version bigint not null default 1 check (version > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id, id),
    unique (organization_id, candidate_a_id, candidate_b_id),
    foreign key (organization_id, candidate_a_id)
        references app.candidates (organization_id, id),
    foreign key (organization_id, candidate_b_id)
        references app.candidates (organization_id, id),
    foreign key (organization_id, reviewer_membership_id)
        references app.organization_memberships (organization_id, id),
    check (candidate_a_id < candidate_b_id),
    check (
        (status = 'pending' and reviewer_membership_id is null
            and reviewed_at is null and decision_evidence is null)
        or (status <> 'pending' and reviewer_membership_id is not null
            and reviewed_at is not null and decision_evidence is not null)
    )
);

create index candidate_duplicate_reviews_queue_idx
    on app.candidate_duplicate_reviews
    (organization_id, status, updated_at desc, id);

create table app.candidate_duplicate_review_events (
    id uuid primary key default pg_catalog.gen_random_uuid(),
    organization_id uuid not null,
    review_id uuid not null,
    reviewer_membership_id uuid not null,
    previous_status text not null
        check (previous_status in ('pending', 'same_person', 'different_people')),
    decision text not null
        check (decision in ('same_person', 'different_people', 'reopen')),
    evidence jsonb not null,
    occurred_at timestamptz not null default now(),
    foreign key (organization_id, review_id)
        references app.candidate_duplicate_reviews (organization_id, id),
    foreign key (organization_id, reviewer_membership_id)
        references app.organization_memberships (organization_id, id)
);
create index candidate_duplicate_review_events_review_idx
    on app.candidate_duplicate_review_events
    (organization_id, review_id, occurred_at, id);

alter table app.candidate_duplicate_reviews enable row level security;
alter table app.candidate_duplicate_reviews force row level security;
alter table app.candidate_duplicate_review_events enable row level security;
alter table app.candidate_duplicate_review_events force row level security;
grant select, insert on app.candidate_duplicate_reviews to app_executor;
grant update (status, evidence, decision_evidence, reviewer_membership_id,
    reviewed_at, version, updated_at)
    on app.candidate_duplicate_reviews to app_executor;
grant select, insert on app.candidate_duplicate_review_events to app_executor;

create policy executor_duplicate_reviews_select
    on app.candidate_duplicate_reviews for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('duplicates.review')
        and app.has_permission_v1('candidates.read'));
create policy executor_duplicate_reviews_insert
    on app.candidate_duplicate_reviews for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('duplicates.review')
        and app.has_permission_v1('candidates.read'));
create policy executor_duplicate_reviews_update
    on app.candidate_duplicate_reviews for update to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('duplicates.review')
        and app.has_permission_v1('candidates.read'))
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('duplicates.review')
        and app.has_permission_v1('candidates.read'));
create policy executor_duplicate_review_events_select
    on app.candidate_duplicate_review_events for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('duplicates.review')
        and app.has_permission_v1('candidates.read'));
create policy executor_duplicate_review_events_insert
    on app.candidate_duplicate_review_events for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('duplicates.review')
        and app.has_permission_v1('candidates.read'));

reset role;
set local role app_executor;

create or replace function app.submit_public_application_core_v1(
    p_candidate_id uuid,
    p_source_id uuid,
    p_email_identifier_id uuid,
    p_url_identifier_id uuid,
    p_application_id uuid,
    p_history_id uuid,
    p_audit_id uuid,
    p_correlation_id uuid,
    p_blob_id uuid,
    p_location_id uuid,
    p_document_id uuid,
    p_job_slug text,
    p_public_reference text,
    p_full_name text,
    p_email text,
    p_professional_url text,
    p_achievement text,
    p_blob_sha256 bytea,
    p_blob_size_bytes bigint,
    p_mime_type text,
    p_extension text,
    p_bucket text,
    p_object_key text,
    p_filename text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_job app.jobs;
    v_stage app.pipeline_stages;
    v_candidate_id uuid;
    v_existing app.applications;
    v_email_norm text;
    v_daily integer;
    v_digest bytea;
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    if v_org is null
        or app.context_uuid_v1('app.actor_id') is not null then
        raise exception 'Public intake context is required'
            using errcode = '42501';
    end if;
    if p_candidate_id is null or p_source_id is null
        or p_email_identifier_id is null or p_application_id is null
        or p_history_id is null or p_audit_id is null
        or p_correlation_id is null then
        raise exception 'submit_public_application_v1 requires nonnull identifiers'
            using errcode = '22023';
    end if;
    if p_job_slug is null or btrim(p_job_slug) = ''
        or length(p_job_slug) > 200 then
        raise exception 'Invalid job slug' using errcode = '22023';
    end if;
    if p_public_reference is null
        or p_public_reference !~ '^AG-[0-9A-F]{12}$' then
        raise exception 'Invalid public reference' using errcode = '22023';
    end if;
    if p_full_name is null or btrim(p_full_name) = ''
        or octet_length(p_full_name) > 512 then
        raise exception 'Invalid applicant name' using errcode = '22023';
    end if;
    if p_email is null or btrim(p_email) = '' or octet_length(p_email) > 640
        or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        raise exception 'Invalid applicant email' using errcode = '22023';
    end if;
    if p_professional_url is not null
        and (octet_length(p_professional_url) > 4096
            or p_professional_url !~ '^https?://') then
        raise exception 'Invalid professional URL' using errcode = '22023';
    end if;
    if p_achievement is not null and octet_length(p_achievement) > 8000 then
        raise exception 'Invalid achievement text' using errcode = '22023';
    end if;
    if (p_blob_id is null) <> (p_location_id is null and p_document_id is null
        and p_blob_sha256 is null and p_blob_size_bytes is null
        and p_mime_type is null and p_extension is null
        and p_bucket is null and p_object_key is null and p_filename is null) then
        raise exception 'Document metadata must be complete or absent'
            using errcode = '22023';
    end if;
    if p_blob_id is not null then
        if p_blob_size_bytes < 1 or p_blob_size_bytes > 4194304
            or pg_catalog.octet_length(p_blob_sha256) <> 32 then
            raise exception 'Invalid blob metadata' using errcode = '22023';
        end if;
        if not (
            (p_mime_type = 'application/pdf' and p_extension = 'pdf')
            or (p_mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                and p_extension = 'docx')
        ) then
            raise exception 'Invalid document type' using errcode = '22023';
        end if;
    end if;

    v_digest := pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
            btrim(p_job_slug), btrim(p_full_name), lower(btrim(p_email)),
            nullif(btrim(coalesce(p_professional_url, '')), ''),
            nullif(btrim(coalesce(p_achievement, '')), ''),
            case when p_blob_sha256 is null then null
                else pg_catalog.encode(p_blob_sha256, 'hex') end,
            p_blob_size_bytes, p_mime_type, p_extension
        )::text, 'UTF8'));

    -- A committed retry is recognized even if the job has since closed.
    select a.* into v_existing
    from app.applications a
    where a.organization_id = v_org and a.intake_request_id = p_correlation_id;
    if found then
        if v_existing.intake_digest is distinct from v_digest then
            raise exception 'Submission ID was reused with different content'
                using errcode = '23505';
        end if;
        return pg_catalog.jsonb_build_object(
            'accepted', true,
            'duplicate', true,
            'applicationId', v_existing.id,
            'publicReference', v_existing.public_reference
        );
    end if;

    select j.* into v_job
    from app.jobs j
    where j.organization_id = v_org and j.slug = btrim(p_job_slug);
    if not found
        or v_job.publication_state <> 'published'
        or not v_job.publicly_listed
        or v_job.application_state <> 'open' then
        raise exception 'Job is not accepting applications'
            using errcode = 'P0002';
    end if;

    if exists (
        select 1 from app.applications a
        where a.organization_id = v_org and a.public_reference = p_public_reference
    ) then
        raise exception 'Public reference collision' using errcode = '23505';
    end if;

    v_email_norm := lower(btrim(p_email));

    -- Per-address daily cap across the organization, so an IP-rotating
    -- submitter cannot flood one mailbox's pipeline entries either.
    select count(*) into v_daily
    from app.applications a
    where a.organization_id = v_org
        and lower(coalesce(a.submitted_email, '')) = v_email_norm
        and a.received_at > v_now - interval '24 hours';
    if v_daily >= 10 then
        raise exception 'Too many submissions for this address'
            using errcode = '54000';
    end if;

    -- An anonymous email is only a match signal, never proof of identity.
    v_candidate_id := p_candidate_id;
    insert into app.candidates (
        id, organization_id, full_name, identity_state, lifecycle
    ) values (
        p_candidate_id, v_org, btrim(p_full_name), 'provisional', 'active'
    );

    insert into app.candidate_sources (
        id, organization_id, candidate_id, kind, received_at, context_summary
    ) values (
        p_source_id, v_org, v_candidate_id, 'public_application', v_now,
        'Applied via the public jobs board'
    );

    insert into app.candidate_identifiers (
        id, organization_id, candidate_id, kind, raw_value, normalized_value,
        normalization_version, verification, source_id, received_at
    ) values (
        p_email_identifier_id, v_org, v_candidate_id, 'email',
        btrim(p_email), v_email_norm, 1, 'unverified', p_source_id, v_now
    );

    if p_professional_url is not null and btrim(p_professional_url) <> '' then
        insert into app.candidate_identifiers (
            id, organization_id, candidate_id, kind, raw_value, normalized_value,
            normalization_version, verification, source_id, received_at
        ) values (
            p_url_identifier_id, v_org, v_candidate_id, 'professional_url',
            btrim(p_professional_url), lower(btrim(p_professional_url)), 1,
            'unverified', p_source_id, v_now
        );
    end if;

    select s.* into v_stage
    from app.pipeline_stages s
    where s.organization_id = v_org
        and s.pipeline_id = v_job.pipeline_id
        and s.is_initial
        and s.archived_at is null;
    if not found then
        raise exception 'Job pipeline has no initial stage'
            using errcode = 'P0002';
    end if;

    insert into app.applications (
        id, organization_id, candidate_id, job_id, pipeline_id, stage_id,
        public_reference, reference_version, submitted_name, submitted_email,
        submitted_professional_url, submitted_achievement, submitted_job_title,
        source_id, received_at, intake_request_id, intake_digest
    ) values (
        p_application_id, v_org, v_candidate_id, v_job.id, v_job.pipeline_id,
        v_stage.id, p_public_reference, 1, btrim(p_full_name), btrim(p_email),
        nullif(btrim(coalesce(p_professional_url, '')), ''),
        nullif(btrim(coalesce(p_achievement, '')), ''),
        v_job.title, p_source_id, v_now, p_correlation_id, v_digest
    );

    insert into app.application_stage_history (
        id, organization_id, application_id, sequence,
        from_pipeline_id, from_stage_id, to_pipeline_id, to_stage_id,
        actor_membership_id, actor_kind, reason, occurred_at
    ) values (
        p_history_id, v_org, p_application_id, 1, null, null,
        v_job.pipeline_id, v_stage.id, null, 'intake',
        'Application received', v_now
    );

    if p_blob_id is not null then
        insert into app.file_blobs (
            id, organization_id, candidate_id, sha256, size_bytes,
            mime_type, extension, lifecycle, scan_state
        ) values (
            p_blob_id, v_org, v_candidate_id, p_blob_sha256,
            p_blob_size_bytes, p_mime_type, p_extension, 'live', 'unscanned'
        );
        insert into app.blob_locations (
            id, organization_id, blob_id, backend_key, bucket, object_key,
            state, is_primary, verified_sha256, verified_size_bytes, verified_at
        ) values (
            p_location_id, v_org, p_blob_id, 'supabase_storage', p_bucket,
            p_object_key, 'available', true, p_blob_sha256, p_blob_size_bytes,
            v_now
        );
        insert into app.documents (
            id, organization_id, candidate_id, blob_id, purpose,
            original_filename, source_id, received_at, lifecycle
        ) values (
            p_document_id, v_org, v_candidate_id, p_blob_id, 'cv',
            left(p_filename, 512), p_source_id, v_now, 'active'
        );
        update app.candidates set
            current_document_id = p_document_id,
            updated_at = v_now,
            version = version + 1
        where organization_id = v_org and id = v_candidate_id;
        insert into app.application_documents (
            organization_id, candidate_id, application_id, document_id,
            submitted_filename, attached_at
        ) values (
            v_org, v_candidate_id, p_application_id, p_document_id,
            left(p_filename, 512), v_now
        );
    end if;

    insert into app.audit_events (
        id, organization_id, actor_kind, actor_user_id, actor_membership_id,
        action, target_type, target_id, correlation_id, occurred_at, details
    ) values (
        p_audit_id, v_org, 'intake', null, null, 'application.received',
        'application', p_application_id, p_correlation_id, v_now,
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'candidate_id', v_candidate_id,
            'job_id', v_job.id,
            'public_reference', p_public_reference,
            'document_id', p_document_id
        ))
    );

    return pg_catalog.jsonb_build_object(
        'accepted', true,
        'duplicate', false,
        'applicationId', p_application_id,
        'candidateId', v_candidate_id,
        'publicReference', p_public_reference,
        'reusedCandidate', false,
        'documentId', p_document_id
    );
end
$$;

create or replace function app.get_candidate_profile_options_v1()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
begin
    v_member := app.recruitment_actor_v1(array['candidates.read'], null, null, false);
    return jsonb_build_object('currentMembershipId', v_member,
        'canWrite', app.has_permission_v1('candidates.write'),
        'canReviewDuplicates', app.has_permission_v1('duplicates.review'),
        'owners', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id,
            'name', u.display_name) order by u.display_name, m.id), '[]'::jsonb)
            from app.organization_memberships m join app.users u on u.id = m.user_id
            where m.organization_id = v_org and m.status = 'active' and u.status = 'active'));
end
$$;

create function app.list_candidate_duplicate_reviews_v1(
    p_status text default 'pending', p_limit integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_result jsonb;
begin
    perform app.recruitment_actor_v1(
        array['candidates.read', 'duplicates.review'], null, null, false);
    if p_status is null
        or p_status not in ('pending', 'same_person', 'different_people', 'all')
        or p_limit is null or p_limit < 1 or p_limit > 200 then
        raise exception 'Invalid duplicate review filter' using errcode = '22023';
    end if;

    -- An indexed exact-match scan also discovers existing records on first use.
    with matches as (
        select i.candidate_id as candidate_a_id,
            j.candidate_id as candidate_b_id,
            'email'::text as kind,
            pg_catalog.encode(pg_catalog.sha256(
                pg_catalog.convert_to(i.normalized_value, 'UTF8')), 'hex') as value
        from app.candidate_identifiers i
        join app.candidate_identifiers j
            on j.organization_id = i.organization_id
            and j.kind = 'email'
            and j.normalized_value = i.normalized_value
            and i.candidate_id < j.candidate_id
        join app.candidates a on a.organization_id = i.organization_id
            and a.id = i.candidate_id and a.lifecycle = 'active'
        join app.candidates b on b.organization_id = j.organization_id
            and b.id = j.candidate_id and b.lifecycle = 'active'
        where i.organization_id = v_org and i.kind = 'email'
            and i.normalized_value is not null
            and i.normalized_value <> ''
        union all
        select a.candidate_id, b.candidate_id,
            'cv'::text, pg_catalog.encode(a.sha256, 'hex')
        from app.file_blobs a
        join app.file_blobs b
            on b.organization_id = a.organization_id
            and b.sha256 = a.sha256 and a.candidate_id < b.candidate_id
            and b.lifecycle = 'live'
        join app.candidates ca on ca.organization_id = a.organization_id
            and ca.id = a.candidate_id and ca.lifecycle = 'active'
        join app.candidates cb on cb.organization_id = b.organization_id
            and cb.id = b.candidate_id and cb.lifecycle = 'active'
        where a.organization_id = v_org and a.lifecycle = 'live'
    ), grouped as (
        select candidate_a_id, candidate_b_id,
            pg_catalog.jsonb_build_object(
                'emails', coalesce(pg_catalog.jsonb_agg(distinct value)
                    filter (where kind = 'email'), '[]'::jsonb),
                'cvHashes', coalesce(pg_catalog.jsonb_agg(distinct value)
                    filter (where kind = 'cv'), '[]'::jsonb)
            ) as evidence
        from matches group by candidate_a_id, candidate_b_id
    )
    insert into app.candidate_duplicate_reviews
        (organization_id, candidate_a_id, candidate_b_id, evidence)
    select v_org, candidate_a_id, candidate_b_id, evidence from grouped
    on conflict (organization_id, candidate_a_id, candidate_b_id)
    do update set evidence = excluded.evidence,
        updated_at = pg_catalog.clock_timestamp(),
        version = app.candidate_duplicate_reviews.version + 1
    where app.candidate_duplicate_reviews.evidence is distinct from excluded.evidence;

    select pg_catalog.jsonb_build_object('reviews', coalesce(
        pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', r.id, 'candidateAId', r.candidate_a_id,
            'candidateBId', r.candidate_b_id,
            'candidateAName', a.full_name,
            'candidateBName', b.full_name,
            'candidateAEmail', app.candidate_contact_v1(a, 'email'),
            'candidateBEmail', app.candidate_contact_v1(b, 'email'),
            'status', r.status, 'evidence', r.evidence,
            'newEvidence', r.decision_evidence is not null
                and r.decision_evidence is distinct from r.evidence,
            'version', r.version, 'reviewedAt', r.reviewed_at
        ) order by r.updated_at desc, r.id), '[]'::jsonb))
    into v_result
    from (
        select d.* from app.candidate_duplicate_reviews d
        join app.candidates a on a.organization_id = d.organization_id
            and a.id = d.candidate_a_id and a.lifecycle = 'active'
        join app.candidates b on b.organization_id = d.organization_id
            and b.id = d.candidate_b_id and b.lifecycle = 'active'
        where d.organization_id = v_org
            and (p_status = 'all' or d.status = p_status)
        order by d.updated_at desc, d.id
        limit p_limit
    ) r
    join app.candidates a on a.organization_id = r.organization_id
        and a.id = r.candidate_a_id
    join app.candidates b on b.organization_id = r.organization_id
        and b.id = r.candidate_b_id;
    return v_result;
end
$$;

create function app.get_candidate_duplicate_comparison_v1(p_review_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_pair app.candidate_duplicate_reviews;
begin
    perform app.recruitment_actor_v1(
        array['candidates.read', 'duplicates.review'], null, null, false);
    select d.* into v_pair
    from app.candidate_duplicate_reviews d
    join app.candidates a on a.organization_id = d.organization_id
        and a.id = d.candidate_a_id and a.lifecycle = 'active'
    join app.candidates b on b.organization_id = d.organization_id
        and b.id = d.candidate_b_id and b.lifecycle = 'active'
    where d.organization_id = v_org and d.id = p_review_id;
    if not found then
        raise exception 'Duplicate review not found' using errcode = 'P0002';
    end if;

    return pg_catalog.jsonb_build_object(
        'candidateA', app.get_candidate_profile_v1(v_pair.candidate_a_id),
        'candidateB', app.get_candidate_profile_v1(v_pair.candidate_b_id),
        'matchedEmails', (
            select coalesce(pg_catalog.jsonb_agg(distinct a.raw_value), '[]'::jsonb)
            from app.candidate_identifiers a
            join app.candidate_identifiers b
                on b.organization_id = a.organization_id
                and b.candidate_id = v_pair.candidate_b_id
                and b.kind = 'email' and b.normalized_value = a.normalized_value
            where a.organization_id = v_org and a.candidate_id = v_pair.candidate_a_id
                and a.kind = 'email' and a.normalized_value is not null
                and a.normalized_value <> ''
        ),
        'matchedDocuments', (
            select coalesce(pg_catalog.jsonb_agg(distinct pg_catalog.jsonb_build_object(
                'candidateADocumentId', da.id,
                'candidateAFilename', da.original_filename,
                'candidateBDocumentId', db.id,
                'candidateBFilename', db.original_filename
            )), '[]'::jsonb)
            from app.documents da
            join app.file_blobs ba on ba.organization_id = da.organization_id
                and ba.candidate_id = da.candidate_id and ba.id = da.blob_id
            join app.file_blobs bb on bb.organization_id = ba.organization_id
                and bb.candidate_id = v_pair.candidate_b_id
                and bb.sha256 = ba.sha256 and bb.lifecycle = 'live'
            join app.documents db on db.organization_id = bb.organization_id
                and db.candidate_id = bb.candidate_id and db.blob_id = bb.id
            where da.organization_id = v_org
                and da.candidate_id = v_pair.candidate_a_id
                and da.lifecycle = 'active' and db.lifecycle = 'active'
                and ba.lifecycle = 'live'
                and pg_catalog.encode(ba.sha256, 'hex') in (
                    select value from pg_catalog.jsonb_array_elements_text(
                        v_pair.evidence -> 'cvHashes') as value)
        )
    );
end
$$;

create function app.review_candidate_duplicate_v1(
    p_review_id uuid, p_expected_version bigint, p_decision text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
    v_pair app.candidate_duplicate_reviews;
begin
    v_member := app.recruitment_actor_v1(
        array['candidates.read', 'duplicates.review'], null, null, false);
    if p_review_id is null or p_expected_version is null
        or p_expected_version < 1
        or p_decision is null
        or p_decision not in ('same_person', 'different_people', 'reopen') then
        raise exception 'Invalid duplicate review decision' using errcode = '22023';
    end if;
    select * into v_pair from app.candidate_duplicate_reviews
    where organization_id = v_org and id = p_review_id for update;
    if not found then
        raise exception 'Duplicate suggestion not found' using errcode = 'P0002';
    end if;
    if v_pair.version <> p_expected_version then
        raise exception 'Duplicate suggestion changed' using errcode = '40001';
    end if;
    if not exists (
        select 1 from app.candidates a
        join app.candidates b on b.organization_id = a.organization_id
        where a.organization_id = v_org
            and a.id = v_pair.candidate_a_id and a.lifecycle = 'active'
            and b.id = v_pair.candidate_b_id and b.lifecycle = 'active'
    ) then
        raise exception 'Candidate is unavailable for review' using errcode = '42501';
    end if;
    if p_decision = 'reopen' then
        if v_pair.status = 'pending'
            or v_pair.evidence is not distinct from v_pair.decision_evidence then
            raise exception 'New match evidence is required to reopen'
                using errcode = '22023';
        end if;
        update app.candidate_duplicate_reviews set
            status = 'pending', reviewer_membership_id = null,
            reviewed_at = null, decision_evidence = null,
            version = version + 1, updated_at = pg_catalog.clock_timestamp()
        where id = p_review_id;
    else
        if v_pair.status <> 'pending' then
            raise exception 'Duplicate suggestion was already reviewed'
                using errcode = '40001';
        end if;
        update app.candidate_duplicate_reviews set
            status = p_decision, reviewer_membership_id = v_member,
            reviewed_at = pg_catalog.clock_timestamp(),
            decision_evidence = v_pair.evidence,
            version = version + 1, updated_at = pg_catalog.clock_timestamp()
        where id = p_review_id;
    end if;
    insert into app.candidate_duplicate_review_events (
        organization_id, review_id, reviewer_membership_id,
        previous_status, decision, evidence
    ) values (
        v_org, p_review_id, v_member, v_pair.status, p_decision, v_pair.evidence
    );
    return pg_catalog.jsonb_build_object('status', p_decision,
        'reviewId', p_review_id, 'version', p_expected_version + 1);
end
$$;

revoke all on function app.list_candidate_duplicate_reviews_v1(text, integer)
    from public;
revoke all on function app.get_candidate_duplicate_comparison_v1(uuid)
    from public;
revoke all on function app.review_candidate_duplicate_v1(uuid, bigint, text)
    from public;
grant execute on function app.list_candidate_duplicate_reviews_v1(text, integer)
    to app_staff;
grant execute on function app.get_candidate_duplicate_comparison_v1(uuid)
    to app_staff;
grant execute on function app.review_candidate_duplicate_v1(uuid, bigint, text)
    to app_staff;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
