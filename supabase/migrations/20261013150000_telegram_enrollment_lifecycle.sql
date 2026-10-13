-- Retire uncertain registrations only by an explicit owner action; keep evidence.
begin;
set local lock_timeout='2s';set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_hosted_requests add column remote_logout_at timestamptz,add column retired_at timestamptz,add column retired_by uuid references app.users(id),add column retired_reason text check(retired_reason in('never_registered','cancelled_before_start','remote_logout','external_revocation_attested')),add column retire_operation uuid unique,add column retire_digest bytea,add column retire_receipt jsonb;
alter table app.telegram_hosted_requests add constraint telegram_hosted_retirement_complete check((retired_at is null and retired_by is null and retired_reason is null and retire_operation is null and retire_digest is null and retire_receipt is null) or (retired_at is not null and retired_by is not null and retired_reason is not null and retire_operation is not null and retire_digest is not null and retire_receipt is not null));
do $$declare c record;begin
 for c in select conname from pg_constraint where conrelid='app.telegram_hosted_requests'::regclass and contype='u' and conkey=array[2,3,4]::smallint[] loop execute format('alter table app.telegram_hosted_requests drop constraint %I',c.conname);end loop;
end $$;
create unique index telegram_hosted_active_owner on app.telegram_hosted_requests(service_id,organization_id,owner_user_id) where retired_at is null;
create index telegram_hosted_active_page on app.telegram_hosted_requests(service_id,id) where retired_at is null;
alter table app.telegram_connections add column retirement_reason text check(retirement_reason in('never_registered','cancelled_before_start','remote_logout','external_revocation_attested'));
grant create on schema app to app_executor;
set local role app_executor;
create function app.telegram_hosted_logout_proof_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 if new.status='requested' then update app.telegram_hosted_requests set remote_logout_at=null where worker_id=new.worker_id and retired_at is null;
 elsif new.status='disconnected' and old.status='disconnecting' and new.retirement_reason is null then update app.telegram_hosted_requests set remote_logout_at=clock_timestamp() where worker_id=new.worker_id and retired_at is null;
 end if;
 return new;
end $$;
reset role;set local role app_owner;
create trigger telegram_hosted_logout_proof after update of status on app.telegram_connections for each row execute function app.telegram_hosted_logout_proof_v1();
-- Existing server-confirmed logout is safe evidence for its exact worker only.
update app.telegram_hosted_requests r set remote_logout_at=c.updated_at from app.telegram_connections c where c.worker_id=r.worker_id and c.status='disconnected' and not c.ever_leased and not c.cancelled_before_start and c.retirement_reason is null;
set local role app_executor;
create function app.telegram_hosted_retirement_mode_v1(p_request uuid) returns text language plpgsql stable security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;c app.telegram_connections;begin
 select * into r from app.telegram_hosted_requests where id=p_request and retired_at is null and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id');
 if not found then return null;end if;
 if r.worker_id is null or r.remote_logout_at is not null then return 'safe';end if;
 select * into c from app.telegram_connections where worker_id=r.worker_id;
 if c.id is not null and c.status='disconnected' and not c.ever_leased and c.retirement_reason is null then return 'safe';end if;
 return 'external_revocation_required';
end $$;
create function app.telegram_hosted_retire_v1(service uuid,p_request uuid,p_worker uuid,p_operation uuid,p_telegram_revoked boolean) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;c app.telegram_connections;reason text;digest bytea;receipt jsonb;tm timestamptz:=clock_timestamp();begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if service is null or p_request is null or p_operation is null or p_telegram_revoked is null then raise exception 'Invalid retirement' using errcode='22023';end if;
 perform set_config('app.hosted_service_id',service::text,true);
 perform 1 from app.telegram_hosted_services where service_id=service for update;
 if not found then raise exception 'Enrollment unavailable' using errcode='P0002';end if;
 select * into r from app.telegram_hosted_requests where id=p_request and service_id=service and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id');
 if not found then raise exception 'Enrollment unavailable' using errcode='P0002';end if;
 digest:=sha256(convert_to(jsonb_build_object('requestId',p_request,'workerId',p_worker,'telegramRevoked',p_telegram_revoked)::text,'UTF8'));
 if r.retired_at is not null then
 if r.retire_operation=p_operation and r.retire_digest=digest then return r.retire_receipt;end if;
 raise exception 'Enrollment changed' using errcode='40001';end if;
 if r.worker_id is distinct from p_worker then raise exception 'Enrollment changed' using errcode='40001';end if;
 -- Match the worker->connection lock order of authenticated worker operations.
 if r.worker_id is not null then perform 1 from app.telegram_workers where id=r.worker_id for update;end if;
 select * into c from app.telegram_connections where worker_id=r.worker_id for update;
 if r.worker_id is null then reason:='never_registered';
 elsif r.remote_logout_at is not null then reason:='remote_logout';
 elsif c.id is not null and c.status='disconnected' and not c.ever_leased and c.retirement_reason is null then reason:=case when c.cancelled_before_start then 'cancelled_before_start' else 'remote_logout' end;
 elsif p_telegram_revoked then reason:='external_revocation_attested';
 else raise exception 'External revocation acknowledgement required' using errcode='55000';end if;
 -- Revoke first. All token-authenticated late claims and reports fail immediately.
 if r.worker_id is not null then update app.telegram_workers set revoked_at=coalesce(revoked_at,tm) where id=r.worker_id;end if;
 if c.id is not null then
 update app.telegram_connections set status='disconnected',generation=generation+1,ever_leased=false,cancelled_before_start=(reason='cancelled_before_start'),retirement_reason=reason,challenge_id=gen_random_uuid(),qr_login_url=null,qr_expires_at=null,password_hint=null,password_ciphertext=null,password_expires_at=null,password_submission_id=null,last_password_submission_id=null,profile=null,error_code=null,lease_token=null,lease_expires_at=null,updated_at=tm where id=c.id;
 end if;
 receipt:=jsonb_build_object('ok',true,'retiredRequestId',r.id,'retirementReason',reason,'retiredAt',tm);
 update app.telegram_hosted_requests set retired_at=tm,retired_by=app.context_uuid_v1('app.actor_id'),retired_reason=reason,retire_operation=p_operation,retire_digest=digest,retire_receipt=receipt where id=r.id;
 return receipt;
end $$;
create or replace function app.telegram_hosted_status_v1(service uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;w app.telegram_workers;online boolean;worker_online boolean:=false;begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform set_config('app.hosted_service_id',service::text,true);
 select coalesce(lease_expires_at>clock_timestamp(),false) into online from app.telegram_hosted_services where service_id=service;
 online:=coalesce(online,false);
 select * into r from app.telegram_hosted_requests where service_id=service and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and retired_at is null;
 if r.worker_id is not null then
 select * into w from app.telegram_workers where id=r.worker_id;
 select coalesce(last_seen_at>clock_timestamp()-interval '90 seconds',false) into worker_online from app.telegram_connector_workers where id=r.worker_id;
 worker_online:=coalesce(worker_online,false) and w.revoked_at is null and w.expires_at>clock_timestamp();
 end if;
 return jsonb_build_object('enrollment',case when r.id is null then null else jsonb_build_object('requestId',r.id,'workerId',r.worker_id,'retirementMode',app.telegram_hosted_retirement_mode_v1(r.id)) end,'serviceOnline',online,'state',case when not online then 'unavailable' when r.id is null then 'not_requested' when w.revoked_at is not null then 'unavailable' when worker_online then 'ready' else 'pending' end,'workerId',r.worker_id,'workerOnline',worker_online and online,'errorCode',case when w.revoked_at is not null then 'WORKER_REVOKED' when not online then 'SERVICE_OFFLINE' else null end);
end $$;
create or replace function app.telegram_hosted_prepare_v1(service uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare org uuid:=app.context_uuid_v1('app.organization_id');actor uuid:=app.context_uuid_v1('app.actor_id');begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform set_config('app.hosted_service_id',service::text,true);
 insert into app.telegram_hosted_services(service_id) values(service) on conflict do nothing;
 perform 1 from app.telegram_hosted_services where service_id=service for update;
 if not exists(select 1 from app.telegram_hosted_requests where service_id=service and organization_id=org and owner_user_id=actor and retired_at is null) then
 if (select count(*) from app.telegram_hosted_requests where service_id=service and retired_at is null)>=10 then raise exception 'Hosted capacity reached' using errcode='53300';end if;
 insert into app.telegram_hosted_requests(service_id,organization_id,owner_user_id) values(service,org,actor);
 end if;
 return app.telegram_hosted_status_v1(service);
end $$;
create or replace function app.telegram_hosted_list_v1(service uuid,instance uuid,proof uuid,cursor_id uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;w app.telegram_workers;allowed boolean;running boolean;records jsonb:='[]';last_id uuid;begin
 perform app.telegram_hosted_lease_v1(service,instance,proof);
 for r in select * from app.telegram_hosted_requests where service_id=service and retired_at is null and (cursor_id is null or id>cursor_id) order by id limit 10 loop
 allowed:=app.worker_pairing_owner_allowed_v1(r.organization_id,r.owner_user_id);
 w:=null;
 if r.worker_id is not null then select * into w from app.telegram_workers where id=r.worker_id;end if;
 running:=allowed and (r.worker_id is null or w.revoked_at is null);
 if running and r.worker_id is not null then update app.telegram_workers set expires_at=greatest(expires_at,clock_timestamp()+interval '30 days') where id=r.worker_id and expires_at<clock_timestamp()+interval '29 days';end if;
 records:=records||jsonb_build_array(jsonb_build_object('requestId',r.id,'organizationId',r.organization_id,'ownerUserId',r.owner_user_id,'workerId',r.worker_id,'tokenSha256',case when w.id is not null then encode(w.token_sha256,'hex') else null end,'state',case when not running then 'stopped' when r.worker_id is null then 'pending' else 'registered' end,'canRun',running));
 last_id:=r.id;
 end loop;
 return jsonb_build_object('requests',records,'nextAfter',case when exists(select 1 from app.telegram_hosted_requests where service_id=service and retired_at is null and id>last_id) then last_id else null end);
end $$;
create or replace function app.telegram_hosted_register_v1(service uuid,instance uuid,proof uuid,request uuid,worker uuid,token_hash text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;w app.telegram_workers;begin
 perform app.telegram_hosted_lease_v1(service,instance,proof);
 if request is null or worker is null or token_hash is null or token_hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid request' using errcode='22023';end if;
 select * into r from app.telegram_hosted_requests where id=request and service_id=service and retired_at is null for update;
 if not found then raise exception 'Request unavailable' using errcode='P0002';end if;
 if not app.worker_pairing_owner_allowed_v1(r.organization_id,r.owner_user_id) then raise exception 'Owner unavailable' using errcode='42501';end if;
 if r.worker_id is not null then
 select * into w from app.telegram_workers where id=r.worker_id for update;
 if r.worker_id<>worker or w.token_sha256<>decode(token_hash,'hex') or w.revoked_at is not null then raise exception 'Registration conflict' using errcode='40001';end if;
 update app.telegram_workers set expires_at=greatest(expires_at,clock_timestamp()+interval '30 days') where id=worker;
 else
 insert into app.telegram_workers(id,organization_id,owner_user_id,name,token_sha256) values(worker,r.organization_id,r.owner_user_id,'Hosted Telegram service',decode(token_hash,'hex'));
 update app.telegram_hosted_requests set worker_id=worker where id=request;
 end if;
 return jsonb_build_object('workerId',worker,'state','registered');
end $$;
create or replace function app.telegram_connection_json_v1(c app.telegram_connections)
returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
    select jsonb_build_object('retirementReason',c.retirement_reason,'id',c.id,'workerId',c.worker_id,'generation',c.generation,'status',c.status,'challengeId',c.challenge_id,
      'qrLoginUrl',case when c.qr_expires_at>now() then c.qr_login_url end,'qrExpiresAt',c.qr_expires_at,
      'passwordHint',c.password_hint,'passwordPending',c.password_ciphertext is not null and c.password_expires_at>now(),
      'errorCode',c.error_code,'cancelledBeforeStart',c.cancelled_before_start,'workerPinned',c.ever_leased,'profile',c.profile,'updatedAt',c.updated_at);
$$;
create or replace function app.telegram_connection_start_v1(p_worker uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare c app.telegram_connections; w app.telegram_workers; begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    select * into w from app.telegram_workers where id=p_worker and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and revoked_at is null and expires_at>clock_timestamp() for share;
    if not found or not exists(select 1 from app.telegram_connector_workers where id=p_worker and last_seen_at>clock_timestamp()-interval '90 seconds') then raise exception 'Connector unavailable' using errcode='40001'; end if;
    perform app.telegram_connection_expire_v1();
    select * into c from app.telegram_connections for update;
    if found and c.worker_id<>p_worker and c.ever_leased then raise exception 'Disconnect before changing connector' using errcode='40001'; end if;
    if found and c.status not in ('failed','disconnected') then
        if c.worker_id<>p_worker then raise exception 'Connection active' using errcode='40001'; end if;
        return app.telegram_connection_status_v1();
    end if;
    insert into app.telegram_connections(organization_id,owner_user_id,worker_id,status,auth_expires_at)
      values(app.context_uuid_v1('app.organization_id'),app.context_uuid_v1('app.actor_id'),p_worker,'requested',clock_timestamp()+interval '10 minutes')
      on conflict(organization_id,owner_user_id) do update set worker_id=excluded.worker_id,retirement_reason=null,status='requested',cancelled_before_start=false,generation=telegram_connections.generation+1,challenge_id=gen_random_uuid(),auth_expires_at=excluded.auth_expires_at,qr_login_url=null,qr_expires_at=null,password_hint=null,password_ciphertext=null,password_expires_at=null,password_submission_id=null,last_password_submission_id=null,profile=null,error_code=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where telegram_connections.status in ('failed','disconnected');
    return app.telegram_connection_status_v1();
end $$;
create or replace function app.telegram_worker_context_v1(p_token text)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w app.telegram_workers;service uuid;begin
 perform set_config('app.actor_id','',true);perform set_config('app.organization_id','',true);perform set_config('app.hosted_service_id','',true);
 if p_token is null or p_token!~'^[A-Za-z0-9_-]{64}$' then raise exception 'Worker unauthorized' using errcode='42501';end if;
 select * into w from app.telegram_workers where token_sha256=sha256(convert_to(p_token,'UTF8')) and revoked_at is null and expires_at>clock_timestamp() for update;
 if not found then raise exception 'Worker unauthorized' using errcode='42501';end if;
 perform set_config('app.actor_id',w.owner_user_id::text,true);perform set_config('app.organization_id',w.organization_id::text,true);
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if exists(select 1 from app.telegram_hosted_requests where worker_id=w.id and retired_at is not null) then raise exception 'Hosted enrollment retired' using errcode='42501';end if;
 select service_id into service from app.telegram_hosted_requests where worker_id=w.id and organization_id=w.organization_id and owner_user_id=w.owner_user_id;
 if service is not null then
 perform set_config('app.hosted_service_id',service::text,true);
 if not exists(select 1 from app.telegram_hosted_services where service_id=service and lease_expires_at>clock_timestamp()) then raise exception 'Hosted service offline' using errcode='42501';end if;
 end if;
 update app.telegram_workers set last_seen_at=clock_timestamp() where id=w.id and (last_seen_at is null or last_seen_at<clock_timestamp()-interval '30 seconds');
 return w.id;
end $$;
revoke all on function app.telegram_hosted_logout_proof_v1(),app.telegram_hosted_retirement_mode_v1(uuid),app.telegram_hosted_retire_v1(uuid,uuid,uuid,uuid,boolean) from public;
grant execute on function app.telegram_hosted_retire_v1(uuid,uuid,uuid,uuid,boolean) to app_staff;
reset role;set local role app_owner;revoke create on schema app from app_executor;
commit;
