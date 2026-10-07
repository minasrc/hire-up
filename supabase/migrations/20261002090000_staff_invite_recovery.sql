-- Re-invitations retain the original membership and stable Google identity.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local role app_owner;
grant create on schema app to app_executor;
set local role app_executor;

create or replace function app.invite_staff_member_v1(
    p_user_id uuid,
    p_membership_id uuid,
    p_display_name text,
    p_email text,
    p_role_id uuid,
    p_audit_id uuid,
    p_correlation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_actor uuid := app.context_uuid_v1('app.actor_id');
    v_member uuid;
    v_email text;
    v_role record;
    v_existing record;
    v_domains text[];
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    if v_actor is null or v_org is null then
        raise exception 'staff actor and organization context are required'
            using errcode = '42501';
    end if;
    if p_user_id is null or p_membership_id is null or p_role_id is null
        or p_audit_id is null or p_correlation_id is null then
        raise exception 'invite_staff_member_v1 requires nonnull identifiers'
            using errcode = '22023';
    end if;
    v_email := lower(btrim(coalesce(p_email, '')));
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 320 then
        raise exception 'Invalid invite email' using errcode = '22023';
    end if;
    if p_display_name is null or btrim(p_display_name) = ''
        or char_length(p_display_name) > 256 then
        raise exception 'Invalid display name' using errcode = '22023';
    end if;
    if current_setting('transaction_isolation') <> 'read committed' then
        raise exception 'Read committed required' using errcode = '25001';
    end if;
    select o.staff_invite_domains into v_domains
    from app.organizations o where o.id = v_org for update;
    if not found then
        raise exception 'Organization not found' using errcode = 'P0002';
    end if;
    if not app.has_permission_v1('staff.manage') then
        raise exception 'staff.manage permission is required' using errcode = '42501';
    end if;
    if not exists (
        select 1 from app.organizations o where o.id = v_org and o.status = 'active'
    ) then
        raise exception 'Organization is not active' using errcode = '42501';
    end if;
    select m.id into v_member
    from app.organization_memberships m
    where m.organization_id = v_org and m.user_id = v_actor and m.status = 'active';
    if v_member is null then
        raise exception 'Active membership required' using errcode = '42501';
    end if;
    select r.* into v_role
    from app.roles r
    where r.organization_id = v_org and r.id = p_role_id;
    if not found then
        raise exception 'Role not found' using errcode = 'P0002';
    end if;
    if v_role.status <> 'active' or v_role.system_kind = 'viewer' then
        raise exception 'Invited role must be active and not a viewer role'
            using errcode = '42501';
    end if;
    if coalesce(cardinality(v_domains), 0) > 0
        and not (lower(split_part(v_email, '@', 2)) = any (v_domains)) then
        raise exception 'Invite email domain is not allowed for this organization'
            using errcode = '42501';
    end if;
    -- Older deployments may already contain a duplicate invitation. Do not
    -- revive an archived row alongside an active or pending membership.
    if exists (select 1 from app.organization_memberships m
        where m.organization_id = v_org and lower(m.invited_email) = v_email
            and m.status in ('active', 'invited')) then
        raise exception 'This email already has a membership or pending invite'
            using errcode = '23505';
    end if;
    select m.id, m.user_id, m.status, u.status as user_status into v_existing
    from app.organization_memberships m
    join app.users u on u.id = m.user_id
    where m.organization_id = v_org and lower(m.invited_email) = v_email
    order by m.created_at, m.id
    limit 1 for update of m;
    if found then
        if v_existing.status <> 'revoked' then
            raise exception 'This email already has a membership or pending invite'
                using errcode = '23505';
        end if;
        if v_existing.user_status <> 'active' then
            raise exception 'Disabled users cannot be re-invited' using errcode = '42501';
        end if;
        -- Retain the original user and identity; invitation never restores a
        -- revoked provider credential or binds a different Google subject.
        p_user_id := v_existing.user_id;
        p_membership_id := v_existing.id;
        update app.organization_memberships
            set status = 'invited', role_id = p_role_id, activated_at = null,
                revoked_at = null, updated_at = v_now, version = version + 1
            where id = p_membership_id and organization_id = v_org;
    else
        insert into app.users (id, display_name, status)
        values (p_user_id, btrim(p_display_name), 'active');
        insert into app.organization_memberships (
            id, organization_id, user_id, role_id, status, invited_email
        ) values (p_membership_id, v_org, p_user_id, p_role_id, 'invited', v_email);
    end if;
    insert into app.audit_events (
        id, organization_id, actor_kind, actor_user_id, actor_membership_id,
        action, target_type, target_id, correlation_id, occurred_at, details
    ) values (
        p_audit_id, v_org, 'staff', v_actor, v_member,
        'staff.member.invited', 'organization_membership', p_membership_id,
        p_correlation_id, v_now,
        pg_catalog.jsonb_build_object('user_id', p_user_id, 'role_id', p_role_id)
    );
    return pg_catalog.jsonb_build_object(
        'membershipId', p_membership_id,
        'userId', p_user_id,
        'email', v_email
    );
end
$$;

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
    else
        insert into app.auth_identities (
            id, user_id, provider, issuer, provider_subject, verified_at
        ) values (p_identity_id, v_target.user_id, p_provider, p_issuer, p_subject, v_now);
    end if;
    update app.organization_memberships
        set status = 'active',
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
end
$$;

set local role app_owner;
revoke create on schema app from app_executor;
commit;
