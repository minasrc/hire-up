begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local role app_owner;

-- Read-only metadata for the bounded role list. Existing client/job permission
-- checks still apply; application counts require their own read permission.
create function app.client_role_card_metadata_v1(p_client uuid, p_jobs uuid[], p_applications boolean)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
begin
    perform app.recruitment_actor_v1(array['clients.read', 'jobs.read'], null, null, false);
    perform app.get_client_v1(p_client);
    if p_jobs is null or cardinality(p_jobs) > 50 or p_applications is null then
        raise exception 'Invalid role list' using errcode = '22023';
    end if;
    if p_applications then
        perform app.recruitment_actor_v1(array['applications.read'], null, null, false);
    end if;
    return coalesce((select jsonb_agg(jsonb_build_object(
        'id', j.id, 'locationDisplay', j.location_display,
        'locations', coalesce(r.locations, '{}'),
        'remoteRegions', coalesce(r.remote_regions, '{}'),
        'workplaceMode', r.workplace_mode,
        'employmentType', coalesce(r.employment_type, j.employment_type),
        'applications', case when p_applications then (
            select count(*) from app.applications a
            join app.candidates c on c.id = a.candidate_id and c.organization_id = a.organization_id
            where a.organization_id = v_org and a.job_id = j.id and c.lifecycle = 'active'
        ) else null end
    )) from app.jobs j
    left join lateral (
        select locations, remote_regions, workplace_mode, employment_type
        from app.job_revisions
        where organization_id = v_org and job_id = j.id
            and status in ('draft', 'published')
        order by case when status = 'draft' then 0 else 1 end, revision_number desc
        limit 1
    ) r on true
    where j.organization_id = v_org and j.client_id = p_client
        and j.id = any(p_jobs)), '[]'::jsonb);
end;
$$;
revoke all on function app.client_role_card_metadata_v1(uuid, uuid[], boolean) from public;
grant execute on function app.client_role_card_metadata_v1(uuid, uuid[], boolean) to app_staff;
grant create on schema app to app_executor;
reset role;
alter function app.client_role_card_metadata_v1(uuid, uuid[], boolean) owner to app_executor;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
