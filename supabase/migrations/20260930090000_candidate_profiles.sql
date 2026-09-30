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
    add column location text check (location is null or char_length(location) <= 200);

alter table app.recruitment_operation_receipts
    drop constraint recruitment_operation_receipts_kind_check;
alter table app.recruitment_operation_receipts
    add constraint recruitment_operation_receipts_kind_check check (kind in (
        'client.saved', 'client.draft.saved', 'job.draft.created', 'job.draft.saved',
        'job.revision.started', 'job.duplicated', 'job.published', 'job.listing.changed',
        'candidate.created', 'candidate.updated'
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
                and action in ('candidate.created', 'candidate.updated')
                and details - array['previous_version', 'new_version', 'field_names'] = '{}'::jsonb
            )
        )
    $check$, v_check);
end
$$;

grant update (owner_membership_id, headline, location, contact_email, professional_url, profile_contact_set)
    on app.candidates to app_executor;
create policy executor_candidate_profiles_insert on app.candidates
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write') and lifecycle = 'active');
create policy executor_candidate_profiles_update on app.candidates
    for update to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write') and lifecycle = 'active')
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write') and lifecycle = 'active');
create policy executor_candidate_profile_sources_insert on app.candidate_sources
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('candidates.write'));
create policy executor_candidate_profile_identifiers_insert on app.candidate_identifiers
    for insert to app_executor
    with check (organization_id = app.context_uuid_v1('app.organization_id')
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
    v_email text;
    v_url text;
    v_key text;
    v_now timestamptz := clock_timestamp();
begin
    v_member := app.recruitment_actor_v1(array['candidates.read', 'candidates.write'],
        p_operation_id, p_correlation_id, true);
    if p_candidate_id is null or (p_expected_version is not null and p_expected_version < 1)
        or p_fields is null or jsonb_typeof(p_fields) <> 'object'
        or octet_length(p_fields::text) > 49152
        or p_fields - array['fullName', 'headline', 'location', 'email', 'professionalUrl',
            'ownerMembershipId', 'professionalSummary'] <> '{}'::jsonb
        or jsonb_typeof(p_fields -> 'fullName') is distinct from 'string'
        or char_length(btrim(p_fields ->> 'fullName')) not between 1 and 120 then
        raise exception 'Candidate fields are invalid' using errcode = '22023';
    end if;
    foreach v_key in array array['headline', 'location', 'email', 'professionalUrl',
        'ownerMembershipId', 'professionalSummary'] loop
        if p_fields -> v_key is not null
            and jsonb_typeof(p_fields -> v_key) not in ('string', 'null') then
            raise exception 'Candidate fields must be text or null' using errcode = '22023';
        end if;
    end loop;
    v_email := nullif(btrim(p_fields ->> 'email'), '');
    v_url := nullif(btrim(p_fields ->> 'professionalUrl'), '');
    if char_length(p_fields ->> 'headline') > 200
        or char_length(p_fields ->> 'location') > 200
        or char_length(p_fields ->> 'professionalSummary') > 8000
        or (v_email is not null and (char_length(v_email) > 254
            or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
        or (v_url is not null and (char_length(v_url) > 2048 or not app.safe_url_valid_v1(v_url)))
        or (nullif(p_fields ->> 'ownerMembershipId', '') is not null
            and (p_fields ->> 'ownerMembershipId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
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
    if p_expected_version is null then
        insert into app.candidates (id, organization_id, full_name, professional_summary,
            owner_membership_id, identity_state, lifecycle, headline, location,
            contact_email, professional_url, profile_contact_set)
        values (p_candidate_id, v_org, btrim(p_fields ->> 'fullName'),
            nullif(btrim(p_fields ->> 'professionalSummary'), ''), v_owner,
            'established', 'active', nullif(btrim(p_fields ->> 'headline'), ''),
            nullif(btrim(p_fields ->> 'location'), ''), v_email, v_url, true)
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
            location = nullif(btrim(p_fields ->> 'location'), ''), owner_membership_id = v_owner,
            profile_version = profile_version + 1, version = version + 1, updated_at = v_now
        where organization_id = v_org and id = p_candidate_id
        returning * into v_candidate;
    end if;
    v_source := gen_random_uuid();
    insert into app.candidate_sources (id, organization_id, candidate_id, kind,
        received_at, created_by_membership_id, context_summary)
    values (v_source, v_org, p_candidate_id, 'manual', v_now, v_member,
        case when p_expected_version is null then 'Added by staff' else 'Profile updated by staff' end);
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
    insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
        actor_membership_id, action, target_type, target_id, correlation_id, occurred_at, details)
    values (p_operation_id, v_org, 'staff', app.context_uuid_v1('app.actor_id'), v_member,
        v_kind, 'candidate', p_candidate_id, p_correlation_id, v_now,
        jsonb_strip_nulls(jsonb_build_object('previous_version', p_expected_version,
            'new_version', v_candidate.version,
            'field_names', (select jsonb_agg(k order by k) from jsonb_object_keys(p_fields) k))));
    insert into app.recruitment_operation_receipts (operation_id, organization_id,
        actor_user_id, actor_membership_id, kind, target_id, request_sha256, result)
    values (p_operation_id, v_org, app.context_uuid_v1('app.actor_id'), v_member,
        v_kind, p_candidate_id, v_digest, v_result);
    return v_result;
end
$$;

create function app.get_candidate_profile_options_v1()
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
        'owners', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id,
            'name', u.display_name) order by u.display_name, m.id), '[]'::jsonb)
            from app.organization_memberships m join app.users u on u.id = m.user_id
            where m.organization_id = v_org and m.status = 'active' and u.status = 'active'));
end
$$;

create function app.get_candidate_profile_v1(p_candidate_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_result jsonb;
    v_candidate app.candidates;
begin
    perform app.recruitment_actor_v1(array['candidates.read'], null, null, false);
    v_result := app.get_candidate_workspace_v1(p_candidate_id);
    select c.* into v_candidate from app.candidates c
    where c.organization_id = app.context_uuid_v1('app.organization_id') and c.id = p_candidate_id;
    return v_result || jsonb_build_object('candidate', (v_result -> 'candidate') ||
        jsonb_build_object('headline', v_candidate.headline, 'location', v_candidate.location,
            'email', app.candidate_contact_v1(v_candidate, 'email'),
            'professionalUrl', app.candidate_contact_v1(v_candidate, 'professional_url'),
            'ownerMembershipId', v_candidate.owner_membership_id),
        'profileOptions', app.get_candidate_profile_options_v1(),
        'capabilities', (v_result -> 'capabilities') ||
            jsonb_build_object('writeCandidates', app.has_permission_v1('candidates.write')));
end
$$;

create function app.list_candidate_profiles_v1(p_query text default null, p_limit integer default 500)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_base jsonb;
begin
    perform app.recruitment_actor_v1(array['candidates.read'], null, null, false);
    v_base := app.list_candidates_v1(p_query, p_limit);
    return v_base || jsonb_build_object('candidates', (
        select coalesce(jsonb_agg(e.value || jsonb_build_object(
            'email', app.candidate_contact_v1(c, 'email'), 'headline', c.headline, 'location', c.location)
            order by e.ord), '[]'::jsonb)
        from jsonb_array_elements(v_base -> 'candidates') with ordinality e(value, ord)
        join app.candidates c on c.organization_id = app.context_uuid_v1('app.organization_id')
            and c.id = (e.value ->> 'candidateId')::uuid));
end
$$;

revoke all on function app.candidate_contact_v1(app.candidates, text) from public;
revoke all on function app.save_candidate_profile_v1(uuid, bigint, jsonb, uuid, uuid) from public;
revoke all on function app.get_candidate_profile_options_v1() from public;
revoke all on function app.get_candidate_profile_v1(uuid) from public;
revoke all on function app.list_candidate_profiles_v1(text, integer) from public;
grant execute on function app.save_candidate_profile_v1(uuid, bigint, jsonb, uuid, uuid) to app_staff;
grant execute on function app.get_candidate_profile_options_v1() to app_staff;
grant execute on function app.get_candidate_profile_v1(uuid) to app_staff;
grant execute on function app.list_candidate_profiles_v1(text, integer) to app_staff;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
