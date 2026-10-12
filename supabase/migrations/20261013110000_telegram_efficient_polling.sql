-- Scheduling hints never claim work or replace authorization/lease fencing.
begin;
set local lock_timeout='2s'; set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_hosted_requests add column wake_epoch bigint not null default 0 check(wake_epoch>=0);
grant create on schema app to app_executor;
set local role app_executor;
create function app.telegram_work_plan_v1(p_worker uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app,pg_temp as $$
declare c app.telegram_connections; a app.telegram_history_accounts; h boolean:=false; v boolean:=false; s boolean:=false; na boolean:=false; nc boolean:=false;
begin
 select * into c from app.telegram_connections where worker_id=p_worker and status='connected';
 if c.id is not null then
 select * into a from app.telegram_history_accounts where connection_id=c.id and account_user_id=c.profile->>'telegramUserId';
 if a.id is not null and (a.cooldown_until is null or a.cooldown_until<=now()) then
 select exists(select 1 from app.telegram_history_jobs j left join app.telegram_history_chats ch on ch.id=j.chat_id where j.account_id=a.id and
 (j.status in('queued','leased') or (j.status='waiting' and j.retry_at<=now()) or (j.status='completed' and ch.selected and ch.history_completed and ch.next_sync_at<=now()))) into h;
 select exists(select 1 from app.telegram_cv_jobs where account_id=a.id and (status='leased' or (status in('queued','waiting') and available_at<=now()))) into v;
 select exists(select 1 from app.telegram_history_chats ch join app.telegram_history_jobs j on j.chat_id=ch.id left join app.telegram_source_sweeps sw on sw.chat_id=ch.id where ch.account_id=a.id and ch.selected and j.status not in('paused','cancelled') and (sw.chat_id is null or sw.due_at<=now())) into s;
 na:=true;
 select exists(select 1 from app.telegram_history_chats ch join app.telegram_history_jobs j on j.chat_id=ch.id where ch.account_id=a.id and ch.selected and ch.peer_kind='channel' and j.status not in('paused','cancelled')) into nc;
 end if;
 end if;
 return jsonb_build_object('history',h,'cv',v,'source',s,'nativeAccount',na,'nativeChannels',nc);
end $$;
create function app.telegram_schedule_wake_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare r record; previous text:=current_setting('app.hosted_service_id',true);
begin
 for r in select service_id,id from app.telegram_hosted_requests where organization_id=new.organization_id and owner_user_id=new.owner_user_id loop
 perform set_config('app.hosted_service_id',r.service_id::text,true);
 update app.telegram_hosted_requests set wake_epoch=wake_epoch+1 where id=r.id;
 end loop;
 perform set_config('app.hosted_service_id',coalesce(previous,''),true);
 return new;
end $$;
reset role; set local role app_owner;
create trigger telegram_connection_schedule_wake after insert or update of status,generation,password_submission_id on app.telegram_connections for each row execute function app.telegram_schedule_wake_v1();
create trigger telegram_history_schedule_wake after insert or update of status,run_id on app.telegram_history_jobs for each row execute function app.telegram_schedule_wake_v1();
create trigger telegram_cv_schedule_wake after insert or update of status on app.telegram_cv_jobs for each row execute function app.telegram_schedule_wake_v1();
create trigger telegram_chat_schedule_wake after update of selected,version on app.telegram_history_chats for each row execute function app.telegram_schedule_wake_v1();
reset role; set local role app_executor;
create function app.telegram_connection_poll_v1(p_token text,p_key text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; c jsonb; plan jsonb;
begin
 perform app.telegram_connection_heartbeat_v1(p_token,p_key);
 -- Heartbeat has established authorization and owner scope before token lookup.
 select id into w from app.telegram_workers where token_sha256=sha256(convert_to(p_token,'UTF8'));
 c:=app.telegram_connection_claim_v1(p_token);
 plan:=app.telegram_work_plan_v1(w);
 return jsonb_build_object('protocolVersion',1,'connection',c,'plan',plan,'nextPollAfterSeconds',case when c is not null and c->>'status' not in('connected','disconnected') then 5 else 60 end);
end $$;
create function app.telegram_hosted_sync_v1(service uuid,instance uuid,proof uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare receipt jsonb; snapshot jsonb; item jsonb; records jsonb:='[]'; plan jsonb; epoch bigint; previous_actor text:=current_setting('app.actor_id',true); previous_org text:=current_setting('app.organization_id',true);
begin
 receipt:=app.telegram_hosted_heartbeat_v1(service,instance,proof);
 snapshot:=app.telegram_hosted_list_v1(service,instance,(receipt->>'leaseToken')::uuid,null);
 for item in select value from jsonb_array_elements(snapshot->'requests') loop
 perform set_config('app.actor_id',item->>'ownerUserId',true); perform set_config('app.organization_id',item->>'organizationId',true);
 plan:=app.telegram_work_plan_v1((item->>'workerId')::uuid);
 select wake_epoch into epoch from app.telegram_hosted_requests where id=(item->>'requestId')::uuid;
 records:=records||jsonb_build_array(item||jsonb_build_object('wakeEpoch',epoch::text,'demand','run','runnable',jsonb_build_object('history',plan->'history','cv',plan->'cv','source',plan->'source')));
 end loop;
 perform set_config('app.actor_id',coalesce(previous_actor,''),true); perform set_config('app.organization_id',coalesce(previous_org,''),true);
 return receipt||jsonb_build_object('protocolVersion',1,'requests',records,'nextAfter',snapshot->'nextAfter');
end $$;
revoke all on function app.telegram_work_plan_v1(uuid),app.telegram_schedule_wake_v1(),app.telegram_connection_poll_v1(text,text),app.telegram_hosted_sync_v1(uuid,uuid,uuid) from public;
grant execute on function app.telegram_connection_poll_v1(text,text) to app_telegram_worker;
grant execute on function app.telegram_hosted_sync_v1(uuid,uuid,uuid) to app_telegram_hosted_service;
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
 update app.telegram_workers set last_seen_at=clock_timestamp() where id=w.id and (last_seen_at is null or last_seen_at<clock_timestamp()-interval '30 seconds');
 return w.id;
end $$;
create or replace function app.telegram_hosted_list_v1(service uuid,instance uuid,proof uuid,cursor_id uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r app.telegram_hosted_requests;w app.telegram_workers;allowed boolean;running boolean;records jsonb:='[]';last_id uuid;begin
 perform app.telegram_hosted_lease_v1(service,instance,proof);
 for r in select * from app.telegram_hosted_requests where service_id=service and (cursor_id is null or id>cursor_id) order by id limit 10 loop
 allowed:=app.worker_pairing_owner_allowed_v1(r.organization_id,r.owner_user_id);
 w:=null;
 if r.worker_id is not null then select * into w from app.telegram_workers where id=r.worker_id;end if;
 running:=allowed and (r.worker_id is null or w.revoked_at is null);
 if running and r.worker_id is not null then update app.telegram_workers set expires_at=greatest(expires_at,clock_timestamp()+interval '30 days') where id=r.worker_id and expires_at<clock_timestamp()+interval '29 days';end if;
 records:=records||jsonb_build_array(jsonb_build_object('requestId',r.id,'organizationId',r.organization_id,'ownerUserId',r.owner_user_id,'workerId',r.worker_id,'tokenSha256',case when w.id is not null then encode(w.token_sha256,'hex') else null end,'state',case when not running then 'stopped' when r.worker_id is null then 'pending' else 'registered' end,'canRun',running));
 last_id:=r.id;
 end loop;
 return jsonb_build_object('requests',records,'nextAfter',case when exists(select 1 from app.telegram_hosted_requests where service_id=service and id>last_id) then last_id else null end);
end $$;
-- Explicit differences remain authoritative; each quiet feed has a minute cooldown.
create or replace function app.telegram_native_channel_complete_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_feed uuid,p_lease uuid,p_page jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;n app.telegram_native_channels;d bytea;delta bigint;quota app.telegram_history_limits;result jsonb;ch record;reason text;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null then raise exception 'Native account changed' using errcode='40001';end if;
 perform app.telegram_extraction_lock_v1();
 select * into n from app.telegram_native_channels where chat_id=p_feed and account_id=a.id for update;
 if not found or n.generation is distinct from p_generation or n.scope_digest is distinct from app.telegram_native_channel_scope_v1(p_feed,a.id) then raise exception 'Native scope changed' using errcode='40001';end if;
 if not coalesce(app.telegram_history_keys_v1(p_page,array['pageId','scopeDigest','fromState','nextState','kind','gapReason','changes']) and p_page ?& array['pageId','scopeDigest','fromState','nextState','kind','gapReason','changes'] and jsonb_typeof(p_page->'pageId')='string' and jsonb_typeof(p_page->'scopeDigest')='string',false) or octet_length(p_page::text)>2097152 or p_page->>'scopeDigest' is distinct from n.scope_digest then raise exception 'Invalid native page' using errcode='22023';end if;
 d:=sha256(convert_to(p_page::text,'UTF8'));
 if n.receipt_id=(p_page->>'pageId')::uuid then
 if n.receipt_digest<>d or n.receipt_generation is distinct from p_generation or n.receipt_scope is distinct from n.scope_digest then raise exception 'Native receipt changed' using errcode='40001';end if;return n.receipt_result||jsonb_build_object('replayed',true);end if;
 if p_lease is null or n.lease_token is null or n.lease_token is distinct from p_lease or n.lease_expires_at is null or n.lease_expires_at<=now() or p_page->'fromState' is distinct from coalesce(n.state,'null') then raise exception 'Native lease/state changed' using errcode='40001';end if;
 if p_page#>>'{nextState,qts}' is distinct from '0' or p_page#>>'{nextState,date}' is distinct from '0' or p_page#>>'{nextState,seq}' is distinct from '0' or not app.telegram_native_state_valid_v1(p_page->'nextState') or p_page->>'kind' is null or p_page->>'kind' not in('baseline','difference','empty','gap') or jsonb_typeof(p_page->'changes') is distinct from 'array' or jsonb_array_length(p_page->'changes')>128 or (p_page->'gapReason'<>'null'::jsonb and (jsonb_typeof(p_page->'gapReason') is distinct from 'string' or p_page->>'gapReason' not in('INITIAL_BASELINE','PROVIDER_GAP','OVERFLOW'))) then raise exception 'Invalid native state' using errcode='22023';end if;
 if (n.needs_baseline and p_page->>'kind'<>'baseline') or (not n.needs_baseline and p_page->>'kind'='baseline') or (p_page->>'kind' in('baseline','empty','gap') and jsonb_array_length(p_page->'changes')<>0) or (p_page->>'kind' in('difference','empty') and p_page->'gapReason'<>'null'::jsonb) or (p_page->>'kind'='baseline' and p_page->'gapReason' not in('null'::jsonb,'"INITIAL_BASELINE"'::jsonb)) or (p_page->>'kind'='gap' and p_page->'gapReason'='null'::jsonb) or (p_page->>'kind'<>'baseline' and n.state is not null and (p_page#>>'{nextState,pts}')::bigint<(n.state->>'pts')::bigint) then raise exception 'Invalid native progression' using errcode='22023';end if;
 perform app.telegram_extraction_lock_v1();select * into quota from app.telegram_history_limits for update;
 delta:=app.telegram_native_apply_changes_v1(a.id,p_page->'changes',p_feed);
 if quota.stored_bytes+delta>quota.max_bytes then raise exception 'Native source capacity exceeded' using errcode='23514';end if;
 update app.telegram_history_limits set stored_bytes=stored_bytes+delta;
 reason:=p_page->>'gapReason';
 if reason is not null then
 for ch in select c.id from app.telegram_history_chats c join app.telegram_history_jobs j on j.chat_id=c.id where c.account_id=a.id and c.peer_kind='channel' and c.id=p_feed and c.selected and j.status not in('paused','cancelled') loop perform app.telegram_native_repair_v1(ch.id,reason);end loop;
 end if;
 result:=jsonb_build_object('ok',true,'status',case when p_page->>'kind'='gap' then 'repair_required' else 'native_checked' end,'replayed',false);
 update app.telegram_native_channels set state=p_page->'nextState',needs_baseline=p_page->>'kind'='gap',due_at=case when p_page->>'kind'='empty' then now()+interval '60 seconds' else now() end,last_native_at=now(),error_code=null,lease_token=null,lease_expires_at=null,receipt_id=(p_page->>'pageId')::uuid,receipt_digest=d,receipt_generation=p_generation,receipt_scope=n.scope_digest,receipt_result=result where chat_id=p_feed and account_id=a.id;
 return result||jsonb_build_object('nextPollAt',(select least(now()+interval '60 seconds',coalesce(min(case when feed.chat_id is null or candidate.native_chat_version is distinct from candidate.version then now() else feed.due_at end),now()+interval '60 seconds')) from app.telegram_history_chats candidate join app.telegram_history_jobs j on j.chat_id=candidate.id left join app.telegram_native_channels feed on feed.chat_id=candidate.id where candidate.account_id=a.id and candidate.selected and candidate.peer_kind='channel' and j.status not in('paused','cancelled')));
end $$;
create or replace function app.telegram_native_complete_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_lease uuid,p_page jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;n app.telegram_native_accounts;d bytea;delta bigint;quota app.telegram_history_limits;result jsonb;ch record;reason text;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null then raise exception 'Native account changed' using errcode='40001';end if;
 perform app.telegram_extraction_lock_v1();
 select * into n from app.telegram_native_accounts where account_id=a.id for update;
 if not found or n.generation is distinct from p_generation or n.scope_digest is distinct from app.telegram_native_scope_v1(a.id) then raise exception 'Native scope changed' using errcode='40001';end if;
 if not coalesce(app.telegram_history_keys_v1(p_page,array['pageId','scopeDigest','fromState','nextState','kind','gapReason','changes']) and p_page ?& array['pageId','scopeDigest','fromState','nextState','kind','gapReason','changes'] and jsonb_typeof(p_page->'pageId')='string' and jsonb_typeof(p_page->'scopeDigest')='string',false) or octet_length(p_page::text)>2097152 or p_page->>'scopeDigest' is distinct from n.scope_digest then raise exception 'Invalid native page' using errcode='22023';end if;
 d:=sha256(convert_to(p_page::text,'UTF8'));
 if n.receipt_id=(p_page->>'pageId')::uuid then
 if n.receipt_digest<>d or n.receipt_generation is distinct from p_generation or n.receipt_scope is distinct from n.scope_digest then raise exception 'Native receipt changed' using errcode='40001';end if;return n.receipt_result||jsonb_build_object('replayed',true);end if;
 if p_lease is null or n.lease_token is null or n.lease_token is distinct from p_lease or n.lease_expires_at is null or n.lease_expires_at<=now() or p_page->'fromState' is distinct from coalesce(n.state,'null') then raise exception 'Native lease/state changed' using errcode='40001';end if;
 if not app.telegram_native_state_valid_v1(p_page->'nextState') or p_page->>'kind' is null or p_page->>'kind' not in('baseline','difference','empty','gap') or jsonb_typeof(p_page->'changes') is distinct from 'array' or jsonb_array_length(p_page->'changes')>128 or (p_page->'gapReason'<>'null'::jsonb and (jsonb_typeof(p_page->'gapReason') is distinct from 'string' or p_page->>'gapReason' not in('INITIAL_BASELINE','PROVIDER_GAP','OVERFLOW'))) then raise exception 'Invalid native state' using errcode='22023';end if;
 if (n.needs_baseline and p_page->>'kind'<>'baseline') or (not n.needs_baseline and p_page->>'kind'='baseline') or (p_page->>'kind' in('baseline','empty','gap') and jsonb_array_length(p_page->'changes')<>0) or (p_page->>'kind' in('difference','empty') and p_page->'gapReason'<>'null'::jsonb) or (p_page->>'kind'='baseline' and p_page->'gapReason' not in('null'::jsonb,'"INITIAL_BASELINE"'::jsonb)) or (p_page->>'kind'='gap' and p_page->'gapReason'='null'::jsonb) or (p_page->>'kind'<>'baseline' and n.state is not null and ((p_page#>>'{nextState,pts}')::bigint<(n.state->>'pts')::bigint or (p_page#>>'{nextState,qts}')::bigint<(n.state->>'qts')::bigint or (p_page#>>'{nextState,date}')::bigint<(n.state->>'date')::bigint or ((p_page#>>'{nextState,seq}')::bigint<>0 and (p_page#>>'{nextState,seq}')::bigint<(n.state->>'seq')::bigint))) then raise exception 'Invalid native progression' using errcode='22023';end if;
 perform app.telegram_extraction_lock_v1();select * into quota from app.telegram_history_limits for update;
 delta:=app.telegram_native_apply_changes_v1(a.id,p_page->'changes');
 if quota.stored_bytes+delta>quota.max_bytes then raise exception 'Native source capacity exceeded' using errcode='23514';end if;
 update app.telegram_history_limits set stored_bytes=stored_bytes+delta;
 reason:=p_page->>'gapReason';
 if reason is not null then
 for ch in select c.id from app.telegram_history_chats c join app.telegram_history_jobs j on j.chat_id=c.id where c.account_id=a.id and c.peer_kind<>'channel' and c.selected and j.status not in('paused','cancelled') loop perform app.telegram_native_repair_v1(ch.id,reason);end loop;
 end if;
 result:=jsonb_build_object('ok',true,'status',case when p_page->>'kind'='gap' then 'repair_required' else 'native_checked' end,'replayed',false);
 update app.telegram_native_accounts set state=p_page->'nextState',needs_baseline=p_page->>'kind'='gap',due_at=case when p_page->>'kind'='empty' then now()+interval '60 seconds' else now() end,last_native_at=now(),error_code=null,lease_token=null,lease_expires_at=null,receipt_id=(p_page->>'pageId')::uuid,receipt_digest=d,receipt_generation=p_generation,receipt_scope=n.scope_digest,receipt_result=result where account_id=a.id;
 return result;
end $$;
reset role;set local role app_owner;revoke create on schema app from app_executor;
commit;
