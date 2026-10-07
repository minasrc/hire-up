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
grant create on schema app to app_executor;
reset role;
set local role app_executor;

create function app.get_recruitment_context_v1()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
    v_candidates boolean := app.has_permission_v1('candidates.read');
    v_jobs boolean := app.has_permission_v1('jobs.read') and app.has_permission_v1('clients.read');
    v_applications boolean := app.has_permission_v1('applications.read') and v_candidates and v_jobs;
begin
    v_member := app.recruitment_actor_v1('{}'::text[], null, null, false);
    return jsonb_build_object(
        'currentMembershipId', v_member,
        'capabilities', jsonb_build_object(
            'readCandidates', v_candidates,
            'readNotes', v_candidates and app.has_permission_v1('collaboration.read'),
            'writeNotes', v_candidates and app.has_permission_v1('collaboration.write'),
            'writeCandidates', v_candidates and app.has_permission_v1('candidates.write'),
            'readApplications', v_applications,
            'addApplications', v_applications and app.has_permission_v1('candidates.write')
                and app.has_permission_v1('applications.stage'),
            'readJobs', v_jobs,
            'writeJobs', v_jobs and app.has_permission_v1('jobs.write'),
            'readClients', app.has_permission_v1('clients.read'),
            'writeClients', app.has_permission_v1('clients.read') and app.has_permission_v1('clients.write'),
            'uploadDocuments', v_candidates and app.has_permission_v1('candidates.write')
                and app.has_permission_v1('documents.write'),
            'downloadDocuments', v_candidates and app.has_permission_v1('documents.download'),
            'managePrivacy', app.has_permission_v1('privacy.manage')),
        'owners', case when v_candidates then (
            select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'name', u.display_name)
                order by u.display_name, m.id), '[]'::jsonb)
            from app.organization_memberships m join app.users u on u.id = m.user_id
            where m.organization_id = v_org and m.status = 'active' and u.status = 'active'
        ) else '[]'::jsonb end,
        'tags', case when v_candidates then (
            select coalesce(jsonb_agg(t.tag order by t.tag), '[]'::jsonb)
            from (select distinct unnest(c.tags) as tag from app.candidates c
                where c.organization_id = v_org and c.lifecycle = 'active') t
        ) else '[]'::jsonb end,
        'jobs', case when v_jobs then (
            select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'title', j.title,
                'clientId', cl.id, 'clientName', cl.name, 'publicationState', j.publication_state,
                'applicationState', j.application_state, 'publiclyListed', j.publicly_listed)
                order by cl.name, j.title, j.id), '[]'::jsonb)
            from app.jobs j join app.clients cl
                on cl.organization_id = j.organization_id and cl.id = j.client_id
            where j.organization_id = v_org and cl.status = 'active'
                and j.publication_state = 'published' and j.application_state = 'open'
        ) else '[]'::jsonb end);
end
$$;

create function app.candidate_card_v1(p_candidate app.candidates)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, app, pg_temp
as $$
    select case when p_candidate.lifecycle <> 'active' then jsonb_build_object(
        'candidateId', p_candidate.id, 'fullName', 'Restricted candidate',
        'lifecycle', p_candidate.lifecycle, 'version', p_candidate.version::text,
        'createdAt', p_candidate.created_at, 'tags', '[]'::jsonb)
    else jsonb_build_object(
        'candidateId', p_candidate.id, 'fullName', p_candidate.full_name,
        'headline', p_candidate.headline, 'location', p_candidate.location,
        'professionalSummary', p_candidate.professional_summary,
        'email', app.candidate_contact_v1(p_candidate, 'email'),
        'professionalUrl', app.candidate_contact_v1(p_candidate, 'professional_url'),
        'lifecycle', p_candidate.lifecycle, 'availability', p_candidate.availability,
        'tags', p_candidate.tags, 'skills', p_candidate.skills, 'experience', p_candidate.experience,
        'ownerMembershipId', p_candidate.owner_membership_id,
        'ownerName', (select u.display_name from app.organization_memberships m
            join app.users u on u.id = m.user_id where m.organization_id = p_candidate.organization_id
                and m.id = p_candidate.owner_membership_id),
        'source', (select s.kind from app.candidate_sources s
            where s.organization_id = p_candidate.organization_id and s.candidate_id = p_candidate.id
            order by s.received_at, s.id limit 1),
        'applicationCount', case when app.has_permission_v1('applications.read') then
            (select count(*) from app.applications a
                where a.organization_id = p_candidate.organization_id and a.candidate_id = p_candidate.id)
            else null end,
        'currentDocumentId', p_candidate.current_document_id,
        'hasCv', exists (select 1 from app.documents d
            where d.organization_id = p_candidate.organization_id and d.candidate_id = p_candidate.id
                and d.lifecycle = 'active'),
        'createdAt', p_candidate.created_at, 'version', p_candidate.version::text) end
$$;

create function app.list_candidate_directory_v1(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
    v_query text := lower(btrim(coalesce(p_filters ->> 'query', '')));
    v_owner text := coalesce(p_filters ->> 'owner', 'all');
    v_tag text := coalesce(p_filters ->> 'tag', 'all');
    v_tab text := coalesce(p_filters ->> 'tab', 'all');
    v_page integer := coalesce((p_filters ->> 'page')::integer, 1);
    v_result jsonb;
begin
    v_member := app.recruitment_actor_v1(array['candidates.read'], null, null, false);
    if jsonb_typeof(p_filters) is distinct from 'object'
        or p_filters - array['query', 'owner', 'tag', 'tab', 'page'] <> '{}'::jsonb
        or char_length(v_query) > 200 or char_length(v_tag) > 80
        or v_tab not in ('all', 'mine', 'recent') or v_page not between 1 and 1000000
        or (v_owner not in ('all', 'mine') and v_owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        raise exception 'Invalid candidate filters' using errcode = '22023';
    end if;
    with filtered as materialized (
        select c.* from app.candidates c where c.organization_id = v_org
            and c.lifecycle in ('active', 'restricted')
            and (v_tab <> 'mine' or (c.lifecycle = 'active' and c.owner_membership_id = v_member))
            and (v_tab <> 'recent' or (c.lifecycle = 'active' and c.created_at >= now() - interval '7 days'))
            and (v_owner = 'all' or (c.lifecycle = 'active' and c.owner_membership_id =
                case when v_owner = 'mine' then v_member else nullif(v_owner, 'all')::uuid end))
            and (v_tag = 'all' or (c.lifecycle = 'active' and v_tag = any(c.tags)))
            and (v_query = '' or position(v_query in lower(c.id::text)) > 0
                or (c.lifecycle = 'active' and position(v_query in lower(concat_ws(' ',
                    c.full_name, c.headline, c.location, array_to_string(c.tags, ' '),
                    app.candidate_contact_v1(c, 'email')))) > 0))
    ), page_rows as (
        select * from filtered order by created_at desc, id desc
        limit 25 offset ((v_page - 1) * 25)
    )
    select jsonb_build_object('candidates', coalesce((
        select jsonb_agg(app.candidate_card_v1(p::app.candidates) order by p.created_at desc, p.id desc)
        from page_rows p), '[]'::jsonb), 'total', (select count(*) from filtered),
        'page', v_page, 'pageSize', 25,
        'counts', jsonb_build_object(
            'all', (select count(*) from app.candidates c where c.organization_id = v_org
                and c.lifecycle in ('active', 'restricted')),
            'restricted', (select count(*) from app.candidates c where c.organization_id = v_org
                and c.lifecycle = 'restricted'),
            'withApplications', case when app.has_permission_v1('applications.read') then
                (select count(*) from app.candidates c where c.organization_id = v_org
                    and c.lifecycle = 'active' and exists (select 1 from app.applications a
                        where a.organization_id = v_org and a.candidate_id = c.id)) else null end)
    ) into v_result;
    return v_result || jsonb_build_object('context', app.get_recruitment_context_v1());
end
$$;

create function app.get_candidate_workspace_v2(p_candidate_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_candidate app.candidates;
    v_result jsonb;
    v_context jsonb;
begin
    perform app.recruitment_actor_v1(array['candidates.read'], null, null, false);
    select c.* into v_candidate from app.candidates c
    where c.organization_id = v_org and c.id = p_candidate_id;
    if not found or v_candidate.lifecycle not in ('active', 'restricted') then
        raise exception 'Candidate not found' using errcode = 'P0002';
    end if;
    v_context := app.get_recruitment_context_v1();
    if v_candidate.lifecycle = 'restricted' then
        return jsonb_build_object('candidate', app.candidate_card_v1(v_candidate),
            'identifiers', '[]'::jsonb, 'applications', '[]'::jsonb, 'stages', '[]'::jsonb,
            'documents', '[]'::jsonb, 'notes', '[]'::jsonb,
            'capabilities', jsonb_build_object('managePrivacy', app.has_permission_v1('privacy.manage')));
    end if;
    v_result := app.get_candidate_workspace_v1(p_candidate_id);
    return v_result || jsonb_build_object(
        'candidate', (v_result -> 'candidate') || app.candidate_card_v1(v_candidate),
        'context', v_context,
        'capabilities', (v_result -> 'capabilities') || (v_context -> 'capabilities'),
        'applications', case when (v_context #>> '{capabilities,readApplications}')::boolean then
            (select coalesce(jsonb_agg(e.value || app.application_card_v1(a)
                order by a.received_at desc, a.id desc), '[]'::jsonb)
                from jsonb_array_elements(v_result -> 'applications') e(value)
                join app.applications a on a.organization_id = v_org
                    and a.candidate_id = p_candidate_id
                    and a.id = (e.value ->> 'applicationId')::uuid)
            else '[]'::jsonb end,
        'notes', (select coalesce(jsonb_agg(n.value
            order by (n.value ->> 'createdAt')::timestamptz desc, n.value ->> 'noteId' desc), '[]'::jsonb)
            from jsonb_array_elements(v_result -> 'notes') n(value)),
        'documents', (select coalesce(jsonb_agg(jsonb_build_object(
            'documentId', d.id, 'filename', d.original_filename, 'purpose', d.purpose,
            'lifecycle', d.lifecycle, 'scanState', b.scan_state, 'mimeType', b.mime_type,
            'sizeBytes', b.size_bytes, 'receivedAt', d.received_at,
            'current', d.id = v_candidate.current_document_id,
            'supersedesDocumentId', d.supersedes_document_id,
            'version', (select count(*) from app.documents d2
                where d2.organization_id = v_org and d2.candidate_id = p_candidate_id
                    and (d2.received_at, d2.id) <= (d.received_at, d.id)))
            order by d.received_at desc, d.id desc), '[]'::jsonb)
            from app.documents d join app.file_blobs b
                on b.organization_id = d.organization_id and b.candidate_id = d.candidate_id and b.id = d.blob_id
            where d.organization_id = v_org and d.candidate_id = p_candidate_id));
end
$$;

create function app.staff_job_card_v1(p_job app.jobs)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_revision app.job_revisions;
    v_draft uuid;
    v_client app.clients;
begin
    select r.* into v_revision from app.job_revisions r
    where r.organization_id = p_job.organization_id and r.job_id = p_job.id
        and (r.status = 'draft' or r.id = p_job.published_revision_id)
    order by (r.status = 'draft') desc, r.revision_number desc limit 1;
    select r.id into v_draft from app.job_revisions r
    where r.organization_id = p_job.organization_id and r.job_id = p_job.id and r.status = 'draft';
    select c.* into v_client from app.clients c
    where c.organization_id = p_job.organization_id and c.id = p_job.client_id;
    return jsonb_build_object('id', p_job.id, 'title', p_job.title, 'clientId', p_job.client_id,
        'clientName', v_client.name, 'clientIsStealth', v_client.is_stealth,
        'slug', p_job.slug, 'publicationState', p_job.publication_state,
        'applicationState', p_job.application_state, 'publiclyListed', p_job.publicly_listed,
        'publishedRevisionId', p_job.published_revision_id, 'draftRevisionId', v_draft,
        'ownerMembershipId', p_job.owner_membership_id, 'version', p_job.version::text,
        'createdAt', p_job.created_at, 'employmentType', v_revision.employment_type,
        'workplaceMode', v_revision.workplace_mode, 'locations', coalesce(v_revision.locations, '{}'::text[]),
        'remoteRegions', coalesce(v_revision.remote_regions, '{}'::text[]),
        'descriptionText', coalesce(v_revision.description_text, p_job.description),
        'applicationCount', case when app.has_permission_v1('applications.read')
            and app.has_permission_v1('candidates.read') then
            (select count(*) from app.applications a join app.candidates c
                on c.organization_id = a.organization_id and c.id = a.candidate_id
                where a.organization_id = p_job.organization_id and a.job_id = p_job.id
                    and c.lifecycle = 'active') else null end);
end
$$;

create function app.list_workspace_jobs_v1(p_limit integer default 500, p_client_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
    perform app.recruitment_actor_v1(array['jobs.read', 'clients.read'], null, null, false);
    if p_limit is null or p_limit not between 1 and 500 then
        raise exception 'Invalid list limit' using errcode = '22023';
    end if;
    return (select coalesce(jsonb_agg(app.staff_job_card_v1(t::app.jobs) order by t.created_at desc, t.id desc), '[]'::jsonb)
        from (select j.* from app.jobs j where j.organization_id = app.context_uuid_v1('app.organization_id')
            and (p_client_id is null or j.client_id = p_client_id)
            order by j.created_at desc, j.id desc limit p_limit) t);
end
$$;

create function app.get_job_workspace_v2(p_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_job app.jobs;
    v_result jsonb;
begin
    v_result := app.get_job_workspace_v1(p_job_id);
    select j.* into v_job from app.jobs j
    where j.organization_id = app.context_uuid_v1('app.organization_id') and j.id = p_job_id;
    return v_result || jsonb_build_object('job', (v_result -> 'job') || app.staff_job_card_v1(v_job),
        'context', app.get_recruitment_context_v1());
end
$$;

create function app.application_card_v1(p_application app.applications)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, app, pg_temp
as $$
    select jsonb_build_object('applicationId', p_application.id, 'candidateId', c.id,
        'candidateName', coalesce(c.full_name, p_application.submitted_name),
        'candidateLocation', c.location, 'jobId', j.id, 'jobTitle', j.title,
        'clientId', cl.id, 'clientName', cl.name, 'stageId', s.id, 'stageKey', s.key,
        'stageLabel', s.label, 'stageKind', s.kind, 'stageIsInitial', s.is_initial,
        'pipelineId', p_application.pipeline_id, 'receivedAt', p_application.received_at,
        'publicReference', p_application.public_reference, 'version', p_application.version::text,
        'ownerMembershipId', coalesce(p_application.owner_membership_id, c.owner_membership_id),
        'ownerName', u.display_name, 'source', src.kind)
    from app.candidates c
    join app.jobs j on j.organization_id = c.organization_id and j.id = p_application.job_id
    join app.clients cl on cl.organization_id = j.organization_id and cl.id = j.client_id
    join app.pipeline_stages s on s.organization_id = j.organization_id
        and s.pipeline_id = p_application.pipeline_id and s.id = p_application.stage_id
    left join app.organization_memberships m on m.organization_id = c.organization_id
        and m.id = coalesce(p_application.owner_membership_id, c.owner_membership_id)
    left join app.users u on u.id = m.user_id
    left join app.candidate_sources src on src.organization_id = c.organization_id
        and src.id = p_application.source_id
    where c.organization_id = p_application.organization_id and c.id = p_application.candidate_id
        and c.lifecycle = 'active'
$$;

create function app.list_application_directory_v1(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
    v_query text := lower(btrim(coalesce(p_filters ->> 'query', '')));
    v_client uuid := nullif(p_filters ->> 'clientId', '')::uuid;
    v_job uuid := nullif(p_filters ->> 'jobId', '')::uuid;
    v_owner text := coalesce(p_filters ->> 'owner', 'all');
    v_stage text := coalesce(p_filters ->> 'stage', 'all');
    v_review boolean := coalesce((p_filters ->> 'review')::boolean, false);
    v_range text := coalesce(p_filters ->> 'dateRange', 'all');
    v_from timestamptz;
    v_to timestamptz;
    v_page integer := coalesce((p_filters ->> 'page')::integer, 1);
    v_result jsonb;
begin
    v_member := app.recruitment_actor_v1(array['applications.read', 'candidates.read',
        'jobs.read', 'clients.read'], null, null, false);
    if jsonb_typeof(p_filters) is distinct from 'object'
        or p_filters - array['query', 'clientId', 'jobId', 'owner', 'stage', 'review',
            'dateRange', 'from', 'to', 'page'] <> '{}'::jsonb
        or char_length(v_query) > 200 or char_length(v_stage) > 100
        or v_range not in ('all', '7d', '30d', 'custom') or v_page not between 1 and 1000000
        or (v_owner not in ('all', 'mine') and v_owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        raise exception 'Invalid application filters' using errcode = '22023';
    end if;
    if v_range in ('7d', '30d') then
        v_to := (date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC';
        v_from := v_to - case v_range when '7d' then interval '7 days' else interval '30 days' end;
    elsif v_range = 'custom' then
        if nullif(p_filters ->> 'from', '') is not null then
            v_from := ((p_filters ->> 'from')::date)::timestamp at time zone 'UTC';
        end if;
        if nullif(p_filters ->> 'to', '') is not null then
            v_to := (((p_filters ->> 'to')::date) + 1)::timestamp at time zone 'UTC';
        end if;
        if v_from is not null and v_to is not null and v_from >= v_to then
            raise exception 'From date must not follow To date' using errcode = '22023';
        end if;
    end if;
    with base as materialized (
        select a.* from app.applications a join app.candidates c
            on c.organization_id = a.organization_id and c.id = a.candidate_id
        join app.jobs j on j.organization_id = a.organization_id and j.id = a.job_id
        join app.clients cl on cl.organization_id = j.organization_id and cl.id = j.client_id
        where a.organization_id = v_org and c.lifecycle = 'active'
            and (v_client is null or j.client_id = v_client)
            and (v_job is null or a.job_id = v_job)
            and (v_owner = 'all' or coalesce(a.owner_membership_id, c.owner_membership_id) =
                case when v_owner = 'mine' then v_member else nullif(v_owner, 'all')::uuid end)
            and (v_from is null or a.received_at >= v_from)
            and (v_to is null or a.received_at < v_to)
            and (v_query = '' or position(v_query in lower(concat_ws(' ',
                c.full_name, a.submitted_name, j.title, cl.name, a.public_reference))) > 0)
    ), filtered as materialized (
        select a.* from base a join app.pipeline_stages s
            on s.organization_id = a.organization_id and s.pipeline_id = a.pipeline_id and s.id = a.stage_id
        where (v_stage = 'all' or s.key = v_stage or s.id::text = v_stage)
            and (not v_review or s.is_initial)
    ), page_rows as (
        select * from filtered order by received_at desc, id desc limit 25 offset ((v_page - 1) * 25)
    )
    select jsonb_build_object('applications', coalesce((
        select jsonb_agg(app.application_card_v1(p::app.applications) order by p.received_at desc, p.id desc)
            from page_rows p), '[]'::jsonb),
        'total', (select count(*) from filtered), 'page', v_page, 'pageSize', 25,
        'allCount', (select count(*) from base),
        'stages', (select coalesce(jsonb_agg(jsonb_build_object('key', t.key,
            'label', t.label, 'kind', t.kind, 'count', t.count) order by t.position, t.key), '[]'::jsonb)
            from (select s.key, string_agg(distinct s.label, ' / ' order by s.label) as label,
                    case when count(distinct s.kind) = 1 then min(s.kind) else 'other' end as kind,
                    min(s.position) as position, count(b.id) as count
                from app.pipeline_stages s left join base b on b.organization_id = s.organization_id
                    and b.pipeline_id = s.pipeline_id and b.stage_id = s.id
                where s.organization_id = v_org and s.archived_at is null
                group by s.key) t),
        'clients', (select coalesce(jsonb_agg(jsonb_build_object('id', cl.id, 'name', cl.name)
            order by cl.name, cl.id), '[]'::jsonb) from app.clients cl where cl.organization_id = v_org),
        'jobs', (select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'title', j.title,
            'clientId', j.client_id) order by j.title, j.id), '[]'::jsonb)
            from app.jobs j where j.organization_id = v_org
                and (v_client is null or j.client_id = v_client))
    ) into v_result;
    return v_result || jsonb_build_object('context', app.get_recruitment_context_v1());
end
$$;

create function app.get_client_workspace_v1(p_client_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_client jsonb;
    v_jobs boolean := app.has_permission_v1('jobs.read');
    v_apps boolean := v_jobs and app.has_permission_v1('applications.read') and app.has_permission_v1('candidates.read');
begin
    v_client := app.get_client_v1(p_client_id);
    return jsonb_build_object('client', v_client, 'context', app.get_recruitment_context_v1(),
        'jobs', case when v_jobs then app.list_workspace_jobs_v1(500, p_client_id) else '[]'::jsonb end,
        'jobTotal', case when v_jobs then (select count(*) from app.jobs j
            where j.organization_id = v_org and j.client_id = p_client_id) else null end,
        'openRoles', case when v_jobs then (select count(*) from app.jobs j
            where j.organization_id = v_org and j.client_id = p_client_id
                and j.publication_state = 'published' and j.application_state = 'open') else null end,
        'applicationCount', case when v_apps then (select count(*) from app.applications a
            join app.jobs j on j.organization_id = a.organization_id and j.id = a.job_id
            join app.candidates c on c.organization_id = a.organization_id and c.id = a.candidate_id
            where a.organization_id = v_org and j.client_id = p_client_id and c.lifecycle = 'active') else null end,
        'interviewingCount', case when v_apps then (select count(*) from app.applications a
            join app.jobs j on j.organization_id = a.organization_id and j.id = a.job_id
            join app.candidates c on c.organization_id = a.organization_id and c.id = a.candidate_id
            join app.pipeline_stages s on s.organization_id = a.organization_id
                and s.pipeline_id = a.pipeline_id and s.id = a.stage_id
            where a.organization_id = v_org and j.client_id = p_client_id
                and c.lifecycle = 'active' and s.key = 'interview') else null end,
        'recentApplications', case when v_apps then (select coalesce(jsonb_agg(
            app.application_card_v1(t::app.applications) order by t.received_at desc, t.id desc), '[]'::jsonb)
            from (select a.* from app.applications a
                join app.jobs j on j.organization_id = a.organization_id and j.id = a.job_id
                join app.candidates c on c.organization_id = a.organization_id and c.id = a.candidate_id
                where a.organization_id = v_org and j.client_id = p_client_id and c.lifecycle = 'active'
                order by a.received_at desc, a.id desc limit 5) t) else '[]'::jsonb end);
end
$$;

create function app.list_privacy_cases_v1()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
begin
    perform app.recruitment_actor_v1(array['privacy.manage'], null, null, false);
    return jsonb_build_object('cases', (select coalesce(jsonb_agg(t.row_data
        order by t.received_at desc, t.id desc), '[]'::jsonb)
        from (select r.id, r.received_at, jsonb_build_object('id', r.id,
            'kind', r.kind, 'status', r.status, 'receivedAt', r.received_at,
            'dueAt', r.due_at, 'verifiedAt', r.verified_at, 'resolvedAt', r.resolved_at,
            'version', r.version::text,
            'subjects', (select coalesce(jsonb_agg(jsonb_build_object('subjectId', s.id,
                'candidateId', s.candidate_id, 'legacyRecordId', s.legacy_record_id,
                'reviewedAt', s.reviewed_at) order by s.reviewed_at, s.id), '[]'::jsonb)
                from app.privacy_request_subjects s where s.organization_id = r.organization_id
                    and s.request_id = r.id),
            'events', (select coalesce(jsonb_agg(jsonb_build_object('action', e.action,
                'occurredAt', e.occurred_at, 'evidenceCode', e.evidence_code)
                order by e.sequence), '[]'::jsonb) from app.privacy_events e
                where e.organization_id = r.organization_id and e.request_id = r.id)
        ) as row_data from app.privacy_requests r
        where r.organization_id = app.context_uuid_v1('app.organization_id')
        order by r.received_at desc, r.id desc limit 500) t));
end
$$;

create function app.duplicate_job_v2(
    p_source_revision_id uuid, p_expected_source_version bigint, p_client_id uuid,
    p_job_id uuid, p_revision_id uuid, p_operation_id uuid, p_correlation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_result jsonb;
begin
    v_result := app.duplicate_job_v1(p_source_revision_id, p_expected_source_version,
        p_client_id, p_job_id, p_revision_id, p_operation_id, p_correlation_id);
    if not coalesce((v_result ->> 'replayed')::boolean, false) then
        update app.jobs set publicly_listed = false
        where organization_id = app.context_uuid_v1('app.organization_id') and id = p_job_id;
    end if;
    return v_result;
end
$$;

revoke all on function app.get_recruitment_context_v1() from public;
revoke all on function app.candidate_card_v1(app.candidates) from public;
revoke all on function app.list_candidate_directory_v1(jsonb) from public;
revoke all on function app.get_candidate_workspace_v2(uuid) from public;
revoke all on function app.staff_job_card_v1(app.jobs) from public;
revoke all on function app.list_workspace_jobs_v1(integer, uuid) from public;
revoke all on function app.get_job_workspace_v2(uuid) from public;
revoke all on function app.application_card_v1(app.applications) from public;
revoke all on function app.list_application_directory_v1(jsonb) from public;
revoke all on function app.get_client_workspace_v1(uuid) from public;
revoke all on function app.list_privacy_cases_v1() from public;
revoke all on function app.duplicate_job_v2(uuid, bigint, uuid, uuid, uuid, uuid, uuid) from public;
grant execute on function app.get_recruitment_context_v1() to app_staff;
grant execute on function app.list_candidate_directory_v1(jsonb) to app_staff;
grant execute on function app.get_candidate_workspace_v2(uuid) to app_staff;
grant execute on function app.list_workspace_jobs_v1(integer, uuid) to app_staff;
grant execute on function app.get_job_workspace_v2(uuid) to app_staff;
grant execute on function app.list_application_directory_v1(jsonb) to app_staff;
grant execute on function app.get_client_workspace_v1(uuid) to app_staff;
grant execute on function app.list_privacy_cases_v1() to app_staff;
grant execute on function app.duplicate_job_v2(uuid, bigint, uuid, uuid, uuid, uuid, uuid) to app_staff;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
