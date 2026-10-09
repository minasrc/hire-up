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

create function app.get_staff_notifications_v1()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
    v_candidates boolean;
    v_clients boolean;
    v_jobs boolean;
    v_applications boolean;
    v_members boolean;
    v_tasks boolean;
    v_review_count bigint;
    v_invite_count bigint;
    v_task_count bigint;
begin
    v_member := app.recruitment_actor_v1('{}'::text[], null, null, false);
    v_candidates := app.has_permission_v1('candidates.read');
    v_clients := app.has_permission_v1('clients.read');
    v_jobs := v_clients and app.has_permission_v1('jobs.read');
    v_applications := v_candidates and v_jobs and app.has_permission_v1('applications.read');
    v_members := app.has_permission_v1('staff.manage');
    v_tasks := app.has_permission_v1('collaboration.read');
    if v_applications then
        select count(*) into v_review_count
        from app.applications a
        join app.candidates c on c.organization_id = a.organization_id and c.id = a.candidate_id
        join app.jobs j on j.organization_id = a.organization_id and j.id = a.job_id
        join app.clients cl on cl.organization_id = j.organization_id and cl.id = j.client_id
        join app.pipeline_stages s on s.organization_id = a.organization_id
            and s.pipeline_id = a.pipeline_id and s.id = a.stage_id
        where a.organization_id = v_org and c.lifecycle = 'active'
            and s.is_initial and s.archived_at is null;
    end if;
    if v_members then
        select count(*) into v_invite_count from app.organization_memberships m
        where m.organization_id = v_org and m.status = 'invited';
    end if;
    if v_tasks then
        select count(*) into v_task_count from app.staff_tasks t
        where t.organization_id = v_org and t.owner_membership_id = v_member and t.completed_at is null;
    end if;
    return jsonb_build_object(
        'capabilities', jsonb_build_object(
            'candidates', v_candidates, 'applications', v_applications,
            'clients', v_clients, 'jobs', v_jobs, 'members', v_members,
            'tasks', v_tasks, 'writeTasks', v_tasks and app.has_permission_v1('collaboration.write'),
            'writeClients', v_clients and app.has_permission_v1('clients.write'),
            'writeJobs', v_jobs and app.has_permission_v1('jobs.write')
        ),
        'attention', jsonb_build_object(
            'reviewApplications', v_review_count, 'pendingInvites', v_invite_count, 'openTasks', v_task_count
        )
    );
end
$$;
revoke all on function app.get_staff_notifications_v1() from public;
grant execute on function app.get_staff_notifications_v1() to app_staff;
grant create on schema app to app_executor;
reset role;
alter function app.get_staff_notifications_v1() owner to app_executor;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
