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
        execute format('grant app_executor, app_authz_reader to %I with set true, inherit false', session_user);
    end if;
end
$$;
set local role app_owner;
create function app.staff_time_zone_valid_v1(p_zone text)
returns boolean language sql stable security invoker
set search_path = pg_catalog, pg_temp
as $$
    select p_zone is null or (
        char_length(p_zone) between 1 and 100
        and p_zone ~ '^(UTC|[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)+)$'
        and exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zone)
    )
$$;
revoke all on function app.staff_time_zone_valid_v1(text) from public;
grant execute on function app.staff_time_zone_valid_v1(text) to app_executor;
alter table app.users
    add column time_zone text,
    add column time_zone_version bigint not null default 0,
    add constraint users_time_zone_valid check (app.staff_time_zone_valid_v1(time_zone)),
    add constraint users_time_zone_version_nonnegative check (time_zone_version >= 0);
grant update (time_zone, time_zone_version) on app.users to app_executor;
create policy executor_users_time_zone_update on app.users
    for update to app_executor
    using (id = app.context_uuid_v1('app.actor_id') and status = 'active')
    with check (id = app.context_uuid_v1('app.actor_id') and status = 'active');
grant create on schema app to app_authz_reader;
set local role app_authz_reader;
create or replace function app.resolve_staff_principal_v1(
    p_provider text, p_issuer text, p_subject text, p_organization_id uuid
)
returns table (user_id uuid, membership_id uuid, role_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_user uuid;
    v_membership uuid;
    v_role uuid;
    v_time_zone text;
    v_time_zone_version bigint;
begin
    perform pg_catalog.set_config('app.actor_id', '', true);
    perform pg_catalog.set_config('app.organization_id', '', true);
    perform pg_catalog.set_config('app.identity_provider', '', true);
    perform pg_catalog.set_config('app.identity_issuer', '', true);
    perform pg_catalog.set_config('app.identity_subject', '', true);
    perform pg_catalog.set_config('app.staff_time_zone', '', true);
    perform pg_catalog.set_config('app.staff_time_zone_version', '', true);
    if p_provider = 'google'
        and p_issuer = 'https://accounts.google.com'
        and p_subject ~ '^[1-9][0-9]{0,20}$'
        and p_organization_id is not null then
        perform pg_catalog.set_config('app.identity_provider', p_provider, true);
        perform pg_catalog.set_config('app.identity_issuer', p_issuer, true);
        perform pg_catalog.set_config('app.identity_subject', p_subject, true);
        select ai.user_id into v_user
        from app.auth_identities ai
        where ai.provider = p_provider and ai.issuer = p_issuer
            and ai.provider_subject = p_subject and ai.verified_at is not null
            and ai.revoked_at is null;
        if v_user is not null then
            perform pg_catalog.set_config('app.actor_id', v_user::text, true);
            perform pg_catalog.set_config('app.organization_id', p_organization_id::text, true);
            select m.id, m.role_id, u.time_zone, u.time_zone_version
            into v_membership, v_role, v_time_zone, v_time_zone_version
            from app.organization_memberships m
            join app.users u on u.id = m.user_id
            join app.organizations o on o.id = m.organization_id
            join app.roles r on r.organization_id = m.organization_id and r.id = m.role_id
            where m.user_id = v_user and m.organization_id = p_organization_id
                and u.status = 'active' and o.status = 'active'
                and m.status = 'active' and r.status = 'active'
                and r.system_kind is distinct from 'viewer';
        end if;
    end if;
    perform pg_catalog.set_config('app.actor_id', '', true);
    perform pg_catalog.set_config('app.organization_id', '', true);
    perform pg_catalog.set_config('app.identity_provider', '', true);
    perform pg_catalog.set_config('app.identity_issuer', '', true);
    perform pg_catalog.set_config('app.identity_subject', '', true);
    if v_membership is not null then
        perform pg_catalog.set_config('app.staff_time_zone', coalesce(v_time_zone, ''), true);
        perform pg_catalog.set_config('app.staff_time_zone_version', v_time_zone_version::text, true);
        user_id := v_user;
        membership_id := v_membership;
        role_id := v_role;
        return next;
    end if;
    return;
end
$$;
revoke all on function app.resolve_staff_principal_v1(text, text, text, uuid) from public;
grant execute on function app.resolve_staff_principal_v1(text, text, text, uuid) to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_authz_reader;
do $$
declare v_check text;
begin
    select pg_get_expr(conbin, conrelid) into strict v_check from pg_catalog.pg_constraint
    where conrelid = 'app.audit_events'::regclass and conname = 'audit_events_action_check' and contype = 'c';
    alter table app.audit_events drop constraint audit_events_action_check;
    execute format($check$
        alter table app.audit_events add constraint audit_events_action_check check (
            (%s) or (
                actor_kind = 'staff' and target_type = 'user' and target_id is not null and target_id = actor_user_id
                and action = 'staff.time_zone.changed'
                and details ?& array['previous_version', 'new_version']
                and details - array['previous_version', 'new_version'] = '{}'::jsonb
                and jsonb_typeof(details -> 'previous_version') = 'number'
                and jsonb_typeof(details -> 'new_version') = 'number'
            )
        )
    $check$, v_check);
end
$$;
create function app.set_staff_time_zone_v1(p_zone text, p_expected_version bigint, p_audit_id uuid, p_correlation_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_actor uuid := app.context_uuid_v1('app.actor_id');
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_member uuid;
    v_zone text;
    v_version bigint;
begin
    v_member := app.totp_actor_v1(true);
    if p_expected_version is null or p_expected_version < 0
        or p_audit_id is null or p_correlation_id is null
        or not app.staff_time_zone_valid_v1(p_zone) then
        raise exception 'Invalid time zone preference' using errcode = '22023';
    end if;
    select u.time_zone, u.time_zone_version into v_zone, v_version
    from app.users u where u.id = v_actor and u.status = 'active' for update;
    if not found then raise exception 'Active staff user required' using errcode = '42501'; end if;
    if v_zone is not distinct from p_zone then
        return jsonb_build_object('timeZone', v_zone, 'version', v_version::text);
    end if;
    if v_version <> p_expected_version then
        raise exception 'Preference version changed' using errcode = '40001';
    end if;
    update app.users set time_zone = p_zone, time_zone_version = v_version + 1 where id = v_actor;
    insert into app.audit_events (id, organization_id, actor_kind, actor_user_id, actor_membership_id,
        action, target_type, target_id, correlation_id, occurred_at, details)
    values (p_audit_id, v_org, 'staff', v_actor, v_member, 'staff.time_zone.changed', 'user', v_actor,
        p_correlation_id, pg_catalog.clock_timestamp(), jsonb_build_object('previous_version', v_version, 'new_version', v_version + 1));
    return jsonb_build_object('timeZone', p_zone, 'version', (v_version + 1)::text);
end
$$;
revoke all on function app.set_staff_time_zone_v1(text, bigint, uuid, uuid) from public;
grant execute on function app.set_staff_time_zone_v1(text, bigint, uuid, uuid) to app_staff;
grant create on schema app to app_executor;
reset role;
alter function app.set_staff_time_zone_v1(text, bigint, uuid, uuid) owner to app_executor;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
