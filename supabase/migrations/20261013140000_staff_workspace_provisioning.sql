-- Invitation-only tenant provisioning is a platform capability, not a customer role.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare existing record;
begin
    select * into existing from pg_roles where rolname = 'app_workspace_provisioner';
    if found then
        if existing.rolcanlogin or existing.rolinherit or existing.rolsuper
            or existing.rolbypassrls or existing.rolcreatedb or existing.rolcreaterole
            or existing.rolreplication then
            raise exception 'Unsafe workspace provisioner role';
        end if;
    else
        create role app_workspace_provisioner nologin noinherit nosuperuser
            nocreatedb nocreaterole noreplication nobypassrls;
    end if;
    if exists (
        select 1 from pg_auth_members
        where member = (select oid from pg_roles where rolname = 'app_workspace_provisioner')
    ) then
        raise exception 'Workspace provisioner must not inherit roles';
    end if;
    if not (select rolsuper from pg_roles where rolname = session_user) then
        execute format('grant app_workspace_provisioner to %I with set true, inherit false', session_user);
    end if;
end
$$;

set local role app_owner;
create table app.platform_workspace_roots (
    organization_id uuid primary key references app.organizations(id)
);
alter table app.platform_workspace_roots enable row level security;
alter table app.platform_workspace_roots force row level security;
grant select on app.platform_workspace_roots to app_executor;
create policy platform_workspace_roots_scope on app.platform_workspace_roots
    for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id'));

create table app.staff_workspace_creations (
    root_organization_id uuid not null references app.organizations(id),
    operation_id uuid not null,
    actor_user_id uuid not null references app.users(id),
    request_digest bytea not null check(octet_length(request_digest) = 32),
    organization_id uuid not null unique references app.organizations(id),
    name text not null,
    admin_email text not null,
    created_at timestamptz not null default clock_timestamp(),
    primary key(root_organization_id, operation_id)
);
alter table app.staff_workspace_creations enable row level security;
alter table app.staff_workspace_creations force row level security;
grant select, insert on app.staff_workspace_creations to app_executor;
create policy staff_workspace_creations_scope on app.staff_workspace_creations to app_executor
    using (root_organization_id = app.context_uuid_v1('app.organization_id'))
    with check (root_organization_id = app.context_uuid_v1('app.organization_id')
        and actor_user_id = app.context_uuid_v1('app.actor_id'));


-- The migration operator seeds the immutable roots exactly once. No runtime role
-- can insert, update or delete an allowlist entry, including customer admins.
reset role;
set local row_security = off;
insert into app.permissions(key, description, introduced_version)
values ('workspaces.create', 'Provision an invitation-only customer workspace (platform administrators only)', 1);
insert into app.platform_workspace_roots(organization_id)
select id from app.organizations;
insert into app.role_permissions(organization_id, role_id, permission_key)
select r.organization_id, r.id, 'workspaces.create'
from app.roles r join app.platform_workspace_roots roots on roots.organization_id = r.organization_id
where r.system_kind = 'admin' and r.status = 'active';
set local row_security = on;
set local role app_owner;

-- Preserve the current minimized audit-action allowlist and add one root event.
do $$
declare constraint_name text; definition text;
begin
    select conname, pg_get_constraintdef(oid) into strict constraint_name, definition
    from pg_constraint
    where conrelid = 'app.audit_events'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%staff.membership.changed%';
    execute format('alter table app.audit_events drop constraint %I', constraint_name);
    execute format(
        'alter table app.audit_events add constraint %I check ((%s) or (action = ''workspace.created'' and actor_kind = ''staff'' and target_type = ''organization'' and details - array[''organization_id''] = ''{}''::jsonb and details->>''organization_id'' = target_id::text))',
        constraint_name, substring(definition from 7)
    );
end
$$;

grant usage, create on schema app to app_workspace_provisioner;
grant execute on function app.valid_domain_list_v1(text[]) to app_workspace_provisioner;
grant execute on function app.staff_time_zone_valid_v1(text) to app_workspace_provisioner;
grant insert(id, key, name, status, staff_invite_domains) on app.organizations to app_workspace_provisioner;
grant insert(id, display_name, status) on app.users to app_workspace_provisioner;
grant insert(id, organization_id, key, name, status, system_kind) on app.roles to app_workspace_provisioner;
grant insert(organization_id, role_id, permission_key) on app.role_permissions to app_workspace_provisioner;
grant insert(id, organization_id, user_id, role_id, status, invited_email) on app.organization_memberships to app_workspace_provisioner;
grant insert(id, organization_id, key, name, status) on app.pipelines to app_workspace_provisioner;
grant insert(id, organization_id, pipeline_id, key, label, kind, position, is_initial) on app.pipeline_stages to app_workspace_provisioner;
grant select(key, retired_at) on app.permissions to app_workspace_provisioner;
create policy workspace_provision_org on app.organizations for insert to app_workspace_provisioner
    with check (id = nullif(current_setting('app.workspace_provision_org', true), '')::uuid);
create policy workspace_provision_user on app.users for insert to app_workspace_provisioner
    with check (id = nullif(current_setting('app.workspace_provision_user', true), '')::uuid);
create policy workspace_provision_roles on app.roles for insert to app_workspace_provisioner
    with check (organization_id = nullif(current_setting('app.workspace_provision_org', true), '')::uuid);
create policy workspace_provision_permissions on app.role_permissions for insert to app_workspace_provisioner
    with check (organization_id = nullif(current_setting('app.workspace_provision_org', true), '')::uuid
        and permission_key <> 'workspaces.create');
create policy workspace_provision_membership on app.organization_memberships for insert to app_workspace_provisioner
    with check (organization_id = nullif(current_setting('app.workspace_provision_org', true), '')::uuid
        and user_id = nullif(current_setting('app.workspace_provision_user', true), '')::uuid
        and status = 'invited');
create policy workspace_provision_pipeline on app.pipelines for insert to app_workspace_provisioner
    with check (organization_id = nullif(current_setting('app.workspace_provision_org', true), '')::uuid);
create policy workspace_provision_stages on app.pipeline_stages for insert to app_workspace_provisioner
    with check (organization_id = nullif(current_setting('app.workspace_provision_org', true), '')::uuid);
create policy workspace_provision_permission_registry on app.permissions for select to app_workspace_provisioner
    using (retired_at is null);

set local role app_workspace_provisioner;
create function app.staff_workspace_provision_v1(p_org uuid, p_name text, p_email text)
returns void language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    invited_user uuid := gen_random_uuid();
    admin_role uuid := gen_random_uuid();
    recruiter_role uuid := gen_random_uuid();
    viewer_role uuid := gen_random_uuid();
    pipeline uuid := gen_random_uuid();
begin
    perform set_config('app.workspace_provision_org', p_org::text, true),
        set_config('app.workspace_provision_user', invited_user::text, true);
    insert into app.organizations(id, key, name, status, staff_invite_domains)
    values (p_org, 'workspace-' || p_org::text, p_name, 'active', array[split_part(p_email, '@', 2)]);
    insert into app.users(id, display_name, status)
    values (invited_user, 'Invited workspace administrator', 'active');
    insert into app.roles(id, organization_id, key, name, status, system_kind) values
        (admin_role, p_org, 'admin', 'Admin', 'active', 'admin'),
        (recruiter_role, p_org, 'recruiter', 'Recruiter', 'active', 'recruiter'),
        (viewer_role, p_org, 'viewer', 'Viewer', 'inactive', 'viewer');
    -- Constant defaults are independent of mutable platform business data.
    insert into app.role_permissions(organization_id, role_id, permission_key)
    select p_org, admin_role, key from app.permissions
    where key = any(array[
        'applications.read','applications.stage','audit.read','candidates.merge',
        'candidates.read','candidates.write','clients.read','clients.write',
        'collaboration.read','collaboration.write','data.export','documents.download',
        'documents.write','duplicates.review','jobs.read','jobs.write',
        'organization.manage','pipelines.manage','privacy.manage','roles.manage','staff.manage'
    ]) and retired_at is null;
    insert into app.role_permissions(organization_id, role_id, permission_key)
    select p_org, recruiter_role, key from app.permissions
    where key = any(array[
        'applications.read','applications.stage','candidates.read','candidates.write',
        'clients.read','clients.write','collaboration.read','collaboration.write',
        'documents.download','documents.write','duplicates.review','jobs.read','jobs.write'
    ]) and retired_at is null;
    insert into app.role_permissions(organization_id, role_id, permission_key)
    select p_org, viewer_role, key from app.permissions
    where key = any(array['applications.read','candidates.read','clients.read','collaboration.read','jobs.read'])
        and retired_at is null;
    insert into app.organization_memberships(id, organization_id, user_id, role_id, status, invited_email)
    values (gen_random_uuid(), p_org, invited_user, admin_role, 'invited', p_email);
    insert into app.pipelines(id, organization_id, key, name, status)
    values (pipeline, p_org, 'default', 'Default recruitment', 'active');
    insert into app.pipeline_stages(id, organization_id, pipeline_id, key, label, kind, position, is_initial)
    select gen_random_uuid(), p_org, pipeline, stage.key, stage.label, stage.kind, stage.position, stage.is_initial
    from (values
        ('review','Review','active',0,true),
        ('initial_screen','Initial screen','active',1,false),
        ('interview','Interview','active',2,false),
        ('offer','Offer','active',3,false),
        ('hired','Hired','hired',4,false),
        ('rejected','Rejected','rejected',5,false)
    ) stage(key,label,kind,position,is_initial);
    perform set_config('app.workspace_provision_org', '', true),
        set_config('app.workspace_provision_user', '', true);
exception when others then
    perform set_config('app.workspace_provision_org', '', true),
        set_config('app.workspace_provision_user', '', true);
    raise;
end
$$;
revoke all on function app.staff_workspace_provision_v1(uuid,text,text) from public;
grant execute on function app.staff_workspace_provision_v1(uuid,text,text) to app_executor;

set local role app_owner;
revoke create on schema app from app_workspace_provisioner;
grant create on schema app to app_executor;
set local role app_executor;
create function app.staff_workspace_platform_actor_v1(p_operation uuid, p_write boolean)
returns uuid language plpgsql volatile
set search_path = pg_catalog, app, pg_temp
as $$
declare member uuid;
begin
    member := app.recruitment_actor_v1(array['workspaces.create'], p_operation, gen_random_uuid(), p_write);
    if not exists (
        select 1 from app.platform_workspace_roots
        where organization_id = app.context_uuid_v1('app.organization_id')
    ) or not exists (
        select 1 from app.organization_memberships m
        join app.roles r on r.organization_id = m.organization_id and r.id = m.role_id
        where m.id = member and m.status = 'active' and r.status = 'active' and r.system_kind = 'admin'
    ) then
        raise exception 'Platform root administrator required' using errcode = '42501';
    end if;
    return member;
end
$$;
revoke all on function app.staff_workspace_platform_actor_v1(uuid,boolean) from public;

create function app.staff_workspace_create_v1(p_operation uuid, p_name text, p_admin_email text)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    root_org uuid := app.context_uuid_v1('app.organization_id');
    actor uuid := app.context_uuid_v1('app.actor_id');
    member uuid;
    workspace_name text := btrim(coalesce(p_name, ''));
    admin_email text := lower(btrim(coalesce(p_admin_email, '')));
    digest bytea;
    receipt app.staff_workspace_creations;
    new_org uuid := gen_random_uuid();
begin
    member := app.staff_workspace_platform_actor_v1(p_operation, true);
    if char_length(workspace_name) not between 2 and 80 or workspace_name ~ '[[:cntrl:]]'
        or char_length(admin_email) > 320 or admin_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
        or not app.valid_domain_list_v1(array[split_part(admin_email, '@', 2)]) then
        raise exception 'Invalid workspace invitation' using errcode = '22023';
    end if;
    digest := sha256(convert_to(jsonb_build_object('name',workspace_name,'adminEmail',admin_email)::text, 'UTF8'));
    select * into receipt from app.staff_workspace_creations
    where root_organization_id = root_org and operation_id = p_operation;
    if found then
        if receipt.actor_user_id <> actor or receipt.request_digest <> digest then
            raise exception 'Workspace operation changed' using errcode = '40001';
        end if;
        return jsonb_build_object('organizationId',receipt.organization_id,'name',receipt.name,
            'adminEmail',receipt.admin_email,'invitationPath','/staff/workspaces?workspace=' || receipt.organization_id::text,'created',false);
    end if;
    if (select count(*) from app.staff_workspace_creations where root_organization_id = root_org) >= 100 then
        raise exception 'Platform workspace capacity reached' using errcode = '53300';
    end if;
    perform app.staff_workspace_provision_v1(new_org, workspace_name, admin_email);
    insert into app.staff_workspace_creations(root_organization_id, operation_id, actor_user_id,
        request_digest, organization_id, name, admin_email)
    values (root_org, p_operation, actor, digest, new_org, workspace_name, admin_email);
    insert into app.audit_events(id, organization_id, actor_kind, actor_user_id, actor_membership_id,
        action, target_type, target_id, correlation_id, occurred_at, details)
    values (gen_random_uuid(), root_org, 'staff', actor, member, 'workspace.created', 'organization',
        new_org, p_operation, clock_timestamp(), jsonb_build_object('organization_id',new_org));
    return jsonb_build_object('organizationId',new_org,'name',workspace_name,'adminEmail',admin_email,
        'invitationPath','/staff/workspaces?workspace=' || new_org::text,'created',true);
end
$$;
revoke all on function app.staff_workspace_create_v1(uuid,text,text) from public;
grant execute on function app.staff_workspace_create_v1(uuid,text,text) to app_staff;

create function app.staff_workspace_provisioning_status_v1()
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare records jsonb;
begin
    begin
        perform app.staff_workspace_platform_actor_v1(null, false);
    exception when insufficient_privilege then
        return jsonb_build_object('canCreate',false,'created','[]'::jsonb);
    end;
    select coalesce(jsonb_agg(jsonb_build_object('organizationId',organization_id,'name',name,
        'adminEmail',admin_email,'invitationPath','/staff/workspaces?workspace=' || organization_id::text,
        'createdAt',created_at) order by created_at desc,organization_id),'[]') into records
    from app.staff_workspace_creations
    where root_organization_id = app.context_uuid_v1('app.organization_id');
    return jsonb_build_object('canCreate',true,'created',records);
end
$$;
revoke all on function app.staff_workspace_provisioning_status_v1() from public;
grant execute on function app.staff_workspace_provisioning_status_v1() to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
