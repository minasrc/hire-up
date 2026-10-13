-- Retirement authorizes destruction of that exact old private registration.
-- New worker acknowledgements never stand in for old-vault erasure.
begin;
set local lock_timeout='2s';set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_hosted_requests add column vault_cleanup_served_at timestamptz not null default 'epoch',add column vault_cleanup_token uuid,add column vault_purged_at timestamptz,add column vault_purge_instance uuid;
alter table app.telegram_hosted_requests add constraint telegram_retired_vault_purge_check check((vault_purged_at is null and vault_purge_instance is null) or (vault_purged_at is not null and vault_purge_instance is not null and retired_at is not null));
alter table app.telegram_hosted_requests add unique(organization_id,owner_user_id,id);
alter table app.telegram_chat_removals add unique(organization_id,owner_user_id,id);
alter table app.telegram_chat_removals add column primary_device_cleanup_at timestamptz;
create table app.telegram_retired_vault_obligations(
 organization_id uuid not null,owner_user_id uuid not null,request_id uuid not null,removal_id uuid not null,
 primary key(request_id,removal_id),
 foreign key(organization_id,owner_user_id,request_id) references app.telegram_hosted_requests(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,removal_id) references app.telegram_chat_removals(organization_id,owner_user_id,id)
);
create index telegram_retired_vault_obligation_removal on app.telegram_retired_vault_obligations(removal_id,request_id);
create index telegram_retired_vault_queue on app.telegram_hosted_requests(service_id,vault_cleanup_served_at,retired_at,id) where retired_at is not null and vault_purged_at is null;
alter table app.telegram_retired_vault_obligations enable row level security;
alter table app.telegram_retired_vault_obligations force row level security;
grant select,insert on app.telegram_retired_vault_obligations to app_executor;
create policy telegram_retired_vault_obligation_owner on app.telegram_retired_vault_obligations to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')) with check(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
-- Preserve primary ACK evidence before gating the combined device completion.
reset role;
update app.telegram_chat_removals set primary_device_cleanup_at=device_cleanup_at;
insert into app.telegram_retired_vault_obligations
 select removal.organization_id,removal.owner_user_id,retired.id,removal.id
 from app.telegram_chat_removals removal join app.telegram_history_chats chat on chat.id=removal.chat_id
 join app.telegram_hosted_requests retired on retired.organization_id=removal.organization_id and retired.owner_user_id=removal.owner_user_id
 where retired.retired_at is not null and retired.worker_id is not null and retired.vault_purged_at is null
 and (removal.completed_at is null or (removal.reimport_receipt is null and chat.removal_state='completed'))
 on conflict do nothing;
-- Reopen only current removed chats; never fence a reimported/fresh active chat.
update app.telegram_chat_removals removal set device_cleanup_at=null,completed_at=null
 where exists(select 1 from app.telegram_retired_vault_obligations obligation where obligation.removal_id=removal.id);
update app.telegram_history_chats chat set removal_state='device_pending',version=version+1
 where chat.removal_state='completed' and exists(select 1 from app.telegram_chat_removals removal where removal.chat_id=chat.id and removal.completed_at is null and removal.reimport_receipt is null);
set local role app_owner;
grant create on schema app to app_executor;
set local role app_executor;
create function app.telegram_removal_retired_vault_obligations_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 insert into app.telegram_retired_vault_obligations
 select new.organization_id,new.owner_user_id,retired.id,new.id from app.telegram_hosted_requests retired
 where retired.organization_id=new.organization_id and retired.owner_user_id=new.owner_user_id and retired.retired_at is not null and retired.worker_id is not null and retired.vault_purged_at is null on conflict do nothing;
 -- If the original primary worker's whole vault was already erased, its
 -- immutable purge proof also covers later removals; it can never cache again.
 update app.telegram_chat_removals pending set primary_device_cleanup_at=retired.vault_purged_at,device_cleanup_at=retired.vault_purged_at
 from app.telegram_hosted_requests retired where pending.id=new.id and retired.worker_id=new.cleanup_worker_id and retired.retired_at is not null and retired.vault_purged_at is not null;
 return new;
end $$;
create function app.telegram_retirement_removal_obligations_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 if new.retired_at is not null and old.retired_at is null and new.worker_id is not null then
 insert into app.telegram_retired_vault_obligations select new.organization_id,new.owner_user_id,new.id,removal.id from app.telegram_chat_removals removal where removal.organization_id=new.organization_id and removal.owner_user_id=new.owner_user_id and removal.completed_at is null on conflict do nothing;
 update app.telegram_chat_removals removal set device_cleanup_at=null where removal.organization_id=new.organization_id and removal.owner_user_id=new.owner_user_id and removal.completed_at is null and removal.device_cleanup_at is not null;
 end if;
 return new;
end $$;
create function app.telegram_removal_device_completion_gate_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 if new.device_cleanup_at is not null then
 new.primary_device_cleanup_at:=coalesce(new.primary_device_cleanup_at,new.device_cleanup_at);
 if exists(select 1 from app.telegram_retired_vault_obligations obligation join app.telegram_hosted_requests retired on retired.id=obligation.request_id where obligation.removal_id=new.id and retired.vault_purged_at is null) then new.device_cleanup_at:=null;end if;
 end if;
 return new;
end $$;
reset role;set local role app_owner;
create trigger telegram_removal_retired_vault_obligations after insert on app.telegram_chat_removals for each row execute function app.telegram_removal_retired_vault_obligations_v1();
create trigger telegram_retirement_removal_obligations after update of retired_at on app.telegram_hosted_requests for each row execute function app.telegram_retirement_removal_obligations_v1();
create trigger telegram_removal_device_completion_gate before update of device_cleanup_at on app.telegram_chat_removals for each row execute function app.telegram_removal_device_completion_gate_v1();
set local role app_executor;
create function app.telegram_hosted_retired_cleanup_claim_v1(service uuid,instance uuid,proof uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;records jsonb:='[]';begin
 perform app.telegram_hosted_lease_v1(service,instance,proof);
 for r in select * from app.telegram_hosted_requests where service_id=service and retired_at is not null and vault_purged_at is null order by vault_cleanup_served_at,retired_at,id limit 5 for update skip locked loop
 update app.telegram_hosted_requests set vault_cleanup_token=coalesce(vault_cleanup_token,gen_random_uuid()),vault_cleanup_served_at=clock_timestamp() where id=r.id returning * into r;
 records:=records||jsonb_build_array(jsonb_build_object('requestId',r.id,'workerId',r.worker_id,'organizationId',r.organization_id,'ownerUserId',r.owner_user_id,'cleanupToken',r.vault_cleanup_token));
 end loop;
 return jsonb_build_object('protocolVersion',1,'requests',records);
end $$;
create function app.telegram_hosted_retired_cleanup_ack_v1(service uuid,instance uuid,proof uuid,p_request uuid,p_worker uuid,p_cleanup uuid) returns boolean language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;removal record;tm timestamptz:=clock_timestamp();begin
 -- Read-only proof check before acquiring the organization lock. Staff mutations
 -- take org before service; never invert that order with a service row lock.
 perform set_config('app.hosted_service_id',service::text,true);
 if not exists(select 1 from app.telegram_hosted_services where service_id=service and instance_id=instance and lease_token=proof and lease_expires_at>clock_timestamp()) then raise exception 'Service lease changed' using errcode='40001';end if;
 select * into r from app.telegram_hosted_requests where id=p_request and service_id=service and retired_at is not null;
 if not found or r.worker_id is distinct from p_worker or p_cleanup is null or r.vault_cleanup_token is distinct from p_cleanup then raise exception 'Retired cleanup changed' using errcode='40001';end if;
 perform set_config('app.actor_id',r.owner_user_id::text,true);perform set_config('app.organization_id',r.organization_id::text,true);
 perform 1 from app.organizations where id=r.organization_id for update;
 perform app.telegram_hosted_lease_v1(service,instance,proof);
 select * into r from app.telegram_hosted_requests where id=p_request and service_id=service and retired_at is not null and worker_id is not distinct from p_worker and vault_cleanup_token=p_cleanup for update;
 if not found then raise exception 'Retired cleanup changed' using errcode='40001';end if;
 if r.vault_purged_at is not null then return true;end if;
 update app.telegram_hosted_requests set vault_purged_at=tm,vault_purge_instance=instance where id=r.id;
 -- A whole old-vault proof fulfills only that exact old primary worker's work.
 if r.worker_id is not null then
 update app.telegram_chat_removal_cleanup_pages page set acknowledged_at=coalesce(acknowledged_at,tm) from app.telegram_chat_removals pending where pending.id=page.removal_id and pending.cleanup_worker_id=r.worker_id and pending.organization_id=r.organization_id and pending.owner_user_id=r.owner_user_id and page.acknowledged_at is null;
 update app.telegram_chat_removals set primary_device_cleanup_at=coalesce(primary_device_cleanup_at,tm),cleanup_token=null where cleanup_worker_id=r.worker_id and organization_id=r.organization_id and owner_user_id=r.owner_user_id and (primary_device_cleanup_at is null or cleanup_token is not null);
 end if;
 update app.telegram_chat_removals pending set device_cleanup_at=pending.primary_device_cleanup_at
 where pending.organization_id=r.organization_id and pending.owner_user_id=r.owner_user_id and pending.completed_at is null and pending.primary_device_cleanup_at is not null
 and (pending.cleanup_worker_id=r.worker_id or exists(select 1 from app.telegram_retired_vault_obligations obligation where obligation.removal_id=pending.id and obligation.request_id=r.id))
 and not exists(select 1 from app.telegram_retired_vault_obligations obligation join app.telegram_hosted_requests retired on retired.id=obligation.request_id where obligation.removal_id=pending.id and retired.vault_purged_at is null);
 -- Completion is still fenced by server purge and any storage cleanup backlog.
 for removal in select chat_id from app.telegram_chat_removals where organization_id=r.organization_id and owner_user_id=r.owner_user_id and completed_at is null and server_purged_at is not null and device_cleanup_at is not null order by requested_at,id limit 5 loop
 begin perform app.telegram_chat_removal_step_v1(removal.chat_id);exception when lock_not_available then null;end;
 end loop;
 return true;
end $$;
create or replace function app.telegram_chat_removal_cleanup_claim_v1(p_token text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    w uuid;
    r app.telegram_chat_removals;
    a app.telegram_history_accounts;
    p app.telegram_chat_removal_cleanup_pages;
    ids jsonb;
    last_id uuid;
    has_more boolean;
begin
    w:=app.telegram_worker_context_v1(p_token);
    select r0.* into r from app.telegram_chat_removals r0 where r0.organization_id=app.context_uuid_v1('app.organization_id') and r0.owner_user_id=app.context_uuid_v1('app.actor_id') and r0.cleanup_worker_id=w and r0.server_purged_at is not null and r0.device_cleanup_at is null and r0.primary_device_cleanup_at is null order by r0.requested_at,r0.id limit 1 for update;
    if not found then
        return jsonb_build_object('cleanup',null);
    end if;
    select a0.* into strict a from app.telegram_history_accounts a0 join app.telegram_history_chats c on c.account_id=a0.id where c.id=r.chat_id;
    -- Fence leases issued while asynchronous server cleanup was in progress.
    update app.telegram_source_sweeps s set lease_token=null,lease_expires_at=null,ids=null from app.telegram_history_chats c where c.id=s.chat_id and c.account_id=a.id;
    update app.telegram_native_accounts set lease_token=null,lease_expires_at=null,scope_digest=null where account_id=a.id;
    update app.telegram_native_channels set lease_token=null,lease_expires_at=null,scope_digest=null where account_id=a.id;
    if r.cleanup_token is null then
        with chosen as(select cv.id from app.telegram_cv_jobs cv join app.telegram_extraction_jobs j on j.id=cv.extraction_job_id where j.chat_id=r.chat_id and (r.cleanup_cursor is null or cv.id>r.cleanup_cursor) order by cv.id limit 51),shown as(select id from chosen order by id limit 50) select coalesce((select jsonb_agg(id order by id) from shown),'[]'),(select id from shown order by id desc limit 1),(select count(*)>50 from chosen) into ids,last_id,has_more;
        update app.telegram_chat_removals set cleanup_token=gen_random_uuid() where id=r.id returning * into r;
        insert into app.telegram_chat_removal_cleanup_pages values(r.organization_id,r.owner_user_id,r.id,r.cleanup_token,ids,last_id,not has_more,null);
    end if;
    select * into strict p from app.telegram_chat_removal_cleanup_pages where token=r.cleanup_token;
    return jsonb_build_object('cleanup',jsonb_build_object('removalId',r.id,'chatId',r.chat_id,'connectionId',a.connection_id,'accountUserId',a.account_user_id,'historyJobId',(select id from app.telegram_history_jobs where chat_id=r.chat_id),'peer',(select jsonb_build_object('kind',peer_kind,'id',peer_id) from app.telegram_history_chats where id=r.chat_id),'cvJobIds',p.cv_job_ids,'cleanupToken',r.cleanup_token));
end $$;
create or replace function app.telegram_work_plan_v1(p_worker uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    plan jsonb;
begin
    plan:=app.telegram_work_plan_before_removal_v1(p_worker);
    if exists(select 1 from app.telegram_chat_removals where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and cleanup_worker_id=p_worker and server_purged_at is not null and device_cleanup_at is null and primary_device_cleanup_at is null) then
        plan:=jsonb_set(plan,'{source}','true');
    end if;
    return plan;
end $$;
-- Optional wrapper keeps this migration independently testable; ordered
-- production deployments always have the160000 maintenance entry point.
do $wrapper$begin
 if to_regprocedure('app.telegram_hosted_maintenance_v1(uuid,uuid,uuid)') is not null then
 alter function app.telegram_hosted_maintenance_v1(uuid,uuid,uuid) rename to telegram_hosted_maintenance_before_retired_vault_v1;
 revoke all on function app.telegram_hosted_maintenance_before_retired_vault_v1(uuid,uuid,uuid) from public,app_telegram_hosted_service;
 execute $fn$create function app.telegram_hosted_maintenance_v1(service uuid,instance uuid,proof uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $body$begin
 return app.telegram_hosted_maintenance_before_retired_vault_v1(service,instance,proof)||jsonb_build_object('retiredVaultActionable',exists(select 1 from app.telegram_hosted_requests where service_id=service and retired_at is not null and vault_purged_at is null));
 end; $body$; $fn$;
 grant execute on function app.telegram_hosted_maintenance_v1(uuid,uuid,uuid) to app_telegram_hosted_service;
 revoke all on function app.telegram_hosted_maintenance_v1(uuid,uuid,uuid) from public;
 end if;
end $wrapper$;
revoke all on function app.telegram_removal_retired_vault_obligations_v1(),app.telegram_retirement_removal_obligations_v1(),app.telegram_removal_device_completion_gate_v1(),app.telegram_hosted_retired_cleanup_claim_v1(uuid,uuid,uuid),app.telegram_hosted_retired_cleanup_ack_v1(uuid,uuid,uuid,uuid,uuid,uuid) from public;
grant execute on function app.telegram_hosted_retired_cleanup_claim_v1(uuid,uuid,uuid),app.telegram_hosted_retired_cleanup_ack_v1(uuid,uuid,uuid,uuid,uuid,uuid) to app_telegram_hosted_service;
reset role;set local role app_owner;revoke create on schema app from app_executor;
commit;
