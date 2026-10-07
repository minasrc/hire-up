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

-- Navigation needs permissions, not counts or candidate/client records. Keep
-- the same capability dependencies as get_staff_workspace_v1 without scanning
-- recruiting tables on the critical path of every staff page.
create function app.get_staff_capabilities_v1()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_candidates boolean;
    v_clients boolean;
    v_jobs boolean;
    v_tasks boolean;
begin
    perform app.recruitment_actor_v1('{}'::text[], null, null, false);
    v_candidates := app.has_permission_v1('candidates.read');
    v_clients := app.has_permission_v1('clients.read');
    v_jobs := v_clients and app.has_permission_v1('jobs.read');
    v_tasks := app.has_permission_v1('collaboration.read');
    return jsonb_build_object(
        'candidates', v_candidates,
        'applications', v_candidates and v_jobs and app.has_permission_v1('applications.read'),
        'clients', v_clients,
        'jobs', v_jobs,
        'members', app.has_permission_v1('staff.manage'),
        'tasks', v_tasks,
        'writeTasks', v_tasks and app.has_permission_v1('collaboration.write'),
        'writeClients', v_clients and app.has_permission_v1('clients.write'),
        'writeJobs', v_jobs and app.has_permission_v1('jobs.write')
    );
end
$$;
revoke all on function app.get_staff_capabilities_v1() from public;
grant execute on function app.get_staff_capabilities_v1() to app_staff;
grant create on schema app to app_executor;
reset role;
alter function app.get_staff_capabilities_v1() owner to app_executor;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
