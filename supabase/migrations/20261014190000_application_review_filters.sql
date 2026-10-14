begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local role app_owner;
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create or replace function app.list_application_directory_v1(
    p_query text, p_job uuid, p_client uuid, p_stage text, p_review boolean, p_page integer
)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
begin
    perform app.recruitment_actor_v1(array['applications.read'], null, null, false);
    if p_query is null or length(p_query) > 200 or p_stage is null
        or length(p_stage) > 64 or p_review is null or p_page is null
        or p_page not between 1 and 1000000 then
        raise exception 'Invalid application directory filters' using errcode = '22023';
    end if;
    return (
        with application_scope as materialized (
            select id, candidate_id, job_id, pipeline_id, stage_id, submitted_name,
                public_reference, received_at, version
            from app.applications where organization_id = v_org
        ), candidate_scope as materialized (
            select id, full_name from app.candidates
            where organization_id = v_org and lifecycle = 'active'
        ), job_scope as materialized (
            select id, title, client_id from app.jobs where organization_id = v_org
        ), client_scope as materialized (
            select id, name from app.clients where organization_id = v_org
        ), stage_scope as materialized (
            select id, pipeline_id, key, label, kind, is_initial, archived_at
            from app.pipeline_stages where organization_id = v_org
        ), resolved as materialized (
            select a.*, coalesce(c.full_name, a.submitted_name) as candidate_name,
                j.title as job_title, j.client_id, cl.name as client_name,
                s.key as stage_key, s.label as stage_label, s.kind as stage_kind,
                s.is_initial and s.archived_at is null as stage_is_initial
            from application_scope a join candidate_scope c on c.id = a.candidate_id
                join job_scope j on j.id = a.job_id
                join client_scope cl on cl.id = j.client_id
                join stage_scope s on s.id = a.stage_id and s.pipeline_id = a.pipeline_id
        ), scoped as materialized (
            select * from resolved
            where (p_job is null or job_id = p_job)
                and (p_client is null or client_id = p_client)
                and (not p_review or stage_is_initial)
                and (p_query = '' or strpos(lower(coalesce(candidate_name, '') || ' ' ||
                    job_title || ' ' || client_name || ' ' || public_reference), lower(p_query)) > 0)
        ), filtered as materialized (
            select * from scoped where p_stage = 'all' or stage_key = p_stage or stage_id::text = p_stage
                or (p_stage = 'active' and stage_kind = 'active')
                or (p_stage = 'to_review' and (stage_is_initial or stage_key in ('new', 'review', 'reviewing')))
                or (p_stage = 'closed' and stage_kind in ('hired', 'rejected', 'withdrawn'))
        ), metadata as (
            select count(*) as total,
                least(p_page, greatest(1, (count(*) + 49) / 50))::integer as page
            from filtered
        ), paged as (
            select * from filtered order by received_at desc, id desc
            limit 50 offset (select (page - 1) * 50 from metadata)
        ), stage_choices as (
            select stage_key as key, min(stage_label) as label, min(stage_kind) as kind, bool_or(stage_is_initial) as is_initial
            from resolved group by stage_key
        ), stage_counts as (
            select stage_key as key, count(*) as count from scoped group by stage_key
        )
        select jsonb_build_object(
            'total', m.total, 'page', m.page, 'pageSize', 50,
            'scopeTotal', (select count(*) from scoped),
            'rows', coalesce((select jsonb_agg(jsonb_build_object(
                'applicationId', a.id, 'candidateId', a.candidate_id,
                'candidateName', a.candidate_name, 'jobId', a.job_id, 'jobTitle', a.job_title,
                'clientId', a.client_id, 'clientName', a.client_name,
                'stageId', a.stage_id, 'stageKey', a.stage_key, 'stageLabel', a.stage_label,
                'stageKind', a.stage_kind, 'stageIsInitial', a.stage_is_initial,
                'publicReference', a.public_reference, 'receivedAt', a.received_at,
                'version', a.version::text
            ) order by a.received_at desc, a.id desc) from paged a), '[]'::jsonb),
            'stages', coalesce((select jsonb_agg(jsonb_build_object(
                'key', s.key, 'label', s.label, 'kind', s.kind, 'isInitial', s.is_initial, 'count', coalesce(c.count, 0)
            ) order by s.key) from stage_choices s left join stage_counts c on c.key = s.key), '[]'::jsonb),
            'jobs', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title)
                order by lower(title), id) from job_scope), '[]'::jsonb),
            'clients', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name)
                order by lower(name), id) from client_scope), '[]'::jsonb)
        ) from metadata m
    );
end
$$;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
