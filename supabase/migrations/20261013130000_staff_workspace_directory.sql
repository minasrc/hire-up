begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare existing record;
begin
    select * into existing from pg_catalog.pg_roles where rolname = 'app_workspace_directory_reader';
    if found then
        if existing.rolsuper or existing.rolcanlogin or existing.rolinherit or existing.rolbypassrls or existing.rolcreaterole
            or existing.rolcreatedb or existing.rolreplication then
            raise exception 'Unsafe workspace directory role';
        end if;
    else
        create role app_workspace_directory_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    end if;
    if exists (select 1 from pg_catalog.pg_auth_members where member = (select oid from pg_catalog.pg_roles where rolname = 'app_workspace_directory_reader')) then
        raise exception 'Workspace directory role must not inherit other roles';
    end if;
    if not (select rolsuper from pg_catalog.pg_roles where rolname = session_user) then
        execute format('grant app_workspace_directory_reader to %I with set true, inherit false', session_user);
        execute format('grant app_executor to %I with set true, inherit false', session_user);
    end if;
end
$$;

set local role app_owner;
grant usage, create on schema app to app_workspace_directory_reader;
grant select(id, name, status, staff_invite_domains) on app.organizations to app_workspace_directory_reader;
grant select(id, status) on app.users to app_workspace_directory_reader;
grant select(id, user_id, provider, issuer, provider_subject, verified_at, revoked_at) on app.auth_identities to app_workspace_directory_reader;
grant select(id, organization_id, user_id, role_id, status, invited_email) on app.organization_memberships to app_workspace_directory_reader;
grant select(id, organization_id, name, status, system_kind) on app.roles to app_workspace_directory_reader;
grant execute on function app.context_uuid_v1(text) to app_workspace_directory_reader;

create policy workspace_directory_organizations on app.organizations for select to app_workspace_directory_reader using (status = 'active');
create policy workspace_directory_users on app.users for select to app_workspace_directory_reader using (true);
create policy workspace_directory_roles on app.roles for select to app_workspace_directory_reader using (status = 'active');
create policy workspace_directory_identities on app.auth_identities for select to app_workspace_directory_reader using (
    provider = pg_catalog.current_setting('app.workspace_provider', true)
    and issuer = pg_catalog.current_setting('app.workspace_issuer', true)
    and provider_subject = pg_catalog.current_setting('app.workspace_subject', true));
create policy workspace_directory_memberships on app.organization_memberships for select to app_workspace_directory_reader using (
    user_id = nullif(pg_catalog.current_setting('app.workspace_user', true), '')::uuid
    or (status = 'invited' and lower(invited_email) = nullif(pg_catalog.current_setting('app.workspace_email', true), '')));

set local role app_workspace_directory_reader;
create function app.staff_workspace_identity_v1(p_provider text, p_issuer text, p_subject text)
returns table(user_id uuid, identity_id uuid, usable boolean)
language plpgsql volatile security definer set search_path = pg_catalog, app, pg_temp
as $$
begin
    if p_provider is distinct from 'google' or p_issuer is distinct from 'https://accounts.google.com'
        or p_subject is null or p_subject !~ '^[1-9][0-9]{0,20}$' then
        raise exception 'Verified Google identity required' using errcode = '42501';
    end if;
    perform set_config('app.workspace_provider', p_provider, true),
        set_config('app.workspace_issuer', p_issuer, true), set_config('app.workspace_subject', p_subject, true);
    return query select i.user_id, i.id, i.revoked_at is null and i.verified_at is not null and u.status = 'active'
        from app.auth_identities i join app.users u on u.id = i.user_id
        where i.provider = p_provider and i.issuer = p_issuer and i.provider_subject = p_subject;
    perform set_config('app.workspace_provider', '', true), set_config('app.workspace_issuer', '', true), set_config('app.workspace_subject', '', true);
exception when others then
    perform set_config('app.workspace_provider', '', true), set_config('app.workspace_issuer', '', true), set_config('app.workspace_subject', '', true);
    raise;
end
$$;
revoke all on function app.staff_workspace_identity_v1(text,text,text) from public;
grant execute on function app.staff_workspace_identity_v1(text,text,text) to app_executor;

create function app.staff_workspace_directory_v1(p_provider text, p_issuer text, p_subject text, p_email text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, app, pg_temp
as $$
declare identity_row record; result jsonb; email text := lower(btrim(coalesce(p_email, '')));
begin
    select * into identity_row from app.staff_workspace_identity_v1(p_provider,p_issuer,p_subject);
    if found and not identity_row.usable then return '[]'::jsonb; end if;
    if length(email) > 320 or (email <> '' and email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
        raise exception 'Invalid verified email' using errcode = '22023';
    end if;
    perform set_config('app.workspace_user', coalesce(identity_row.user_id::text, ''), true), set_config('app.workspace_email', email, true);
    select coalesce(jsonb_agg(jsonb_build_object('organizationId', id, 'name', name, 'roleName', role_name, 'state', status) order by name,id), '[]'::jsonb)
        into result from (
            select o.id, o.name, r.name role_name, m.status
            from app.organization_memberships m
            join app.organizations o on o.id = m.organization_id
            join app.roles r on r.organization_id = m.organization_id and r.id = m.role_id
            join app.users u on u.id = m.user_id
            where o.status = 'active' and r.status = 'active' and r.system_kind is distinct from 'viewer' and u.status = 'active'
                and ((m.status = 'active' and m.user_id = identity_row.user_id)
                    or (m.status = 'invited' and lower(m.invited_email) = email and email <> ''
                        and (coalesce(cardinality(o.staff_invite_domains),0) = 0 or split_part(email,'@',2) = any(o.staff_invite_domains))))
            order by o.name,o.id limit 100
        ) directory;
    perform set_config('app.workspace_user', '', true), set_config('app.workspace_email', '', true);
    return result;
exception when others then
    perform set_config('app.workspace_user', '', true), set_config('app.workspace_email', '', true);
    raise;
end
$$;
revoke all on function app.staff_workspace_directory_v1(text,text,text,text) from public;
grant execute on function app.staff_workspace_directory_v1(text,text,text,text) to app_staff;

set local role app_owner;
revoke create on schema app from app_workspace_directory_reader;
grant create on schema app to app_executor;
set local role app_executor;

-- Invite claim replacement is appended below. A Google identity is global;
-- a second workspace adds membership instead of creating a duplicate identity.

set local role app_owner;
grant update(user_id) on app.organization_memberships to app_executor;
set local role app_executor;

create or replace function app.claim_staff_invite_v1(
    p_identity_id uuid,
    p_provider text,
    p_issuer text,
    p_subject text,
    p_email text,
    p_audit_id uuid,
    p_correlation_id uuid
)
returns table (user_id uuid, membership_id uuid, role_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_email text;
    v_domains text[];
    v_target record;
    v_identity record;
    v_global_identity record;
    v_prior_actor text := current_setting('app.actor_id', true);
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    if v_org is null then
        raise exception 'organization context required' using errcode = '42501';
    end if;
    if p_identity_id is null or p_provider is null or p_issuer is null
        or p_subject is null or p_audit_id is null or p_correlation_id is null then
        raise exception 'claim_staff_invite_v1 requires nonnull identifiers'
            using errcode = '22023';
    end if;
    if p_provider <> 'google'
        or p_issuer <> 'https://accounts.google.com'
        or p_subject !~ '^[1-9][0-9]{0,20}$' then
        raise exception 'Unsupported identity for invite claim' using errcode = '22023';
    end if;
    v_email := lower(btrim(coalesce(p_email, '')));
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
        raise exception 'Invalid invite email' using errcode = '22023';
    end if;
    -- A provider subject is global. Check it even when the target invitation
    -- still belongs to an unbound placeholder user in this organization.
    select * into v_global_identity
    from app.staff_workspace_identity_v1(p_provider, p_issuer, p_subject);
    if found and not v_global_identity.usable then
        raise exception 'Invitation cannot restore an unusable provider identity'
            using errcode = '42501';
    end if;
    select o.staff_invite_domains into v_domains
    from app.organizations o where o.id = v_org for update;
    if not found then
        raise exception 'Organization not found' using errcode = 'P0002';
    end if;
    if not exists (
        select 1 from app.organizations o where o.id = v_org and o.status = 'active'
    ) then
        raise exception 'Organization is not active' using errcode = '42501';
    end if;
    if coalesce(cardinality(v_domains), 0) > 0
        and not (lower(split_part(v_email, '@', 2)) = any (v_domains)) then
        return;
    end if;
    select m.id, m.user_id, m.role_id, m.version into v_target
    from app.organization_memberships m
    join app.users u on u.id = m.user_id
    where m.organization_id = v_org
        and m.status = 'invited'
        and lower(m.invited_email) = v_email
        and u.status = 'active'
    for update of m;
    if not found then
        return;
    end if;
    select i.id, i.provider_subject, i.revoked_at into v_identity
    from app.auth_identities i
    where i.user_id = v_target.user_id and i.provider = p_provider and i.issuer = p_issuer
    order by i.created_at, i.id limit 1;
    if found then
        if v_identity.provider_subject <> p_subject or v_identity.revoked_at is not null then
            raise exception 'Invitation cannot replace or restore a provider identity'
                using errcode = '42501';
        end if;
        p_identity_id := v_identity.id;
    elsif v_global_identity.user_id is not null then
        if exists (
            select 1 from app.organization_memberships m
            where m.organization_id = v_org and m.user_id = v_global_identity.user_id
                and m.id <> v_target.id
        ) then
            raise exception 'Invitation cannot replace an existing membership'
                using errcode = '42501';
        end if;
        -- The membership is the tenant boundary; the verified identity keeps
        -- its existing global user. Never create a duplicate provider identity.
        v_target.user_id := v_global_identity.user_id;
        p_identity_id := v_global_identity.identity_id;
    else
        insert into app.auth_identities (
            id, user_id, provider, issuer, provider_subject, verified_at
        ) values (p_identity_id, v_target.user_id, p_provider, p_issuer, p_subject, v_now);
    end if;
    update app.organization_memberships
        set user_id = v_target.user_id,
            status = 'active',
            activated_at = v_now,
            updated_at = v_now,
            version = v_target.version + 1
        where organization_id = v_org and id = v_target.id;
    -- The audit row belongs to the newly activated member: the executor
    -- audit-insert policy requires actor_user_id to match the context actor.
    perform pg_catalog.set_config('app.actor_id', v_target.user_id::text, true);
    insert into app.audit_events (
        id, organization_id, actor_kind, actor_user_id, actor_membership_id,
        action, target_type, target_id, correlation_id, occurred_at, details
    ) values (
        p_audit_id, v_org, 'staff', v_target.user_id, v_target.id,
        'staff.invite.claimed', 'organization_membership', v_target.id,
        p_correlation_id, v_now,
        pg_catalog.jsonb_build_object('identity_id', p_identity_id)
    );
    user_id := v_target.user_id;
    membership_id := v_target.id;
    role_id := v_target.role_id;
    return next;
    return;
exception when others then
    perform set_config('app.actor_id', coalesce(v_prior_actor, ''), true);
    raise;
end
$$;

revoke all on function app.claim_staff_invite_v1(uuid,text,text,text,text,uuid,uuid) from public;
grant execute on function app.claim_staff_invite_v1(uuid,text,text,text,text,uuid,uuid) to app_staff;
create function app.staff_workspace_name_v1()
returns text language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare workspace_name text;
begin
    select o.name into workspace_name
    from app.organizations o
    join app.organization_memberships m on m.organization_id = o.id
    join app.users u on u.id = m.user_id
    join app.roles r on r.organization_id = m.organization_id and r.id = m.role_id
    where o.id = app.context_uuid_v1('app.organization_id')
        and m.user_id = app.context_uuid_v1('app.actor_id')
        and o.status = 'active' and m.status = 'active'
        and u.status = 'active' and r.status = 'active'
        and r.system_kind is distinct from 'viewer';
    if not found then
        raise exception 'Active workspace membership required' using errcode = '42501';
    end if;
    return workspace_name;
end
$$;
revoke all on function app.staff_workspace_name_v1() from public;
grant execute on function app.staff_workspace_name_v1() to app_staff;

set local role app_owner;
revoke create on schema app from app_executor;
commit;
