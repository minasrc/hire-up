begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local role app_owner;
alter table app.telegram_chat_removals add column storage_pending boolean not null default false,
    add column storage_due_at timestamptz,
    add column storage_served_at timestamptz;
-- A private queue hint avoids scanning objects under another owner's RLS
-- context, and prevents offline device-only removals from starving file cleanup.
reset role;
update app.telegram_chat_removals removal set storage_due_at = (select min(cleanup.available_at) from app.telegram_chat_removal_objects object join app.telegram_upload_cleanup cleanup using(organization_id,owner_user_id,object_key) where object.removal_id=removal.id), storage_pending = exists(
    select 1 from app.telegram_chat_removal_objects object
    join app.telegram_upload_cleanup cleanup on cleanup.object_key = object.object_key
        and cleanup.organization_id = object.organization_id and cleanup.owner_user_id = object.owner_user_id
    where object.removal_id = removal.id
);
do $$
declare existing record;
begin
    select * into existing from pg_catalog.pg_roles where rolname = 'app_telegram_reference_reader';
    if found then
        if existing.rolcanlogin or existing.rolinherit or existing.rolsuper or existing.rolbypassrls
            or existing.rolcreatedb or existing.rolcreaterole or existing.rolreplication then
            raise exception 'Unsafe Telegram reference reader role';
        end if;
    else
        create role app_telegram_reference_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
    end if;
    if exists(select 1 from pg_catalog.pg_auth_members where member =
        (select oid from pg_catalog.pg_roles where rolname = 'app_telegram_reference_reader')) then
        raise exception 'Telegram reference reader must not inherit other roles';
    end if;
    if not (select rolsuper from pg_catalog.pg_roles where rolname = session_user) then
        execute format('grant app_telegram_reference_reader to %I with set true, inherit false', session_user);
    end if;
end
$$;
set local role app_owner;
grant usage on schema app to app_telegram_reference_reader;
grant select (organization_id, document) on app.telegram_drafts to app_telegram_reference_reader;
grant select (organization_id, backend_key, bucket, object_key) on app.blob_locations to app_telegram_reference_reader;
grant select (id), update (id) on app.organizations to app_telegram_reference_reader;
create policy telegram_private_reference_drafts on app.telegram_drafts to app_telegram_reference_reader
    using (organization_id = nullif(current_setting('app.telegram_reference_org', true), '')::uuid
        and document->>'objectKey' = current_setting('app.telegram_reference_key', true));
create policy telegram_private_reference_blobs on app.blob_locations to app_telegram_reference_reader
    using (organization_id = nullif(current_setting('app.telegram_reference_org', true), '')::uuid
        and object_key = current_setting('app.telegram_reference_key', true)
        and backend_key = 'supabase_storage' and bucket = 'cv-submissions');
create policy telegram_private_reference_org on app.organizations to app_telegram_reference_reader
    using (id = nullif(current_setting('app.telegram_reference_org', true), '')::uuid);
grant select (organization_id, object_key, state) on app.telegram_upload_cleanup to app_telegram_reference_reader;
grant select (organization_id, object_key) on app.telegram_chat_removal_objects to app_telegram_reference_reader;
create policy telegram_private_reference_cleanup on app.telegram_upload_cleanup to app_telegram_reference_reader
    using (organization_id = nullif(current_setting('app.telegram_reference_org', true), '')::uuid
        and object_key = current_setting('app.telegram_reference_key', true));
create policy telegram_private_reference_tombstone on app.telegram_chat_removal_objects to app_telegram_reference_reader
    using (organization_id = nullif(current_setting('app.telegram_reference_org', true), '')::uuid
        and object_key = current_setting('app.telegram_reference_key', true));
grant create on schema app to app_telegram_reference_reader;
set local role app_telegram_reference_reader;
create function app.telegram_private_reference_v1(p_org uuid, p_key text, p_lock boolean default false)
returns boolean language plpgsql security definer set search_path = pg_catalog, app, pg_temp as $$
declare result boolean; prior_org text := current_setting('app.telegram_reference_org', true);
    prior_key text := current_setting('app.telegram_reference_key', true);
begin
    perform set_config('app.telegram_reference_org', p_org::text, true),
        set_config('app.telegram_reference_key', coalesce(p_key, ''), true);
    if p_lock then perform id from app.organizations where id = p_org for share; end if;
    select exists(select 1 from app.telegram_drafts where organization_id = p_org and document->>'objectKey' = p_key)
        or exists(select 1 from app.blob_locations where organization_id = p_org
            and backend_key = 'supabase_storage' and bucket = 'cv-submissions' and object_key = p_key) into result;
    perform set_config('app.telegram_reference_org', coalesce(prior_org, ''), true),
        set_config('app.telegram_reference_key', coalesce(prior_key, ''), true);
    return result;
exception when others then
    perform set_config('app.telegram_reference_org', coalesce(prior_org, ''), true),
        set_config('app.telegram_reference_key', coalesce(prior_key, ''), true);
    raise;
end $$;
revoke all on function app.telegram_private_reference_v1(uuid,text,boolean) from public;
grant execute on function app.telegram_private_reference_v1(uuid,text,boolean) to app_executor;
create function app.telegram_private_deleted_key_v1(p_org uuid, p_key text)
returns boolean language plpgsql security definer set search_path = pg_catalog, app, pg_temp as $$
declare result boolean; prior_org text := current_setting('app.telegram_reference_org', true);
    prior_key text := current_setting('app.telegram_reference_key', true);
begin
    perform set_config('app.telegram_reference_org', p_org::text, true),
        set_config('app.telegram_reference_key', p_key, true);
    select exists(select 1 from app.telegram_upload_cleanup where organization_id=p_org and object_key=p_key and state='deleting')
        or exists(select 1 from app.telegram_chat_removal_objects where organization_id=p_org and object_key=p_key) into result;
    perform set_config('app.telegram_reference_org', coalesce(prior_org, ''), true),
        set_config('app.telegram_reference_key', coalesce(prior_key, ''), true);
    return result;
exception when others then
    perform set_config('app.telegram_reference_org', coalesce(prior_org, ''), true),
        set_config('app.telegram_reference_key', coalesce(prior_key, ''), true);
    raise;
end $$;
revoke all on function app.telegram_private_deleted_key_v1(uuid,text) from public;
grant execute on function app.telegram_private_deleted_key_v1(uuid,text) to app_executor;
set local role app_owner;
revoke create on schema app from app_telegram_reference_reader;
grant create on schema app to app_executor;
grant trigger on app.telegram_chat_removal_objects, app.telegram_upload_cleanup, app.blob_locations to app_executor;
set local role app_executor;

-- New bindings cannot race a committed deleting fence or reuse a removed
-- object key. Existing approved locations may still change unrelated metadata.
create function app.telegram_removed_blob_binding_guard_v1() returns trigger
language plpgsql security definer set search_path = pg_catalog, app, pg_temp as $$
begin
    if tg_op='UPDATE' and new.organization_id=old.organization_id and new.object_key=old.object_key
        and new.backend_key=old.backend_key and new.bucket=old.bucket then return new; end if;
    if new.backend_key='supabase_storage' and new.bucket='cv-submissions' then
        perform app.telegram_private_reference_v1(new.organization_id, null, true);
        if app.telegram_private_deleted_key_v1(new.organization_id, new.object_key) then
            raise exception 'Private object removal already requested' using errcode='40001';
        end if;
    end if;
    return new;
end $$;
revoke all on function app.telegram_removed_blob_binding_guard_v1() from public;
create trigger telegram_removed_blob_binding before insert or update of organization_id,object_key,backend_key,bucket
    on app.blob_locations for each row execute function app.telegram_removed_blob_binding_guard_v1();

create function app.telegram_removal_storage_hint_v1() returns trigger
language plpgsql security definer set search_path = pg_catalog, app, pg_temp as $$
declare prior_actor text := current_setting('app.actor_id', true);
    prior_org text := current_setting('app.organization_id', true);
begin
    -- Scope from the row itself: migration seeds and queue insert order must
    -- produce the same hint as runtime writes.
    perform set_config('app.actor_id', coalesce(new.owner_user_id, old.owner_user_id)::text, true),
        set_config('app.organization_id', coalesce(new.organization_id, old.organization_id)::text, true);
    update app.telegram_chat_removals removal set
        storage_pending = exists(select 1 from app.telegram_chat_removal_objects object
            join app.telegram_upload_cleanup cleanup using (organization_id, owner_user_id, object_key)
            where object.removal_id = removal.id),
        storage_due_at = (select min(cleanup.available_at) from app.telegram_chat_removal_objects object
            join app.telegram_upload_cleanup cleanup using (organization_id, owner_user_id, object_key)
            where object.removal_id = removal.id)
    where removal.id in(select object.removal_id from app.telegram_chat_removal_objects object
        where object.organization_id = coalesce(new.organization_id, old.organization_id)
            and object.owner_user_id = coalesce(new.owner_user_id, old.owner_user_id)
            and object.object_key = coalesce(new.object_key, old.object_key));
    perform set_config('app.actor_id', coalesce(prior_actor, ''), true),
        set_config('app.organization_id', coalesce(prior_org, ''), true);
    return null;
end
$$;
revoke all on function app.telegram_removal_storage_hint_v1() from public;
create trigger telegram_removal_storage_added after insert on app.telegram_chat_removal_objects
    for each row execute function app.telegram_removal_storage_hint_v1();
create trigger telegram_removal_storage_deleted after insert or update of available_at or delete on app.telegram_upload_cleanup
    for each row execute function app.telegram_removal_storage_hint_v1();

create function app.telegram_hosted_proof_v1(service uuid, instance uuid, proof uuid)
returns void language plpgsql set search_path = pg_catalog, app, pg_temp as $$
begin
    perform set_config('app.hosted_service_id', service::text, true);
    perform 1 from app.telegram_hosted_services where service_id = service and instance_id = instance
        and lease_token = proof and lease_expires_at > clock_timestamp();
    if not found then raise exception 'Service lease changed' using errcode = '40001'; end if;
end $$;
revoke all on function app.telegram_hosted_proof_v1(uuid,uuid,uuid) from public;

-- The service can execute bounded, already-authorized cleanup. It cannot
-- choose owners, retention decisions, messages or storage destinations.
create function app.telegram_hosted_maintenance_v1(service uuid, instance uuid, proof uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp as $$
begin
    perform app.telegram_hosted_proof_v1(service, instance, proof);
    return app.telegram_maintenance_v1(1) || jsonb_build_object('nextMaintenanceAfterSeconds', coalesce((select greatest(5, least(300, ceil(extract(epoch from min(r.storage_due_at) - clock_timestamp()))::integer)) from app.telegram_chat_removals r where r.completed_at is null and r.storage_pending), 300), 'retiredVaultActionable', false, 'removalActionable', exists(
        select 1 from app.telegram_chat_removals r where r.completed_at is null
            and (r.server_purged_at is null or (r.device_cleanup_at is not null and not r.storage_pending) or (r.storage_pending and r.storage_due_at <= clock_timestamp()))
    ));
end
$$;

-- Only private objects recorded by explicit conversation removal are eligible.
-- Commit the deleting fence before talking to storage; a lost response leaves
-- a retryable record and can never authorize deleting an approved document.
create function app.telegram_hosted_storage_claim_v1(service uuid, instance uuid, proof uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp as $$
declare
    removal record;
    object record;
    result jsonb := '[]';
    prior_actor text := current_setting('app.actor_id', true);
    prior_org text := current_setting('app.organization_id', true);
begin
    perform app.telegram_hosted_proof_v1(service, instance, proof);
    for removal in
        select r.id, r.organization_id, r.owner_user_id
        from app.telegram_chat_removals r
        where r.completed_at is null and r.server_purged_at is not null and r.storage_pending and r.storage_due_at <= clock_timestamp()
            and exists(select 1 from app.telegram_hosted_requests enrollment
                where enrollment.service_id = service and enrollment.organization_id = r.organization_id
                    and enrollment.owner_user_id = r.owner_user_id)
        order by r.storage_served_at nulls first, r.storage_due_at, r.id limit 1
    loop
        perform app.telegram_private_reference_v1(removal.organization_id, null, true);
        perform app.telegram_hosted_lease_v1(service, instance, proof);
        perform set_config('app.actor_id', removal.owner_user_id::text, true),
            set_config('app.organization_id', removal.organization_id::text, true);
        update app.telegram_chat_removals set storage_served_at = clock_timestamp() where id = removal.id;
        for object in
            select cleanup.object_key from app.telegram_upload_cleanup cleanup
            join app.telegram_chat_removal_objects removed on removed.object_key = cleanup.object_key
                and removed.organization_id = cleanup.organization_id and removed.owner_user_id = cleanup.owner_user_id
            where removed.removal_id = removal.id and cleanup.available_at <= clock_timestamp()
                and cleanup.object_key ~ ('^staff/' || removal.organization_id || '/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|docx)$')
            order by cleanup.created_at, cleanup.object_key
            limit greatest(0, 2 - jsonb_array_length(result))
            for update of cleanup skip locked
        loop
            if object.object_key !~ ('^staff/' || removal.organization_id || '/[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|docx)$') then continue; end if;
            if app.telegram_private_reference_v1(removal.organization_id, object.object_key) then
                -- A retained approved/shared copy is separately managed. Only
                -- disposition its cleanup record; never call storage.remove.
                delete from app.telegram_upload_cleanup where object_key = object.object_key;
                continue;
            end if;
            update app.telegram_upload_cleanup set state = 'deleting' where object_key = object.object_key;
            result := result || jsonb_build_array(jsonb_build_object('organizationId', removal.organization_id,
                'ownerUserId', removal.owner_user_id, 'removalId', removal.id, 'objectKey', object.object_key));
        end loop;
        perform app.telegram_chat_removal_step_v1((select chat_id from app.telegram_chat_removals where id = removal.id));
        exit when jsonb_array_length(result) >= 2;
    end loop;
    perform set_config('app.actor_id', coalesce(prior_actor, ''), true), set_config('app.organization_id', coalesce(prior_org, ''), true);
    return result;
end
$$;

create function app.telegram_hosted_storage_finish_v1(service uuid, instance uuid, proof uuid, p_removal uuid, p_key text, p_removed boolean default true)
returns boolean language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp as $$
declare
    removal app.telegram_chat_removals;
    finished boolean;
    prior_actor text := current_setting('app.actor_id', true);
    prior_org text := current_setting('app.organization_id', true);
begin
    perform app.telegram_hosted_proof_v1(service, instance, proof);
    select r.* into removal from app.telegram_chat_removals r where r.id = p_removal
        and exists(select 1 from app.telegram_hosted_requests enrollment
            where enrollment.service_id = service and enrollment.organization_id = r.organization_id
                and enrollment.owner_user_id = r.owner_user_id);
    if not found or removal.server_purged_at is null then return false; end if;
    perform app.telegram_private_reference_v1(removal.organization_id, null, true);
    perform app.telegram_hosted_lease_v1(service, instance, proof);
    perform set_config('app.actor_id', removal.owner_user_id::text, true), set_config('app.organization_id', removal.organization_id::text, true);
    if not p_removed then
        update app.telegram_upload_cleanup cleanup set available_at = clock_timestamp() + interval '60 seconds'
            where cleanup.object_key = p_key and cleanup.state = 'deleting'
                and exists(select 1 from app.telegram_chat_removal_objects removed where removed.removal_id = p_removal
                    and removed.object_key = cleanup.object_key);
        finished := found;
        perform set_config('app.actor_id', coalesce(prior_actor, ''), true), set_config('app.organization_id', coalesce(prior_org, ''), true);
        return finished;
    end if;
    delete from app.telegram_upload_cleanup cleanup where cleanup.object_key = p_key and cleanup.state = 'deleting'
        and exists(select 1 from app.telegram_chat_removal_objects removed where removed.removal_id = p_removal
            and removed.object_key = cleanup.object_key and removed.organization_id = cleanup.organization_id and removed.owner_user_id = cleanup.owner_user_id);
    finished := found;
    if finished then perform app.telegram_chat_removal_step_v1(removal.chat_id); end if;
    perform set_config('app.actor_id', coalesce(prior_actor, ''), true), set_config('app.organization_id', coalesce(prior_org, ''), true);
    return finished;
end
$$;

revoke all on function app.telegram_hosted_maintenance_v1(uuid,uuid,uuid),
    app.telegram_hosted_storage_claim_v1(uuid,uuid,uuid),
    app.telegram_hosted_storage_finish_v1(uuid,uuid,uuid,uuid,text,boolean) from public;
grant execute on function app.telegram_hosted_maintenance_v1(uuid,uuid,uuid),
    app.telegram_hosted_storage_claim_v1(uuid,uuid,uuid),
    app.telegram_hosted_storage_finish_v1(uuid,uuid,uuid,uuid,text,boolean) to app_telegram_hosted_service;
set local role app_owner;
revoke trigger on app.telegram_chat_removal_objects, app.telegram_upload_cleanup, app.blob_locations from app_executor;
revoke create on schema app from app_executor;
commit;
