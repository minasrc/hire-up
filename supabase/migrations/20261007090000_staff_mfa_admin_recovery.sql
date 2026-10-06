begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local role app_owner;

-- Runtime staff still have no direct table access. Only the reset procedure
-- uses these cross-member policies, and only within the acting organization.
create policy executor_totp_admin_select on app.totp_credentials for select to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('staff.manage'));
create policy executor_totp_admin_revoke on app.totp_credentials for update to app_executor
    using (organization_id = app.context_uuid_v1('app.organization_id')
        and app.has_permission_v1('staff.manage'))
    with check (organization_id = app.context_uuid_v1('app.organization_id')
        and status = 'revoked' and app.has_permission_v1('staff.manage'));

do $$
declare v_predicate text;
begin
    select pg_catalog.pg_get_expr(conbin, conrelid) into strict v_predicate
    from pg_catalog.pg_constraint
    where conrelid = 'app.audit_events'::regclass and conname = 'audit_events_action_check';
    alter table app.audit_events drop constraint audit_events_action_check;
    execute format('alter table app.audit_events add constraint audit_events_action_check check ((%s) or (
        actor_kind = ''staff'' and target_type = ''organization_membership'' and target_id is not null
        and action = ''staff.mfa.reset''
        and details - array[''reason'', ''previous_version'', ''new_version'', ''revoked_credentials''] = ''{}''::jsonb))', v_predicate);
end
$$;

grant create on schema app to app_executor;
set local role app_executor;
create function app.reset_staff_mfa_v1(
    p_membership uuid, p_version bigint, p_reason text,
    p_actor_credential uuid, p_counter bigint, p_audit uuid, p_correlation uuid
)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_actor uuid := app.context_uuid_v1('app.actor_id');
    v_member uuid;
    v_target app.organization_memberships%rowtype;
    v_count integer;
begin
    -- Match the organization lock used by enrollment and membership writes.
    v_member := app.totp_actor_v1(true);
    if not app.has_permission_v1('staff.manage') then
        raise exception 'Staff management required' using errcode = '42501';
    end if;
    if p_membership is null or p_version is null or p_version < 1
        or p_reason is null or p_reason not in ('lost_authenticator', 'compromised_device')
        or p_actor_credential is null or p_counter is null
        or p_audit is null or p_correlation is null then
        raise exception 'Invalid reset input' using errcode = '22023';
    end if;
    select * into v_target from app.organization_memberships
        where organization_id = v_org and id = p_membership for update;
    if not found then raise exception 'Member not found' using errcode = 'P0002'; end if;
    if v_target.user_id = v_actor then
        raise exception 'Cannot reset your own authenticator' using errcode = '42501';
    end if;
    if v_target.status <> 'active' then
        raise exception 'Active member required' using errcode = '23514';
    end if;
    if v_target.version <> p_version then
        raise exception 'Membership changed' using errcode = '40001';
    end if;
    -- The server verifies the fresh code. Counter ownership and replay are
    -- enforced here in the same transaction as the reset, never separately.
    perform app.totp_record_use_v1(p_actor_credential, p_counter, gen_random_uuid(), p_correlation);
    update app.totp_credentials set status = 'revoked', revoked_at = clock_timestamp()
        where organization_id = v_org and user_id = v_target.user_id
        and status in ('pending', 'active');
    get diagnostics v_count = row_count;
    if v_count = 0 then
        raise exception 'No credential to reset' using errcode = '23514';
    end if;
    update app.organization_memberships set version = version + 1, updated_at = clock_timestamp()
        where organization_id = v_org and id = p_membership;
    insert into app.audit_events (id, organization_id, actor_kind, actor_user_id,
        actor_membership_id, action, target_type, target_id, correlation_id, occurred_at, details)
    values (p_audit, v_org, 'staff', v_actor, v_member, 'staff.mfa.reset',
        'organization_membership', p_membership, p_correlation, clock_timestamp(),
        jsonb_build_object('reason', p_reason, 'previous_version', p_version,
            'new_version', p_version + 1, 'revoked_credentials', v_count));
    return jsonb_build_object('membershipId', p_membership, 'version', p_version + 1);
end
$$;
revoke all on function app.reset_staff_mfa_v1(uuid, bigint, text, uuid, bigint, uuid, uuid) from public;
grant execute on function app.reset_staff_mfa_v1(uuid, bigint, text, uuid, bigint, uuid, uuid) to app_staff;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
