begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
set local role app_owner;
-- Notifications contain no enrollment data and confer no database authority.
-- JSON projection permits absent optional state columns without expanding payloads.
create function app.telegram_hosted_wake_notify_v1() returns trigger
language plpgsql set search_path = pg_catalog, app, pg_temp as $$
declare before_row jsonb; after_row jsonb; service uuid;
begin
    if tg_op <> 'INSERT' then before_row := to_jsonb(old); end if;
    if tg_op <> 'DELETE' then after_row := to_jsonb(new); end if;
    if tg_op = 'UPDATE' and
        (before_row->'service_id', before_row->'wake_epoch', before_row->'state', before_row->'worker_id', before_row->'retired_at')
        is not distinct from
        (after_row->'service_id', after_row->'wake_epoch', after_row->'state', after_row->'worker_id', after_row->'retired_at') then return null; end if;
    service := coalesce((after_row->>'service_id')::uuid, (before_row->>'service_id')::uuid);
    perform pg_notify('telegram_hosted_' || replace(service::text, '-', ''), 'wake');
    if tg_op = 'UPDATE' and before_row->>'service_id' is distinct from after_row->>'service_id' then
        perform pg_notify('telegram_hosted_' || replace(before_row->>'service_id', '-', ''), 'wake');
    end if;
    return null;
end $$;
revoke all on function app.telegram_hosted_wake_notify_v1() from public;
create trigger telegram_hosted_wake_notify after insert or update or delete
    on app.telegram_hosted_requests for each row execute function app.telegram_hosted_wake_notify_v1();
-- Wake-only requests must never renew the service lease. The existing bounded
-- list validates the active proof under forced RLS and may maintain worker
-- expiry, but performs no service heartbeat or service lease extension.
grant create on schema app to app_executor;
set local role app_executor;
create function app.telegram_hosted_wake_snapshot_v1(service uuid, instance uuid, proof uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, app, pg_temp as $$
declare snapshot jsonb; item jsonb; epoch bigint; records jsonb := '[]';
begin
    snapshot := app.telegram_hosted_list_v1(service, instance, proof, null);
    for item in select value from jsonb_array_elements(snapshot->'requests') limit 10 loop
        select request.wake_epoch into epoch
            from app.telegram_hosted_requests request
            where request.id = (item->>'requestId')::uuid and request.service_id = service
                and request.retired_at is null;
        if not found then raise exception 'Hosted enrollment changed' using errcode = '40001'; end if;
        records := records || jsonb_build_array(jsonb_build_object(
            'requestId', item->'requestId', 'workerId', item->'workerId',
            'state', item->'state', 'canRun', item->'canRun', 'wakeEpoch', epoch::text));
    end loop;
    return jsonb_build_object('requests', records);
end $$;
revoke all on function app.telegram_hosted_wake_snapshot_v1(uuid,uuid,uuid) from public;
grant execute on function app.telegram_hosted_wake_snapshot_v1(uuid,uuid,uuid) to app_telegram_hosted_service;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
