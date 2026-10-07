begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
begin
    if current_setting('server_version_num')::integer / 10000 <> 17 then
        raise exception 'Candidate merge requires PostgreSQL 17';
    end if;
    if not (select rolsuper from pg_catalog.pg_roles where rolname = session_user) then
        execute format('grant app_executor to %I with set true, inherit false', session_user);
    end if;
end
$$;

set local role app_owner;
grant create on schema app to app_executor;

create table app.candidate_merge_events (
    id uuid primary key default pg_catalog.gen_random_uuid(),
    organization_id uuid not null references app.organizations (id),
    review_id uuid not null,
    source_candidate_id uuid not null,
    target_candidate_id uuid not null,
    actor_membership_id uuid not null,
    source_version bigint not null,
    target_version bigint not null,
    primary_email_identifier_id uuid,
    retired_blob_ids jsonb not null default '[]'::jsonb,
    occurred_at timestamptz not null default now(),
    unique (organization_id, review_id),
    unique (organization_id, source_candidate_id),
    foreign key (organization_id, review_id)
        references app.candidate_duplicate_reviews (organization_id, id),
    foreign key (organization_id, source_candidate_id)
        references app.candidates (organization_id, id),
    foreign key (organization_id, target_candidate_id)
        references app.candidates (organization_id, id),
    foreign key (organization_id, actor_membership_id)
        references app.organization_memberships (organization_id, id),
    check (source_candidate_id <> target_candidate_id)
);
create index candidate_merge_events_target_idx
    on app.candidate_merge_events (organization_id, target_candidate_id, occurred_at desc);
alter table app.candidate_merge_events enable row level security;
alter table app.candidate_merge_events force row level security;
grant select, insert on app.candidate_merge_events to app_executor;

create policy executor_candidate_merge_events_select on app.candidate_merge_events
    for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.merge'));
create policy executor_candidate_merge_events_insert on app.candidate_merge_events
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.merge'));

-- Runtime roles never receive these grants. Only the checked, staff-only
-- security-definer operation below can exercise the executor policies.
grant select on app.candidate_sources, app.application_documents,
    app.privacy_complaints to app_executor;
grant update (full_name, professional_summary, owner_membership_id,
    identity_state, lifecycle, merged_into_id, current_document_id,
    contact_email, professional_url, profile_contact_set, headline, location,
    profile_version, updated_at, version)
    on app.candidates to app_executor;
grant update (candidate_id) on app.candidate_sources, app.candidate_identifiers,
    app.application_documents to app_executor;
grant update (candidate_id, updated_at, version) on app.applications,
    app.candidate_notes to app_executor;
grant update (candidate_id, lifecycle, updated_at, version)
    on app.file_blobs to app_executor;
grant update (blob_id, is_primary, updated_at, version)
    on app.blob_locations to app_executor;
grant update (candidate_id, blob_id, updated_at, version)
    on app.documents to app_executor;

do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'candidates', 'candidate_sources', 'candidate_identifiers',
        'applications', 'candidate_notes', 'file_blobs', 'blob_locations',
        'documents', 'application_documents'
    ] loop
        execute format($policy$
            create policy executor_merge_%1$s_select on app.%1$I
            for select to app_executor
            using (organization_id = app.context_uuid_v1('app.organization_id')
                and app.has_permission_v1('candidates.merge'))
        $policy$, v_table);
        execute format($policy$
            create policy executor_merge_%1$s_update on app.%1$I
            for update to app_executor
            using (organization_id = app.context_uuid_v1('app.organization_id')
                and app.has_permission_v1('candidates.merge'))
            with check (organization_id = app.context_uuid_v1('app.organization_id')
                and app.has_permission_v1('candidates.merge'))
        $policy$, v_table);
    end loop;
    foreach v_table in array array[
        'candidate_processing_purposes', 'privacy_requests',
        'privacy_request_subjects', 'privacy_events', 'privacy_complaints',
        'document_disclosures', 'legacy_records'
    ] loop
        execute format($policy$
            create policy executor_merge_%1$s_select on app.%1$I
            for select to app_executor
            using (organization_id = app.context_uuid_v1('app.organization_id')
                and app.has_permission_v1('candidates.merge'))
        $policy$, v_table);
    end loop;
end
$$;

reset role;
set local role app_executor;

create function app.merge_candidates_v1(
    p_review_id uuid,
    p_expected_review_version bigint,
    p_target_candidate_id uuid,
    p_expected_target_version bigint,
    p_expected_source_version bigint,
    p_primary_email text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_actor uuid;
    v_review app.candidate_duplicate_reviews;
    v_target app.candidates;
    v_source app.candidates;
    v_existing app.candidate_merge_events;
    v_source_id uuid;
    v_email text;
    v_email_id uuid;
    v_blob app.file_blobs;
    v_canonical app.file_blobs;
    v_source_primary uuid;
    v_target_primary uuid;
    v_retired jsonb := '[]'::jsonb;
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    v_actor := app.recruitment_actor_v1(
        array['candidates.read', 'duplicates.review', 'candidates.merge'],
        null, null, false);
    if p_review_id is null or p_target_candidate_id is null
        or p_expected_review_version is null or p_expected_review_version < 1
        or p_expected_target_version is null or p_expected_target_version < 1
        or p_expected_source_version is null or p_expected_source_version < 1
        or (p_primary_email is not null and
            (char_length(p_primary_email) > 254 or btrim(p_primary_email) = '')) then
        raise exception 'Invalid merge request' using errcode = '22023';
    end if;

    select * into v_existing from app.candidate_merge_events
    where organization_id = v_org and review_id = p_review_id;
    if found then
        if v_existing.target_candidate_id <> p_target_candidate_id
            or v_existing.target_version <> p_expected_target_version
            or v_existing.source_version <> p_expected_source_version
            or (v_existing.primary_email_identifier_id is null) <> (p_primary_email is null) then
            raise exception 'Review was merged with different choices'
                using errcode = '40001';
        end if;
        return pg_catalog.jsonb_build_object('targetCandidateId', p_target_candidate_id,
            'sourceCandidateId', v_existing.source_candidate_id, 'replayed', true);
    end if;

    select * into v_review from app.candidate_duplicate_reviews
    where organization_id = v_org and id = p_review_id for update;
    if not found then
        raise exception 'Duplicate review not found' using errcode = 'P0002';
    end if;
    if v_review.version <> p_expected_review_version
        or v_review.status = 'different_people' then
        raise exception 'Duplicate review changed' using errcode = '40001';
    end if;
    if p_target_candidate_id not in (v_review.candidate_a_id, v_review.candidate_b_id) then
        raise exception 'Primary candidate is not in the review'
            using errcode = '22023';
    end if;
    v_source_id := case when p_target_candidate_id = v_review.candidate_a_id
        then v_review.candidate_b_id else v_review.candidate_a_id end;

    -- Lock both records in a stable order. Profile updates, document writes,
    -- restrictions and concurrent merges must observe these locks.
    perform 1 from app.candidates
    where organization_id = v_org
        and id in (p_target_candidate_id, v_source_id)
    order by id for update;
    select * into v_target from app.candidates
    where organization_id = v_org and id = p_target_candidate_id;
    select * into v_source from app.candidates
    where organization_id = v_org and id = v_source_id;
    if v_target.lifecycle <> 'active' or v_source.lifecycle <> 'active' then
        raise exception 'Only active candidates can be merged'
            using errcode = '42501';
    end if;
    if v_target.version <> p_expected_target_version
        or v_source.version <> p_expected_source_version then
        raise exception 'Candidate changed; review both profiles again'
            using errcode = '40001';
    end if;

    -- Privacy cases and retained disclosure history need a separate reviewed
    -- resolution. Nothing is moved if either candidate has such records.
    if exists (select 1 from app.candidate_processing_purposes
        where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.privacy_requests
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.privacy_request_subjects
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.privacy_events
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.privacy_complaints
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.document_disclosures
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.legacy_records
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id)) then
        raise exception 'Privacy-linked records require manual merge review'
            using errcode = '23514';
    end if;
    if exists (select 1 from app.file_blobs b
        where b.organization_id = v_org and b.candidate_id = v_source_id
            and (b.lifecycle <> 'live' or b.retired_into_id is not null))
        or exists (select 1 from app.file_blobs b
            join app.file_blobs r on r.organization_id = b.organization_id
                and r.candidate_id = b.candidate_id and r.retired_into_id = b.id
            where b.organization_id = v_org and b.candidate_id = v_source_id) then
        raise exception 'Archived file history requires manual merge review'
            using errcode = '23514';
    end if;

    if p_primary_email is not null then
        select i.id, i.raw_value into v_email_id, v_email from app.candidate_identifiers i
        where i.organization_id = v_org
            and i.candidate_id in (v_source_id, p_target_candidate_id)
            and i.kind = 'email'
            and lower(btrim(i.raw_value)) = lower(btrim(p_primary_email))
        order by (i.candidate_id = p_target_candidate_id) desc,
            i.received_at desc, i.id desc limit 1;
        if v_email is null then
            raise exception 'Primary email must belong to one of the candidates'
                using errcode = '22023';
        end if;
    elsif exists (select 1 from app.candidate_identifiers i
        where i.organization_id = v_org
            and i.candidate_id in (v_source_id, p_target_candidate_id)
            and i.kind = 'email') then
        raise exception 'Choose a primary email' using errcode = '22023';
    end if;

    -- Composite ownership references are checked at commit, after every
    -- dependent row has been reparented. The live-hash uniqueness is immediate.
    set constraints applications_source_fk, candidate_identifiers_source_fk,
        documents_blob_fk, documents_source_fk, documents_supersedes_fk,
        application_documents_application_fk, application_documents_document_fk,
        candidates_current_document_fk, file_blobs_candidate_fk,
        file_blobs_retired_into_fk deferred;

    update app.candidates set current_document_id = null,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and id = v_source_id;

    for v_blob in select * from app.file_blobs
        where organization_id = v_org and candidate_id = v_source_id
        order by id for update loop
        select * into v_canonical from app.file_blobs
        where organization_id = v_org and candidate_id = p_target_candidate_id
            and sha256 = v_blob.sha256 and lifecycle = 'live'
        for update;
        if found then
            if v_canonical.size_bytes <> v_blob.size_bytes
                or v_canonical.mime_type <> v_blob.mime_type
                or v_canonical.extension <> v_blob.extension then
                raise exception 'Identical hashes have conflicting file metadata'
                    using errcode = '23514';
            end if;
            if v_blob.scan_state = 'infected'
                or v_canonical.scan_state = 'infected' then
                raise exception 'An infected file needs manual merge review'
                    using errcode = '23514';
            end if;
            select l.id into v_source_primary from app.blob_locations l
            where l.organization_id = v_org and l.blob_id = v_blob.id
                and l.is_primary and l.state = 'available';
            select l.id into v_target_primary from app.blob_locations l
            where l.organization_id = v_org and l.blob_id = v_canonical.id
                and l.is_primary and l.state = 'available';
            update app.documents set blob_id = v_canonical.id,
                updated_at = v_now, version = version + 1
            where organization_id = v_org and candidate_id = v_source_id
                and blob_id = v_blob.id;
            if v_target_primary is null and v_source_primary is not null then
                update app.blob_locations set is_primary = false,
                    updated_at = v_now, version = version + 1
                where organization_id = v_org and blob_id = v_canonical.id
                    and is_primary;
            end if;
            update app.blob_locations set blob_id = v_canonical.id,
                is_primary = v_target_primary is null and id = v_source_primary,
                updated_at = v_now, version = version + 1
            where organization_id = v_org and blob_id = v_blob.id;
            update app.file_blobs set lifecycle = 'retired',
                updated_at = v_now, version = version + 1
            where organization_id = v_org and id = v_blob.id;
            v_retired := v_retired || pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object('retiredBlobId', v_blob.id,
                    'canonicalBlobId', v_canonical.id));
        else
            update app.file_blobs set candidate_id = p_target_candidate_id,
                updated_at = v_now, version = version + 1
            where organization_id = v_org and id = v_blob.id;
        end if;
    end loop;

    update app.candidate_sources set candidate_id = p_target_candidate_id
    where organization_id = v_org and candidate_id = v_source_id;
    update app.candidate_identifiers set candidate_id = p_target_candidate_id
    where organization_id = v_org and candidate_id = v_source_id;
    update app.applications set candidate_id = p_target_candidate_id,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and candidate_id = v_source_id;
    update app.documents set candidate_id = p_target_candidate_id,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and candidate_id = v_source_id;
    update app.application_documents set candidate_id = p_target_candidate_id
    where organization_id = v_org and candidate_id = v_source_id;
    update app.candidate_notes set candidate_id = p_target_candidate_id,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and candidate_id = v_source_id;

    update app.candidates set
        full_name = coalesce(nullif(btrim(v_target.full_name), ''), v_source.full_name),
        professional_summary = coalesce(v_target.professional_summary,
            v_source.professional_summary),
        headline = coalesce(v_target.headline, v_source.headline),
        location = coalesce(v_target.location, v_source.location),
        owner_membership_id = coalesce(v_target.owner_membership_id,
            v_source.owner_membership_id),
        identity_state = case when v_target.identity_state = 'established'
            or v_source.identity_state = 'established' then 'established'
            else 'provisional' end,
        contact_email = v_email,
        professional_url = coalesce(
            app.candidate_contact_v1(v_target, 'professional_url'),
            app.candidate_contact_v1(v_source, 'professional_url')),
        profile_contact_set = true,
        current_document_id = coalesce(v_target.current_document_id,
            v_source.current_document_id),
        profile_version = profile_version + 1,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and id = p_target_candidate_id;
    update app.candidates set lifecycle = 'merged',
        merged_into_id = p_target_candidate_id,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and id = v_source_id;

    update app.candidate_duplicate_reviews set
        status = 'same_person', reviewer_membership_id = v_actor,
        reviewed_at = v_now, decision_evidence = v_review.evidence,
        version = version + 1, updated_at = v_now
    where organization_id = v_org and id = p_review_id;
    insert into app.candidate_duplicate_review_events (
        organization_id, review_id, reviewer_membership_id,
        previous_status, decision, evidence
    ) values (v_org, p_review_id, v_actor, v_review.status,
        'same_person', v_review.evidence);
    insert into app.candidate_merge_events (
        organization_id, review_id, source_candidate_id, target_candidate_id,
        actor_membership_id, source_version, target_version,
        primary_email_identifier_id,
        retired_blob_ids
    ) values (v_org, p_review_id, v_source_id, p_target_candidate_id,
        v_actor, p_expected_source_version, p_expected_target_version,
        v_email_id, v_retired);

    set constraints applications_source_fk, candidate_identifiers_source_fk,
        documents_blob_fk, documents_source_fk, documents_supersedes_fk,
        application_documents_application_fk, application_documents_document_fk,
        candidates_current_document_fk, file_blobs_candidate_fk,
        file_blobs_retired_into_fk immediate;
    return pg_catalog.jsonb_build_object('targetCandidateId', p_target_candidate_id,
        'sourceCandidateId', v_source_id, 'replayed', false);
end
$$;

revoke all on function app.merge_candidates_v1(uuid, bigint, uuid, bigint, bigint, text)
    from public;
grant execute on function app.merge_candidates_v1(uuid, bigint, uuid, bigint, bigint, text)
    to app_staff;

create function app.resolve_candidate_redirect_v1(p_candidate_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_target uuid;
begin
    perform app.recruitment_actor_v1(array['candidates.read'], null, null, false);
    with recursive chain as (
        select c.id, c.merged_into_id, c.lifecycle, array[c.id] as seen
        from app.candidates c
        where c.organization_id = v_org and c.id = p_candidate_id
        union all
        select c.id, c.merged_into_id, c.lifecycle, chain.seen || c.id
        from chain join app.candidates c on c.organization_id = v_org
            and c.id = chain.merged_into_id
        where chain.lifecycle = 'merged' and not c.id = any(chain.seen)
            and array_length(chain.seen, 1) < 16
    )
    select id into v_target from chain
    where lifecycle = 'active' and id <> p_candidate_id
    order by array_length(seen, 1) desc limit 1;
    return v_target;
end
$$;
revoke all on function app.resolve_candidate_redirect_v1(uuid) from public;
grant execute on function app.resolve_candidate_redirect_v1(uuid) to app_staff;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
