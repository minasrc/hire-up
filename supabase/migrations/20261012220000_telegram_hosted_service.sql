-- One configured service owns at most ten durable owner-scoped enrollments.
-- Lease receipts report conservative remaining seconds; initial retries never renew.
-- Supervisor must terminate children before expiry and retain owner vaults after stop.
begin;
set local lock_timeout='2s';set local statement_timeout='30s';
create role app_telegram_hosted_service nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
set local role app_owner;
grant usage on schema app to app_telegram_hosted_service;
create table app.telegram_hosted_services(
 service_id uuid primary key,instance_id uuid,lease_token uuid,lease_expires_at timestamptz,
 check((instance_id is null and lease_token is null and lease_expires_at is null) or (instance_id is not null and lease_token is not null and lease_expires_at is not null))
);
create table app.telegram_hosted_requests(
 id uuid primary key default gen_random_uuid(),service_id uuid not null references app.telegram_hosted_services(service_id),
 organization_id uuid not null,owner_user_id uuid not null,worker_id uuid unique,
 created_at timestamptz not null default clock_timestamp(),
 unique(service_id,organization_id,owner_user_id),
 foreign key(organization_id,owner_user_id) references app.organization_memberships(organization_id,user_id),
 foreign key(organization_id,owner_user_id,worker_id) references app.telegram_workers(organization_id,owner_user_id,id)
);
create index telegram_hosted_request_page on app.telegram_hosted_requests(service_id,id);
do $$ declare t text;begin foreach t in array array['telegram_hosted_services','telegram_hosted_requests'] loop
 execute format('alter table app.%I enable row level security',t);
 execute format('alter table app.%I force row level security',t);
 execute format('grant select,insert,update on app.%I to app_executor',t);
 execute format('create policy hosted_service_scope on app.%I to app_executor using(service_id=nullif(current_setting(''app.hosted_service_id'',true),'''')::uuid) with check(service_id=nullif(current_setting(''app.hosted_service_id'',true),'''')::uuid)',t);
end loop;end $$;
-- Worker validation can discover only the enrollment matching its freshly scoped owner.
create policy hosted_request_owner_lookup on app.telegram_hosted_requests for select to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
grant create on schema app to app_executor;
set local role app_executor;
create function app.telegram_hosted_status_v1(service uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;w app.telegram_workers;online boolean;worker_online boolean:=false;begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform set_config('app.hosted_service_id',service::text,true);
 select coalesce(lease_expires_at>clock_timestamp(),false) into online from app.telegram_hosted_services where service_id=service;
 online:=coalesce(online,false);
 select * into r from app.telegram_hosted_requests where service_id=service and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id');
 if r.worker_id is not null then
 select * into w from app.telegram_workers where id=r.worker_id;
 select coalesce(last_seen_at>clock_timestamp()-interval '90 seconds',false) into worker_online from app.telegram_connector_workers where id=r.worker_id;
 worker_online:=coalesce(worker_online,false) and w.revoked_at is null and w.expires_at>clock_timestamp();
 end if;
 return jsonb_build_object('serviceOnline',online,'state',case when not online then 'unavailable' when r.id is null then 'not_requested' when w.revoked_at is not null then 'unavailable' when worker_online then 'ready' else 'pending' end,'workerId',r.worker_id,'workerOnline',worker_online and online,'errorCode',case when w.revoked_at is not null then 'WORKER_REVOKED' when not online then 'SERVICE_OFFLINE' else null end);
end $$;
create function app.telegram_hosted_prepare_v1(service uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare org uuid:=app.context_uuid_v1('app.organization_id');actor uuid:=app.context_uuid_v1('app.actor_id');begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform set_config('app.hosted_service_id',service::text,true);
 insert into app.telegram_hosted_services(service_id) values(service) on conflict do nothing;
 perform 1 from app.telegram_hosted_services where service_id=service for update;
 if not exists(select 1 from app.telegram_hosted_requests where service_id=service and organization_id=org and owner_user_id=actor) then
 if (select count(*) from app.telegram_hosted_requests where service_id=service)>=10 then raise exception 'Hosted capacity reached' using errcode='53300';end if;
 insert into app.telegram_hosted_requests(service_id,organization_id,owner_user_id) values(service,org,actor);
 end if;
 return app.telegram_hosted_status_v1(service);
end $$;
create function app.telegram_hosted_heartbeat_v1(service uuid,instance uuid,proof uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare s app.telegram_hosted_services;begin
 if service is null or instance is null then raise exception 'Invalid request' using errcode='22023';end if;
 perform set_config('app.hosted_service_id',service::text,true);
 insert into app.telegram_hosted_services(service_id) values(service) on conflict do nothing;
 select * into s from app.telegram_hosted_services where service_id=service for update;
 if s.lease_expires_at>clock_timestamp() then
 if s.instance_id<>instance or (proof is not null and proof<>s.lease_token) then raise exception 'Service already assigned' using errcode='40001';end if;
 -- Initial delivery retry can recover its receipt, but cannot renew without proof.
 if proof is not null then update app.telegram_hosted_services set lease_expires_at=clock_timestamp()+interval '90 seconds' where service_id=service returning * into s;end if;
 else
 if proof is not null then raise exception 'Service lease expired' using errcode='40001';end if;
 update app.telegram_hosted_services set instance_id=instance,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '90 seconds' where service_id=service returning * into s;
 end if;
 return jsonb_build_object('leaseToken',s.lease_token,'leaseSeconds',greatest(0,floor(extract(epoch from s.lease_expires_at-clock_timestamp()))),'capacity',10);
end $$;
create function app.telegram_hosted_lease_v1(service uuid,instance uuid,proof uuid) returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$begin
 perform set_config('app.hosted_service_id',service::text,true);
 perform 1 from app.telegram_hosted_services where service_id=service and instance_id=instance and lease_token=proof and lease_expires_at>clock_timestamp() for update;
 if not found then raise exception 'Service lease changed' using errcode='40001';end if;
end $$;
create function app.telegram_hosted_list_v1(service uuid,instance uuid,proof uuid,cursor_id uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;w app.telegram_workers;allowed boolean;running boolean;records jsonb:='[]';last_id uuid;begin
 perform app.telegram_hosted_lease_v1(service,instance,proof);
 for r in select * from app.telegram_hosted_requests where service_id=service and (cursor_id is null or id>cursor_id) order by id limit 10 loop
 allowed:=app.worker_pairing_owner_allowed_v1(r.organization_id,r.owner_user_id);
 w:=null;
 if r.worker_id is not null then select * into w from app.telegram_workers where id=r.worker_id;end if;
 running:=allowed and (r.worker_id is null or w.revoked_at is null);
 if running and r.worker_id is not null then update app.telegram_workers set expires_at=greatest(expires_at,clock_timestamp()+interval '30 days') where id=r.worker_id;end if;
 records:=records||jsonb_build_array(jsonb_build_object('requestId',r.id,'organizationId',r.organization_id,'ownerUserId',r.owner_user_id,'workerId',r.worker_id,'tokenSha256',case when w.id is not null then encode(w.token_sha256,'hex') else null end,'state',case when not running then 'stopped' when r.worker_id is null then 'pending' else 'registered' end,'canRun',running));
 last_id:=r.id;
 end loop;
 return jsonb_build_object('requests',records,'nextAfter',case when exists(select 1 from app.telegram_hosted_requests where service_id=service and id>last_id) then last_id else null end);
end $$;
create function app.telegram_hosted_register_v1(service uuid,instance uuid,proof uuid,request uuid,worker uuid,token_hash text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;w app.telegram_workers;begin
 perform app.telegram_hosted_lease_v1(service,instance,proof);
 if request is null or worker is null or token_hash is null or token_hash!~'^[a-f0-9]{64}$' then raise exception 'Invalid request' using errcode='22023';end if;
 select * into r from app.telegram_hosted_requests where id=request and service_id=service for update;
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
-- Hosted worker credentials cannot outlive the supervisor's global lease.
-- Ordinary outbound/local connector credentials keep their existing behavior.
create or replace function app.telegram_worker_context_v1(p_token text)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w app.telegram_workers;service uuid;begin
 perform set_config('app.actor_id','',true);perform set_config('app.organization_id','',true);perform set_config('app.hosted_service_id','',true);
 if p_token is null or p_token!~'^[A-Za-z0-9_-]{64}$' then raise exception 'Worker unauthorized' using errcode='42501';end if;
 select * into w from app.telegram_workers where token_sha256=sha256(convert_to(p_token,'UTF8')) and revoked_at is null and expires_at>clock_timestamp() for update;
 if not found then raise exception 'Worker unauthorized' using errcode='42501';end if;
 perform set_config('app.actor_id',w.owner_user_id::text,true);perform set_config('app.organization_id',w.organization_id::text,true);
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select service_id into service from app.telegram_hosted_requests where worker_id=w.id and organization_id=w.organization_id and owner_user_id=w.owner_user_id;
 if service is not null then
 perform set_config('app.hosted_service_id',service::text,true);
 if not exists(select 1 from app.telegram_hosted_services where service_id=service and lease_expires_at>clock_timestamp()) then raise exception 'Hosted service offline' using errcode='42501';end if;
 end if;
 update app.telegram_workers set last_seen_at=clock_timestamp() where id=w.id;
 return w.id;
end $$;
do $$ declare f record;begin for f in select oid::regprocedure as signature from pg_proc where pronamespace='app'::regnamespace and proname like 'telegram_hosted_%' loop execute format('revoke all on function %s from public',f.signature);end loop;end $$;
grant execute on function app.telegram_hosted_status_v1(uuid),app.telegram_hosted_prepare_v1(uuid) to app_staff;
grant execute on function app.telegram_hosted_heartbeat_v1(uuid,uuid,uuid),app.telegram_hosted_list_v1(uuid,uuid,uuid,uuid),app.telegram_hosted_register_v1(uuid,uuid,uuid,uuid,uuid,text) to app_telegram_hosted_service;
reset role;set local role app_owner;revoke create on schema app from app_executor;
commit;
