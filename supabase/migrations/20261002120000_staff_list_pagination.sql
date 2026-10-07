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

-- Filter the whole authorized directory, but construct expensive row details only
-- for the requested 50 rows. Counts and rows share one statement snapshot.
create function app.list_client_directory_v1(p_query text, p_status text, p_page integer)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
begin
    perform app.recruitment_actor_v1(array['clients.read'], null, null, false);
    if p_query is null or length(p_query) > 200 or p_status is null
        or p_status not in ('all', 'active', 'draft') or p_page is null
        or p_page not between 1 and 1000000 then
        raise exception 'Invalid client directory filters' using errcode = '22023';
    end if;
    return (
        with filtered as materialized (
            select c.id, c.name, c.status, c.is_stealth, c.created_at
            from app.clients c where c.organization_id = v_org
                and (p_status = 'all' or c.status = p_status)
                and (p_query = '' or strpos(lower(c.name), lower(p_query)) > 0)
        ), metadata as (
            select count(*) as total,
                least(p_page, greatest(1, (count(*) + 49) / 50))::integer as page
            from filtered
        ), paged as (
            select * from filtered order by created_at desc, id desc
            limit 50 offset (select (page - 1) * 50 from metadata)
        )
        select jsonb_build_object(
            'total', m.total, 'page', m.page, 'pageSize', 50,
            'rows', coalesce((select jsonb_agg(jsonb_build_object(
                'id', c.id, 'name', c.name, 'status', c.status,
                'isStealth', c.is_stealth, 'createdAt', c.created_at,
                'jobCount', (select count(*) from app.jobs j
                    where j.organization_id = v_org and j.client_id = c.id)
            ) order by c.created_at desc, c.id desc) from paged c), '[]'::jsonb)
        ) from metadata m
    );
end
$$;

create function app.list_job_directory_v1(
    p_query text, p_client uuid, p_state text, p_intake text,
    p_mine boolean, p_sort text, p_direction text, p_page integer
)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
begin
    v_member := app.recruitment_actor_v1(array['jobs.read', 'clients.read'], null, null, false);
    if p_query is null or length(p_query) > 200 or p_state is null
        or p_state not in ('all', 'draft', 'published', 'listed', 'unlisted', 'withdrawn', 'archived')
        or p_intake is null or p_intake not in ('all', 'open', 'closed')
        or p_mine is null or p_sort is null or p_sort not in ('title', 'client', 'publication')
        or p_direction is null or p_direction not in ('asc', 'desc')
        or p_page is null or p_page not between 1 and 1000000 then
        raise exception 'Invalid job directory filters' using errcode = '22023';
    end if;
    return (
        with job_scope as materialized (
            select id, title, client_id, publication_state, application_state,
                publicly_listed, owner_membership_id, created_at
            from app.jobs where organization_id = v_org
        ), client_scope as materialized (
            select id, name, is_stealth from app.clients where organization_id = v_org
        ), filtered as materialized (
            select j.id, j.title, j.client_id, j.publication_state, j.application_state,
                j.publicly_listed, j.owner_membership_id, j.created_at,
                c.name as client_name, c.is_stealth as client_is_stealth,
                case p_sort when 'client' then lower(c.name)
                    when 'publication' then case
                        when j.publication_state = 'published' then
                            case when j.publicly_listed then 'listed' else 'unlisted' end
                        else j.publication_state end
                    else lower(j.title) end as sort_value
            from job_scope j join client_scope c on c.id = j.client_id
            where (p_client is null or j.client_id = p_client)
                and (not p_mine or j.owner_membership_id = v_member)
                and (p_intake = 'all' or j.application_state = p_intake)
                and (p_state = 'all' or j.publication_state = p_state
                    or (p_state = 'listed' and j.publication_state = 'published' and j.publicly_listed)
                    or (p_state = 'unlisted' and j.publication_state = 'published' and not j.publicly_listed))
                and (p_query = '' or strpos(lower(j.title || ' ' || c.name), lower(p_query)) > 0)
        ), metadata as (
            select count(*) as total,
                least(p_page, greatest(1, (count(*) + 49) / 50))::integer as page
            from filtered
        ), paged as (
            select * from filtered
            order by case when p_direction = 'asc' then sort_value end asc,
                case when p_direction = 'desc' then sort_value end desc,
                lower(title), id
            limit 50 offset (select (page - 1) * 50 from metadata)
        )
        select jsonb_build_object(
            'total', m.total, 'page', m.page, 'pageSize', 50,
            'rows', coalesce((select jsonb_agg(jsonb_build_object(
                'id', j.id, 'title', j.title, 'clientId', j.client_id,
                'clientName', j.client_name, 'clientIsStealth', j.client_is_stealth,
                'publicationState', j.publication_state, 'applicationState', j.application_state,
                'publiclyListed', j.publicly_listed, 'ownerMembershipId', j.owner_membership_id,
                'draftRevisionId', (select r.id from app.job_revisions r
                    where r.organization_id = v_org and r.job_id = j.id and r.status = 'draft' limit 1),
                'createdAt', j.created_at
            ) order by case when p_direction = 'asc' then j.sort_value end asc,
                case when p_direction = 'desc' then j.sort_value end desc,
                lower(j.title), j.id) from paged j), '[]'::jsonb),
            -- Only lightweight filter labels; never send off-page job details.
            'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                order by lower(c.name), c.id) from client_scope c
                where c.id in (select client_id from job_scope)), '[]'::jsonb)
        ) from metadata m
    );
end
$$;

revoke all on function app.list_client_directory_v1(text, text, integer) from public;
revoke all on function app.list_job_directory_v1(text, uuid, text, text, boolean, text, text, integer) from public;
grant execute on function app.list_client_directory_v1(text, text, integer) to app_staff;
grant execute on function app.list_job_directory_v1(text, uuid, text, text, boolean, text, text, integer) to app_staff;
grant create on schema app to app_executor;
reset role;
alter function app.list_client_directory_v1(text, text, integer) owner to app_executor;
alter function app.list_job_directory_v1(text, uuid, text, text, boolean, text, text, integer) owner to app_executor;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
