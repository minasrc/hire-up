begin;

set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
begin
    if current_setting('server_version_num')::integer / 10000 <> 17 then
        raise exception 'Foundation requires PostgreSQL 17';
    end if;
    if not (select rolsuper from pg_catalog.pg_roles where rolname = session_user) then
        execute format('grant app_owner to %I with inherit true, set true', session_user);
        execute format('grant app_executor to %I with set true, inherit false', session_user);
    end if;
end
$$;

set local role app_owner;

alter table app.candidates
    add column contact_email text check (contact_email is null or char_length(contact_email) <= 254),
    add column professional_url text check (professional_url is null or char_length(professional_url) <= 2048),
    add column profile_contact_set boolean not null default false,
    add column headline text check (headline is null or char_length(headline) <= 200),
    add column location text check (location is null or char_length(location) <= 200),
    add column availability text not null default 'not_specified'
        check (availability in ('not_specified', 'open')),
    add column tags text[] not null default '{}',
    add column skills text[] not null default '{}',
    add column experience jsonb not null default '[]'::jsonb;

alter table app.applications add column owner_membership_id uuid;
alter table app.applications add constraint applications_owner_membership_fk
    foreign key (organization_id, owner_membership_id)
    references app.organization_memberships (organization_id, id);
create index applications_owner_membership_idx
    on app.applications (organization_id, owner_membership_id);

alter table app.recruitment_operation_receipts
    drop constraint recruitment_operation_receipts_kind_check;
alter table app.recruitment_operation_receipts
    add constraint recruitment_operation_receipts_kind_check check (kind in (
        'client.saved', 'client.draft.saved', 'job.draft.created', 'job.draft.saved',
        'job.revision.started', 'job.duplicated', 'job.published', 'job.listing.changed',
        'candidate.created', 'candidate.updated', 'candidate.tagged',
        'candidate.document.added', 'candidate.application.added', 'candidate.bundle.created'
    ));

do $$
declare
    v_check text;
begin
    select pg_get_expr(conbin, conrelid) into strict v_check
    from pg_catalog.pg_constraint
    where conrelid = 'app.audit_events'::regclass
        and conname = 'audit_events_action_check' and contype = 'c';
    alter table app.audit_events drop constraint audit_events_action_check;
    execute format($check$
        alter table app.audit_events add constraint audit_events_action_check check (
            (%s) or (
                actor_kind = 'staff' and target_type = 'candidate' and target_id is not null
                and action in ('candidate.created', 'candidate.updated', 'candidate.tagged',
                    'candidate.document.added', 'candidate.application.added', 'candidate.bundle.created')
                and details - array['previous_version', 'new_version', 'field_names',
                    'document_id', 'application_id', 'job_id'] = '{}'::jsonb
            )
        )
    $check$, v_check);
end
$$;

grant select on app.candidate_sources to app_executor;
grant update (owner_membership_id, headline, location, availability, tags, skills, experience,
    contact_email, professional_url, profile_contact_set)
    on app.candidates to app_executor;

create policy executor_candidate_management_insert on app.candidates
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write') and lifecycle = 'active');
create policy executor_candidate_management_update on app.candidates
    for update to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write') and lifecycle = 'active')
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write') and lifecycle = 'active');
create policy executor_candidate_sources_select on app.candidate_sources
    for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.read'));
create policy executor_candidate_management_sources_insert on app.candidate_sources
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write'));
create policy executor_candidate_management_identifiers_insert on app.candidate_identifiers
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write'));
create policy executor_candidate_management_applications_insert on app.applications
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('applications.stage')
        and app.has_permission_v1('candidates.write'));
create policy executor_candidate_management_blobs_insert on app.file_blobs
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('documents.write')
        and app.has_permission_v1('candidates.write'));
create policy executor_candidate_upload_locations_select on app.blob_locations
    for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('documents.write')
        and app.has_permission_v1('candidates.read'));
create policy executor_candidate_management_locations_insert on app.blob_locations
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('documents.write')
        and app.has_permission_v1('candidates.write'));
create policy executor_candidate_management_documents_insert on app.documents
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('documents.write')
        and app.has_permission_v1('candidates.write'));
create policy executor_candidate_management_application_documents_insert on app.application_documents
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('applications.stage')
        and app.has_permission_v1('candidates.write'));

grant create on schema app to app_executor;
reset role;
set local role app_executor;

create function app.candidate_contact_v1(p_candidate app.candidates, p_kind text)
returns text
language sql
stable
security invoker
set search_path = pg_catalog, app, pg_temp
as $$
    select case when p_candidate.profile_contact_set then
        case p_kind when 'email' then p_candidate.contact_email
            when 'professional_url' then p_candidate.professional_url end
    else (select i.raw_value from app.candidate_identifiers i
        where i.organization_id = p_candidate.organization_id
            and i.candidate_id = p_candidate.id and i.kind = p_kind
        order by i.received_at desc, i.id desc limit 1) end
$$;

create function app.candidate_fields_valid_v1(p_fields jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_key text;
    v_value jsonb;
    v_entry jsonb;
begin
    if p_fields is null or jsonb_typeof(p_fields) <> 'object'
        or octet_length(p_fields::text) > 65536
        or p_fields - array['fullName', 'headline', 'location', 'email', 'professionalUrl',
            'ownerMembershipId', 'professionalSummary', 'availability', 'tags', 'skills',
            'experience', 'source'] <> '{}'::jsonb then return false; end if;
    if jsonb_typeof(p_fields -> 'fullName') is distinct from 'string'
        or char_length(btrim(p_fields ->> 'fullName')) not between 1 and 120 then
        return false;
    end if;
    foreach v_key in array array['headline', 'location', 'email', 'professionalUrl',
        'ownerMembershipId', 'professionalSummary', 'availability', 'source'] loop
        v_value := p_fields -> v_key;
        if v_value is not null and jsonb_typeof(v_value) not in ('string', 'null') then
            return false;
        end if;
    end loop;
    if char_length(p_fields ->> 'headline') > 200
        or char_length(p_fields ->> 'location') > 200
        or char_length(p_fields ->> 'professionalSummary') > 8000 then return false; end if;
    if nullif(btrim(p_fields ->> 'email'), '') is not null
        and (char_length(p_fields ->> 'email') > 254
            or btrim(p_fields ->> 'email') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
        return false;
    end if;
    if nullif(btrim(p_fields ->> 'professionalUrl'), '') is not null
        and not app.safe_url_valid_v1(btrim(p_fields ->> 'professionalUrl')) then
        return false;
    end if;
    if nullif(p_fields ->> 'ownerMembershipId', '') is not null
        and (p_fields ->> 'ownerMembershipId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return false;
    end if;
    if coalesce(p_fields ->> 'availability', 'not_specified') not in ('not_specified', 'open')
        or coalesce(p_fields ->> 'source', 'manual') not in ('manual', 'referral', 'import') then
        return false;
    end if;
    foreach v_key in array array['tags', 'skills'] loop
        v_value := coalesce(p_fields -> v_key, '[]'::jsonb);
        if jsonb_typeof(v_value) <> 'array' then return false; end if;
        if jsonb_array_length(v_value) > 30 then return false; end if;
        for v_entry in select value from jsonb_array_elements(v_value) loop
            if jsonb_typeof(v_entry) <> 'string'
                or char_length(btrim(v_entry #>> '{}')) not between 1 and 80 then
                return false;
            end if;
        end loop;
    end loop;
    v_value := coalesce(p_fields -> 'experience', '[]'::jsonb);
    if jsonb_typeof(v_value) <> 'array' then return false; end if;
    if jsonb_array_length(v_value) > 20 then return false; end if;
    for v_entry in select value from jsonb_array_elements(v_value) loop
        if jsonb_typeof(v_entry) <> 'object'
            or v_entry - array['role', 'company', 'period', 'description'] <> '{}'::jsonb then
            return false;
        end if;
        foreach v_key in array array['role', 'company', 'period', 'description'] loop
            if jsonb_typeof(v_entry -> v_key) is distinct from 'string'
                or char_length(v_entry ->> v_key) > 2000 then return false; end if;
        end loop;
    end loop;
    return true;
end
$$;

create function app.record_candidate_change_v1(
    p_operation_id uuid, p_correlation_id uuid, p_member uuid, p_kind text,
    p_candidate_id uuid, p_digest bytea, p_result jsonb, p_details jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog, app, pg_temp
as $$
begin
    insert into app.audit_events (
        id, organization_id, actor_kind, actor_user_id, actor_membership_id,
        action, target_type, target_id, correlation_id, occurred_at, details
    ) values (
        p_operation_id, app.context_uuid_v1('app.organization_id'), 'staff',
        app.context_uuid_v1('app.actor_id'), p_member, p_kind, 'candidate',
        p_candidate_id, p_correlation_id, clock_timestamp(),
        jsonb_strip_nulls(coalesce(p_details, '{}'::jsonb))
    );
    insert into app.recruitment_operation_receipts (
        operation_id, organization_id, actor_user_id, actor_membership_id,
        kind, target_id, request_sha256, result
    ) values (
        p_operation_id, app.context_uuid_v1('app.organization_id'),
        app.context_uuid_v1('app.actor_id'), p_member, p_kind,
        p_candidate_id, p_digest, p_result
    );
end
$$;

create function app.save_candidate_profile_v1(
    p_candidate_id uuid, p_expected_version bigint, p_fields jsonb,
    p_operation_id uuid, p_correlation_id uuid
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
    v_candidate app.candidates;
    v_existing app.candidates;
    v_kind text := case when p_expected_version is null then 'candidate.created' else 'candidate.updated' end;
    v_digest bytea;
    v_result jsonb;
    v_owner uuid;
    v_source uuid;
    v_email text := nullif(btrim(p_fields ->> 'email'), '');
    v_url text := nullif(btrim(p_fields ->> 'professionalUrl'), '');
    v_now timestamptz := clock_timestamp();
    v_tags text[];
    v_skills text[];
begin
    v_member := app.recruitment_actor_v1(array['candidates.read', 'candidates.write'],
        p_operation_id, p_correlation_id, true);
    if p_candidate_id is null or (p_expected_version is not null and p_expected_version < 1)
        or not app.candidate_fields_valid_v1(p_fields) then
        raise exception 'Candidate fields are invalid' using errcode = '22023';
    end if;
    v_digest := sha256(convert_to(jsonb_build_object('kind', v_kind,
        'candidateId', case when p_expected_version is not null then p_candidate_id end,
        'expectedVersion', p_expected_version, 'fields', p_fields)::text, 'UTF8'));
    v_result := app.recruitment_receipt_v1(p_operation_id, v_kind, v_digest);
    if v_result is not null then return v_result; end if;
    v_owner := nullif(p_fields ->> 'ownerMembershipId', '')::uuid;
    if v_owner is not null and not exists (
        select 1 from app.organization_memberships m join app.users u on u.id = m.user_id
        where m.organization_id = v_org and m.id = v_owner and m.status = 'active'
            and u.status = 'active'
    ) then raise exception 'Owner is not an active member' using errcode = '22023'; end if;
    if v_email is not null then
        select c.* into v_existing
        from app.candidate_identifiers i join app.candidates c
            on c.organization_id = i.organization_id and c.id = i.candidate_id
        where i.organization_id = v_org and i.kind = 'email'
            and i.normalized_value = lower(v_email)
            and (p_expected_version is null or c.id <> p_candidate_id)
        order by (c.lifecycle <> 'active') desc, i.received_at desc, i.id desc limit 1;
        if found then
            if v_existing.lifecycle <> 'active' then
                raise exception 'Candidate cannot be added' using errcode = '42501';
            end if;
            if p_expected_version is not null then
                raise exception 'Email belongs to another candidate' using errcode = '23505';
            end if;
            return jsonb_build_object('status', 'duplicate', 'candidateId', v_existing.id,
                'version', v_existing.version::text);
        end if;
    end if;
    select coalesce(array_agg(x.tag order by x.tag), '{}'::text[]) into v_tags
    from (select distinct btrim(value) as tag
        from jsonb_array_elements_text(coalesce(p_fields -> 'tags', '[]'::jsonb))) x;
    select coalesce(array_agg(x.skill order by x.skill), '{}'::text[]) into v_skills
    from (select distinct btrim(value) as skill
        from jsonb_array_elements_text(coalesce(p_fields -> 'skills', '[]'::jsonb))) x;
    if p_expected_version is null then
        insert into app.candidates (id, organization_id, full_name, professional_summary,
            owner_membership_id, identity_state, lifecycle, headline, location,
            availability, tags, skills, experience, contact_email, professional_url, profile_contact_set)
        values (p_candidate_id, v_org, btrim(p_fields ->> 'fullName'),
            nullif(btrim(p_fields ->> 'professionalSummary'), ''), v_owner,
            'established', 'active', nullif(btrim(p_fields ->> 'headline'), ''),
            nullif(btrim(p_fields ->> 'location'), ''),
            coalesce(p_fields ->> 'availability', 'not_specified'), v_tags, v_skills,
            coalesce(p_fields -> 'experience', '[]'::jsonb), v_email, v_url, true)
        returning * into v_candidate;
    else
        select c.* into v_candidate from app.candidates c
        where c.organization_id = v_org and c.id = p_candidate_id for update;
        if not found or v_candidate.lifecycle <> 'active' then
            raise exception 'Candidate not found' using errcode = 'P0002';
        end if;
        if v_candidate.version <> p_expected_version then
            raise exception 'Candidate changed; reload before saving' using errcode = '40001';
        end if;
        update app.candidates set full_name = btrim(p_fields ->> 'fullName'),
            contact_email = v_email, professional_url = v_url, profile_contact_set = true,
            professional_summary = nullif(btrim(p_fields ->> 'professionalSummary'), ''),
            headline = nullif(btrim(p_fields ->> 'headline'), ''),
            location = nullif(btrim(p_fields ->> 'location'), ''),
            availability = coalesce(p_fields ->> 'availability', 'not_specified'),
            owner_membership_id = v_owner, tags = v_tags, skills = v_skills,
            experience = coalesce(p_fields -> 'experience', '[]'::jsonb),
            profile_version = profile_version + 1, version = version + 1, updated_at = v_now
        where organization_id = v_org and id = p_candidate_id
        returning * into v_candidate;
    end if;
    v_source := gen_random_uuid();
    insert into app.candidate_sources (id, organization_id, candidate_id, kind,
        received_at, created_by_membership_id, context_summary)
    values (v_source, v_org, p_candidate_id, coalesce(p_fields ->> 'source', 'manual'),
        v_now, v_member, case when p_expected_version is null
            then 'Added by staff' else 'Profile updated by staff' end);
    if v_email is not null then
        insert into app.candidate_identifiers (id, organization_id, candidate_id, kind,
            raw_value, normalized_value, normalization_version, verification, source_id, received_at)
        values (gen_random_uuid(), v_org, p_candidate_id, 'email', v_email, lower(v_email),
            1, 'unverified', v_source, v_now);
    end if;
    if v_url is not null then
        insert into app.candidate_identifiers (id, organization_id, candidate_id, kind,
            raw_value, normalized_value, normalization_version, verification, source_id, received_at)
        values (gen_random_uuid(), v_org, p_candidate_id, 'professional_url', v_url, lower(v_url),
            1, 'unverified', v_source, v_now);
    end if;
    v_result := jsonb_build_object('candidateId', p_candidate_id,
        'version', v_candidate.version::text,
        'status', case when p_expected_version is null then 'created' else 'updated' end);
    perform app.record_candidate_change_v1(p_operation_id, p_correlation_id, v_member,
        v_kind, p_candidate_id, v_digest, v_result,
        jsonb_build_object('previous_version', p_expected_version,
            'new_version', v_candidate.version,
            'field_names', (select jsonb_agg(k order by k) from jsonb_object_keys(p_fields) k)));
    return v_result;
end
$$;

create function app.tag_candidates_v1(
    p_candidates jsonb, p_tag text, p_operation_id uuid, p_correlation_id uuid
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
    v_item jsonb;
    v_candidate app.candidates;
    v_tag text := btrim(p_tag);
    v_digest bytea;
    v_result jsonb;
    v_ids jsonb := '[]'::jsonb;
    v_first uuid;
begin
    v_member := app.recruitment_actor_v1(array['candidates.read', 'candidates.write'],
        p_operation_id, p_correlation_id, true);
    if p_candidates is null or jsonb_typeof(p_candidates) <> 'array'
        or v_tag is null or char_length(v_tag) not between 1 and 80 then
        raise exception 'Invalid tag request' using errcode = '22023';
    end if;
    if jsonb_array_length(p_candidates) not between 1 and 100 then
        raise exception 'Select between 1 and 100 candidates' using errcode = '22023';
    end if;
    v_digest := sha256(convert_to(jsonb_build_object('candidates', p_candidates,
        'tag', v_tag)::text, 'UTF8'));
    v_result := app.recruitment_receipt_v1(p_operation_id, 'candidate.tagged', v_digest);
    if v_result is not null then return v_result; end if;
    for v_item in select value from jsonb_array_elements(p_candidates) loop
        if jsonb_typeof(v_item) <> 'object'
            or v_item - array['candidateId', 'expectedVersion'] <> '{}'::jsonb
            or (v_item ->> 'candidateId') is null
            or (v_item ->> 'expectedVersion') is null then
            raise exception 'Invalid candidate selection' using errcode = '22023';
        end if;
        select c.* into v_candidate from app.candidates c
        where c.organization_id = v_org and c.id = (v_item ->> 'candidateId')::uuid for update;
        if not found or v_candidate.lifecycle <> 'active' then
            raise exception 'Candidate not found' using errcode = 'P0002';
        end if;
        if v_candidate.version <> (v_item ->> 'expectedVersion')::bigint then
            raise exception 'Candidate selection is stale' using errcode = '40001';
        end if;
        if v_first is null then v_first := v_candidate.id; end if;
        if not exists (select 1 from unnest(v_candidate.tags) t(tag)
            where lower(t.tag) = lower(v_tag)) then
            if cardinality(v_candidate.tags) >= 30 then
                raise exception 'Candidate has too many tags' using errcode = '22023';
            end if;
            update app.candidates set tags = array_append(tags, v_tag),
                profile_version = profile_version + 1, version = version + 1,
                updated_at = clock_timestamp()
            where organization_id = v_org and id = v_candidate.id;
        end if;
        if v_candidate.id <> v_first then
            insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
                actor_membership_id, action, target_type, target_id, correlation_id, occurred_at, details)
            values (gen_random_uuid(), v_org, 'staff', app.context_uuid_v1('app.actor_id'),
                v_member, 'candidate.tagged', 'candidate', v_candidate.id, p_correlation_id,
                clock_timestamp(), jsonb_build_object('field_names', jsonb_build_array('tags')));
        end if;
        v_ids := v_ids || jsonb_build_array(v_candidate.id);
    end loop;
    v_result := jsonb_build_object('candidateIds', v_ids, 'status', 'tagged');
    perform app.record_candidate_change_v1(p_operation_id, p_correlation_id, v_member,
        'candidate.tagged', v_first, v_digest, v_result,
        jsonb_build_object('field_names', jsonb_build_array('tags')));
    return v_result;
end
$$;

create function app.add_candidate_to_job_v1(
    p_candidate_id uuid, p_job_id uuid, p_operation_id uuid, p_correlation_id uuid
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
    v_candidate app.candidates;
    v_job app.jobs;
    v_stage uuid;
    v_source uuid := gen_random_uuid();
    v_application uuid;
    v_reference text;
    v_digest bytea;
    v_result jsonb;
    v_now timestamptz := clock_timestamp();
begin
    v_member := app.recruitment_actor_v1(array['candidates.read', 'candidates.write',
        'applications.read', 'applications.stage', 'jobs.read', 'clients.read'],
        p_operation_id, p_correlation_id, true);
    if p_candidate_id is null or p_job_id is null then
        raise exception 'Candidate and job are required' using errcode = '22023';
    end if;
    v_digest := sha256(convert_to(jsonb_build_object('candidateId', p_candidate_id,
        'jobId', p_job_id)::text, 'UTF8'));
    v_result := app.recruitment_receipt_v1(p_operation_id, 'candidate.application.added', v_digest);
    if v_result is not null then return v_result; end if;
    select c.* into v_candidate from app.candidates c
    where c.organization_id = v_org and c.id = p_candidate_id for update;
    if not found or v_candidate.lifecycle <> 'active' then
        raise exception 'Candidate not found' using errcode = 'P0002';
    end if;
    select a.id, a.public_reference into v_application, v_reference
    from app.applications a where a.organization_id = v_org
        and a.candidate_id = p_candidate_id and a.job_id = p_job_id
    order by a.received_at, a.id limit 1;
    if found then
        return jsonb_build_object('status', 'duplicate', 'applicationId', v_application,
            'publicReference', v_reference, 'candidateId', p_candidate_id);
    end if;
    select j.* into v_job from app.jobs j join app.clients c
        on c.organization_id = j.organization_id and c.id = j.client_id
    where j.organization_id = v_org and j.id = p_job_id and c.status = 'active'
        and j.publication_state = 'published' and j.application_state = 'open'
    for update of j;
    if not found then raise exception 'Job is not open' using errcode = 'P0002'; end if;
    select s.id into v_stage from app.pipeline_stages s
    where s.organization_id = v_org and s.pipeline_id = v_job.pipeline_id
        and s.is_initial and s.archived_at is null;
    if v_stage is null then raise exception 'Initial stage is missing' using errcode = '23514'; end if;
    v_application := gen_random_uuid();
    v_reference := 'AG-' || upper(substr(replace(v_application::text, '-', ''), 1, 24));
    insert into app.candidate_sources (id, organization_id, candidate_id, kind,
        received_at, created_by_membership_id, context_summary)
    values (v_source, v_org, p_candidate_id, 'manual', v_now, v_member, 'Added to a job by staff');
    insert into app.applications (id, organization_id, candidate_id, job_id, pipeline_id,
        stage_id, public_reference, reference_version, submitted_name, submitted_email,
        submitted_professional_url, submitted_job_title, source_id, received_at, owner_membership_id)
    values (v_application, v_org, p_candidate_id, p_job_id, v_job.pipeline_id, v_stage,
        v_reference, 2, v_candidate.full_name,
        app.candidate_contact_v1(v_candidate, 'email'),
        app.candidate_contact_v1(v_candidate, 'professional_url'),
        v_job.title, v_source, v_now, v_member);
    insert into app.application_stage_history (id, organization_id, application_id,
        sequence, to_pipeline_id, to_stage_id, actor_membership_id, actor_kind, reason, occurred_at)
    values (gen_random_uuid(), v_org, v_application, 1, v_job.pipeline_id,
        v_stage, v_member, 'staff', 'Added to job by staff', v_now);
    if v_candidate.current_document_id is not null then
        insert into app.application_documents (organization_id, candidate_id, application_id,
            document_id, submitted_filename, attached_at)
        select v_org, p_candidate_id, v_application, d.id, d.original_filename, v_now
        from app.documents d where d.organization_id = v_org
            and d.candidate_id = p_candidate_id and d.id = v_candidate.current_document_id
            and d.lifecycle = 'active';
    end if;
    v_result := jsonb_build_object('status', 'created', 'applicationId', v_application,
        'publicReference', v_reference, 'candidateId', p_candidate_id);
    perform app.record_candidate_change_v1(p_operation_id, p_correlation_id, v_member,
        'candidate.application.added', p_candidate_id, v_digest, v_result,
        jsonb_build_object('application_id', v_application, 'job_id', p_job_id));
    return v_result;
end
$$;

create function app.add_candidate_document_v1(
    p_candidate_id uuid, p_expected_version bigint, p_document jsonb,
    p_operation_id uuid, p_correlation_id uuid
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
    v_candidate app.candidates;
    v_blob app.file_blobs;
    v_document uuid;
    v_digest bytea;
    v_result jsonb;
    v_source uuid := gen_random_uuid();
    v_now timestamptz := clock_timestamp();
    v_size bigint;
    v_hash bytea;
begin
    v_member := app.recruitment_actor_v1(array['candidates.read', 'candidates.write', 'documents.write'],
        p_operation_id, p_correlation_id, true);
    if p_candidate_id is null or p_expected_version is null or p_expected_version < 1
        or p_document is null or jsonb_typeof(p_document) <> 'object'
        or p_document - array['sha256', 'sizeBytes', 'mimeType', 'extension',
            'bucket', 'objectKey', 'filename'] <> '{}'::jsonb
        or not (p_document ?& array['sha256', 'sizeBytes', 'mimeType', 'extension',
            'bucket', 'objectKey', 'filename'])
        or (p_document ->> 'sha256') is null
        or (p_document ->> 'sha256') !~ '^[a-f0-9]{64}$'
        or jsonb_typeof(p_document -> 'sizeBytes') is distinct from 'number'
        or (p_document ->> 'sizeBytes') !~ '^[0-9]+$'
        or (p_document ->> 'bucket') is distinct from 'cv-submissions'
        or nullif(btrim(p_document ->> 'filename'), '') is null
        or char_length(p_document ->> 'filename') > 512
        or not coalesce((p_document ->> 'objectKey') ~ ('^staff/' || v_org::text
            || '/' || p_candidate_id::text || '/[a-f0-9-]{36}\.(pdf|docx)$'), false)
        or not coalesce((p_document ->> 'mimeType' = 'application/pdf'
            and p_document ->> 'extension' = 'pdf')
            or (p_document ->> 'mimeType' = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            and p_document ->> 'extension' = 'docx'), false) then
        raise exception 'Invalid CV metadata' using errcode = '22023';
    end if;
    v_size := (p_document ->> 'sizeBytes')::bigint;
    if v_size not between 1 and 4194304 then
        raise exception 'CV must be at most 4 MB' using errcode = '22023';
    end if;
    v_hash := decode(p_document ->> 'sha256', 'hex');
    v_digest := sha256(convert_to(jsonb_build_object('candidateId', p_candidate_id,
        'expectedVersion', p_expected_version, 'document', p_document - 'objectKey')::text, 'UTF8'));
    v_result := app.recruitment_receipt_v1(p_operation_id, 'candidate.document.added', v_digest);
    if v_result is not null then return v_result; end if;
    select c.* into v_candidate from app.candidates c
    where c.organization_id = v_org and c.id = p_candidate_id for update;
    if not found or v_candidate.lifecycle <> 'active' then
        raise exception 'Candidate not found' using errcode = 'P0002';
    end if;
    if v_candidate.version <> p_expected_version then
        raise exception 'Candidate changed; reload before uploading' using errcode = '40001';
    end if;
    select b.* into v_blob from app.file_blobs b
    where b.organization_id = v_org and b.candidate_id = p_candidate_id
        and b.sha256 = v_hash and b.lifecycle = 'live';
    if found then
        select d.id into v_document from app.documents d
        where d.organization_id = v_org and d.candidate_id = p_candidate_id
            and d.blob_id = v_blob.id and d.lifecycle = 'active'
        order by d.received_at desc, d.id desc limit 1;
        if v_document is null or v_blob.scan_state = 'infected' then
            raise exception 'This file cannot be attached' using errcode = '42501';
        end if;
        return jsonb_build_object('status', 'duplicate', 'candidateId', p_candidate_id,
            'documentId', v_document, 'version', v_candidate.version::text);
    end if;
    v_blob.id := gen_random_uuid();
    v_document := gen_random_uuid();
    insert into app.candidate_sources (id, organization_id, candidate_id, kind,
        received_at, created_by_membership_id, context_summary)
    values (v_source, v_org, p_candidate_id, 'manual', v_now, v_member, 'CV uploaded by staff');
    insert into app.file_blobs (id, organization_id, candidate_id, sha256,
        size_bytes, mime_type, extension, lifecycle, scan_state)
    values (v_blob.id, v_org, p_candidate_id, v_hash, v_size,
        p_document ->> 'mimeType', p_document ->> 'extension', 'live', 'unscanned');
    insert into app.blob_locations (id, organization_id, blob_id, backend_key, bucket,
        object_key, state, is_primary, verified_sha256, verified_size_bytes, verified_at)
    values (gen_random_uuid(), v_org, v_blob.id, 'supabase_storage', 'cv-submissions',
        p_document ->> 'objectKey', 'available', true, v_hash, v_size, v_now);
    insert into app.documents (id, organization_id, candidate_id, blob_id, purpose,
        original_filename, source_id, received_at, supersedes_document_id, lifecycle)
    values (v_document, v_org, p_candidate_id, v_blob.id, 'cv', p_document ->> 'filename',
        v_source, v_now, v_candidate.current_document_id, 'active');
    update app.candidates set current_document_id = v_document,
        version = version + 1, updated_at = v_now
    where organization_id = v_org and id = p_candidate_id;
    v_result := jsonb_build_object('status', 'created', 'candidateId', p_candidate_id,
        'documentId', v_document, 'version', (v_candidate.version + 1)::text);
    perform app.record_candidate_change_v1(p_operation_id, p_correlation_id, v_member,
        'candidate.document.added', p_candidate_id, v_digest, v_result,
        jsonb_build_object('previous_version', v_candidate.version,
            'new_version', v_candidate.version + 1, 'document_id', v_document));
    return v_result;
end
$$;

create function app.create_staff_candidate_v1(
    p_candidate_id uuid, p_fields jsonb, p_document jsonb, p_job_id uuid, p_note text,
    p_operation_id uuid, p_correlation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_member uuid;
    v_digest bytea;
    v_result jsonb;
    v_document jsonb;
    v_application jsonb;
begin
    v_member := app.recruitment_actor_v1(array['candidates.read', 'candidates.write'],
        p_operation_id, p_correlation_id, true);
    if p_document is not null and not app.has_permission_v1('documents.write') then
        raise exception 'Document upload is not permitted' using errcode = '42501';
    end if;
    if p_job_id is not null and not (app.has_permission_v1('applications.read')
        and app.has_permission_v1('applications.stage') and app.has_permission_v1('jobs.read')
        and app.has_permission_v1('clients.read')) then
        raise exception 'Adding applications is not permitted' using errcode = '42501';
    end if;
    if nullif(btrim(p_note), '') is not null and not app.has_permission_v1('collaboration.write') then
        raise exception 'Adding notes is not permitted' using errcode = '42501';
    end if;
    if not app.candidate_fields_valid_v1(p_fields) or octet_length(p_note) > 16384 then
        raise exception 'Candidate fields are invalid' using errcode = '22023';
    end if;
    v_digest := sha256(convert_to(jsonb_build_object('fields', p_fields,
        'document', p_document - 'objectKey', 'jobId', p_job_id, 'note', nullif(btrim(p_note), ''))::text, 'UTF8'));
    v_result := app.recruitment_receipt_v1(p_operation_id, 'candidate.bundle.created', v_digest);
    if v_result is not null then return v_result; end if;
    v_result := app.save_candidate_profile_v1(p_candidate_id, null, p_fields,
        gen_random_uuid(), p_correlation_id);
    if v_result ->> 'status' = 'duplicate' then return v_result; end if;
    if p_document is not null then
        v_document := app.add_candidate_document_v1(p_candidate_id, 1, p_document,
            gen_random_uuid(), p_correlation_id);
    end if;
    if p_job_id is not null then
        v_application := app.add_candidate_to_job_v1(p_candidate_id, p_job_id,
            gen_random_uuid(), p_correlation_id);
    end if;
    if nullif(btrim(p_note), '') is not null then
        perform app.add_candidate_note_v1(gen_random_uuid(), p_candidate_id, btrim(p_note),
            gen_random_uuid(), p_correlation_id);
    end if;
    v_result := v_result || jsonb_build_object('documentId', v_document -> 'documentId',
        'applicationId', v_application -> 'applicationId',
        'version', coalesce(v_document ->> 'version', v_result ->> 'version'));
    perform app.record_candidate_change_v1(p_operation_id, p_correlation_id, v_member,
        'candidate.bundle.created', p_candidate_id, v_digest, v_result,
        jsonb_build_object('document_id', v_document -> 'documentId',
            'application_id', v_application -> 'applicationId', 'job_id', p_job_id));
    return v_result;
end
$$;

create function app.staff_upload_referenced_v1(p_object_key text)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
    perform app.recruitment_actor_v1(array['candidates.read', 'documents.write'], null, null, false);
    if p_object_key is null or p_object_key not like
        ('staff/' || app.context_uuid_v1('app.organization_id')::text || '/%') then
        raise exception 'Invalid upload key' using errcode = '22023';
    end if;
    return exists (select 1 from app.blob_locations l
        where l.organization_id = app.context_uuid_v1('app.organization_id')
            and l.bucket = 'cv-submissions' and l.object_key = p_object_key);
end
$$;

revoke all on function app.create_staff_candidate_v1(uuid, jsonb, jsonb, uuid, text, uuid, uuid) from public;
grant execute on function app.create_staff_candidate_v1(uuid, jsonb, jsonb, uuid, text, uuid, uuid) to app_staff;
revoke all on function app.staff_upload_referenced_v1(text) from public;
grant execute on function app.staff_upload_referenced_v1(text) to app_staff;

revoke all on function app.candidate_contact_v1(app.candidates, text) from public;
revoke all on function app.candidate_fields_valid_v1(jsonb) from public;
revoke all on function app.record_candidate_change_v1(uuid, uuid, uuid, text, uuid, bytea, jsonb, jsonb) from public;
revoke all on function app.save_candidate_profile_v1(uuid, bigint, jsonb, uuid, uuid) from public;
revoke all on function app.tag_candidates_v1(jsonb, text, uuid, uuid) from public;
revoke all on function app.add_candidate_to_job_v1(uuid, uuid, uuid, uuid) from public;
revoke all on function app.add_candidate_document_v1(uuid, bigint, jsonb, uuid, uuid) from public;
grant execute on function app.save_candidate_profile_v1(uuid, bigint, jsonb, uuid, uuid) to app_staff;
grant execute on function app.tag_candidates_v1(jsonb, text, uuid, uuid) to app_staff;
grant execute on function app.add_candidate_to_job_v1(uuid, uuid, uuid, uuid) to app_staff;
grant execute on function app.add_candidate_document_v1(uuid, bigint, jsonb, uuid, uuid) to app_staff;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
