begin;
set local lock_timeout='2s';set local statement_timeout='30s';set local role app_owner;
alter table app.telegram_history_chats add column native_repair_requested_at timestamptz,add column native_repair_completed_at timestamptz,add column native_gap_reason text,add column native_chat_version bigint;
alter table app.telegram_history_messages add column source_availability text not null default 'present' check(source_availability in('present','unavailable','deleted'));
reset role;set local row_security=off;
update app.telegram_history_messages set source_availability='unavailable' where body->>'kind'='unavailable';
set local row_security=on;set local role app_owner;
create table app.telegram_native_accounts(
 organization_id uuid not null,owner_user_id uuid not null,account_id uuid primary key,
 state jsonb,needs_baseline boolean not null default true,due_at timestamptz not null default now(),last_native_at timestamptz,error_code text,
 generation bigint,scope_digest text,lease_token uuid,lease_expires_at timestamptz,
 receipt_id uuid,receipt_digest bytea,receipt_generation bigint,receipt_scope text,receipt_result jsonb,
 foreign key(organization_id,owner_user_id,account_id) references app.telegram_history_accounts(organization_id,owner_user_id,id)
);
alter table app.telegram_native_accounts enable row level security;alter table app.telegram_native_accounts force row level security;
grant select,insert,update,delete on app.telegram_native_accounts to app_executor;
create policy telegram_native_owner on app.telegram_native_accounts for all to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')) with check(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
grant create on schema app to app_executor;
reset role;set local role app_executor;
create function app.telegram_native_state_valid_v1(v jsonb) returns boolean language sql immutable set search_path=pg_catalog,app,pg_temp as $$
 select coalesce(app.telegram_history_keys_v1(v,array['pts','qts','date','seq']) and v ?& array['pts','qts','date','seq'] and not exists(select 1 from jsonb_each(v) pair where jsonb_typeof(pair.value)<>'number' or pair.value::text !~ '^[0-9]+$' or (pair.value::text)::numeric>2147483647),false)
$$;
create function app.telegram_native_scope_v1(p_account uuid) returns text language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select encode(sha256(convert_to(coalesce(string_agg(ch.id::text||':'||ch.version::text,',' order by ch.id),''),'UTF8')),'hex') from app.telegram_history_chats ch join app.telegram_history_jobs j on j.chat_id=ch.id where ch.account_id=p_account and ch.peer_kind<>'channel' and ch.selected and j.status not in('paused','cancelled')
$$;
create function app.telegram_native_repair_v1(p_chat uuid,p_reason text) returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin
 update app.telegram_history_chats set native_repair_requested_at=now(),native_gap_reason=p_reason,native_chat_version=version where id=p_chat;
 insert into app.telegram_source_sweeps(organization_id,owner_user_id,chat_id) select organization_id,owner_user_id,id from app.telegram_history_chats where id=p_chat on conflict(chat_id) do nothing;
 update app.telegram_source_sweeps set cursor=0,due_at=now(),lease_token=null,lease_expires_at=null,ids=null where chat_id=p_chat;
end $$;
create function app.telegram_native_claim_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;n app.telegram_native_accounts;scope text;ch record;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null or a.cooldown_until>now() or not exists(select 1 from app.telegram_history_chats c join app.telegram_history_jobs j on j.chat_id=c.id where c.account_id=a.id and c.peer_kind<>'channel' and c.selected and j.status not in('paused','cancelled')) then return jsonb_build_object('job',null);end if;
 perform app.telegram_extraction_lock_v1();
 for ch in select id from app.telegram_history_chats where account_id=a.id and peer_kind<>'channel' and selected and native_chat_version is distinct from version loop perform app.telegram_native_repair_v1(ch.id,'SELECTION_GAP');end loop;
 scope:=app.telegram_native_scope_v1(a.id);
 insert into app.telegram_native_accounts(organization_id,owner_user_id,account_id) values(a.organization_id,a.owner_user_id,a.id) on conflict do nothing;
 select * into n from app.telegram_native_accounts where account_id=a.id for update;
 if n.due_at>now() then return jsonb_build_object('job',null);end if;
 if n.lease_token is null or n.lease_expires_at is null or n.lease_expires_at<=now() or n.generation is distinct from p_generation or n.scope_digest is distinct from scope then
 update app.telegram_native_accounts set generation=p_generation,scope_digest=scope,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '120 seconds' where account_id=a.id returning * into n;
 end if;
 return jsonb_build_object('job',jsonb_build_object('kind','account','id',a.id,'connectionId',p_connection,'generation',p_generation,'accountUserId',p_user,'leaseToken',n.lease_token,'leaseExpiresAt',n.lease_expires_at,'scopeDigest',scope,'fromState',n.state,'baseline',n.needs_baseline));
end $$;
create function app.telegram_native_resolve_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_lease uuid,p_scope text,p_candidates jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;n app.telegram_native_accounts;v jsonb;idx integer:=0;targets jsonb:='[]';item record;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 select * into n from app.telegram_native_accounts where account_id=a.id;
 if a.id is null or n.lease_token is null or p_lease is null or n.lease_token is distinct from p_lease or n.lease_expires_at is null or n.lease_expires_at<=now() or n.generation is distinct from p_generation or n.scope_digest is distinct from p_scope or p_scope is distinct from app.telegram_native_scope_v1(a.id) then raise exception 'Native scope changed' using errcode='40001';end if;
 if jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)>128 or octet_length(p_candidates::text)>65536 then raise exception 'Invalid native targets' using errcode='22023';end if;
 for v in select value from jsonb_array_elements(p_candidates) loop
 if not coalesce(app.telegram_history_keys_v1(v,array['action','peer','messageId']) and v->>'action' in('edit','delete') and v->>'messageId' ~ '^[1-9][0-9]{0,9}$' and (v->>'messageId')::numeric<=2147483647 and (v->'peer'='null'::jsonb or app.telegram_history_peer_v1(v->'peer')) and (v->>'action'='delete' or v->'peer'<>'null'::jsonb),false) then raise exception 'Invalid native target' using errcode='22023';end if;
 for item in select c.id,c.version,c.peer_kind,c.peer_id,m.message_id from app.telegram_history_chats c join app.telegram_history_jobs j on j.chat_id=c.id join app.telegram_history_messages m on m.chat_id=c.id where c.account_id=a.id and c.selected and c.peer_kind<>'channel' and j.status not in('paused','cancelled') and m.message_id=(v->>'messageId')::bigint and (v->'peer'='null'::jsonb or (c.peer_kind=v#>>'{peer,kind}' and c.peer_id=v#>>'{peer,id}')) loop
 if jsonb_array_length(targets)>=128 then return jsonb_build_object('targets','[]'::jsonb,'overflow',true);end if;
 targets:=targets||jsonb_build_array(jsonb_build_object('index',idx,'chatId',item.id,'chatVersion',item.version,'messageId',item.message_id::text,'peer',jsonb_build_object('kind',item.peer_kind,'id',item.peer_id)));
 end loop;idx:=idx+1;
 end loop;
 return jsonb_build_object('targets',targets);
end $$;
create function app.telegram_native_apply_changes_v1(p_account uuid,p_changes jsonb) returns bigint language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare change jsonb;ch app.telegram_history_chats;m app.telegram_history_messages;r jsonb;delta bigint:=0;
begin
 for change in select value from jsonb_array_elements(p_changes) loop
 if not coalesce(app.telegram_history_keys_v1(change,array['action','chatId','chatVersion','messageId','record']) and change->>'action' in('edit','delete') and change->>'chatVersion' ~ '^[1-9][0-9]*$' and change->>'messageId' ~ '^[1-9][0-9]{0,9}$' and (change->>'messageId')::numeric<=2147483647,false) then raise exception 'Invalid native change' using errcode='22023';end if;
 select * into ch from app.telegram_history_chats where id=(change->>'chatId')::uuid and account_id=p_account for share;
 if not found or not ch.selected or ch.peer_kind='channel' or ch.version is distinct from (change->>'chatVersion')::bigint or exists(select 1 from app.telegram_history_jobs where chat_id=ch.id and status in('paused','cancelled')) then raise exception 'Native selection changed' using errcode='40001';end if;
 if change->>'action'='edit' then
 r:=change->'record';if not coalesce(app.telegram_history_record_v1(r,'history') and r->>'messageId'=change->>'messageId',false) then raise exception 'Invalid native record' using errcode='22023';end if;
 else
 if change->'record' is distinct from 'null'::jsonb then raise exception 'Invalid native delete' using errcode='22023';end if;
 r:=jsonb_build_object('messageId',change->>'messageId','kind','unavailable','sentAt',null,'editedAt',null,'sender',null,'replyToMessageId',null,'forwardedFrom',null,'text','','attachments','[]'::jsonb);
 end if;
 select * into m from app.telegram_history_messages where chat_id=ch.id and message_id=(change->>'messageId')::bigint for update;
 -- No raw row means retention already disposed it; never insert or resurrect.
 if not found then continue;end if;
 if m.body is distinct from r then
 if (m.body-'editedAt') is distinct from (r-'editedAt') and m.extraction_job_id is not null then perform app.telegram_source_invalidate_batch_v1(m.extraction_job_id);end if;
 delta:=delta+octet_length(r::text)-m.stored_bytes;
 update app.telegram_history_messages set body=r,stored_bytes=octet_length(r::text) where chat_id=ch.id and message_id=m.message_id;
 end if;
 update app.telegram_history_messages set source_availability=case when change->>'action'='delete' then 'deleted' when r->>'kind'='unavailable' then 'unavailable' else 'present' end where chat_id=ch.id and message_id=m.message_id;
 -- Fence a GetMessages read that started before this native mutation committed.
 update app.telegram_source_sweeps set lease_token=null,lease_expires_at=null where chat_id=ch.id;
 end loop;
 return delta;
end $$;
create function app.telegram_native_complete_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_lease uuid,p_page jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;n app.telegram_native_accounts;d bytea;delta bigint;quota app.telegram_history_limits;result jsonb;ch record;reason text;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null then raise exception 'Native account changed' using errcode='40001';end if;
 select * into n from app.telegram_native_accounts where account_id=a.id for update;
 if not found or n.generation is distinct from p_generation or n.scope_digest is distinct from app.telegram_native_scope_v1(a.id) then raise exception 'Native scope changed' using errcode='40001';end if;
 if not coalesce(app.telegram_history_keys_v1(p_page,array['pageId','scopeDigest','fromState','nextState','kind','gapReason','changes']) and p_page ?& array['pageId','scopeDigest','fromState','nextState','kind','gapReason','changes'] and jsonb_typeof(p_page->'pageId')='string' and jsonb_typeof(p_page->'scopeDigest')='string',false) or octet_length(p_page::text)>2097152 or p_page->>'scopeDigest' is distinct from n.scope_digest then raise exception 'Invalid native page' using errcode='22023';end if;
 d:=sha256(convert_to(p_page::text,'UTF8'));
 if n.receipt_id=(p_page->>'pageId')::uuid then
 if n.receipt_digest<>d or n.receipt_generation is distinct from p_generation or n.receipt_scope is distinct from n.scope_digest then raise exception 'Native receipt changed' using errcode='40001';end if;return n.receipt_result||jsonb_build_object('replayed',true);end if;
 if p_lease is null or n.lease_token is null or n.lease_token is distinct from p_lease or n.lease_expires_at is null or n.lease_expires_at<=now() or p_page->'fromState' is distinct from coalesce(n.state,'null') then raise exception 'Native lease/state changed' using errcode='40001';end if;
 if not app.telegram_native_state_valid_v1(p_page->'nextState') or p_page->>'kind' is null or p_page->>'kind' not in('baseline','difference','empty','gap') or jsonb_typeof(p_page->'changes') is distinct from 'array' or jsonb_array_length(p_page->'changes')>128 or (p_page->'gapReason'<>'null'::jsonb and p_page->>'gapReason' not in('INITIAL_BASELINE','PROVIDER_GAP','OVERFLOW')) then raise exception 'Invalid native state' using errcode='22023';end if;
 if (n.needs_baseline and p_page->>'kind'<>'baseline') or (not n.needs_baseline and p_page->>'kind'='baseline') or (p_page->>'kind' in('baseline','empty','gap') and jsonb_array_length(p_page->'changes')<>0) or (p_page->>'kind'='gap' and p_page->'gapReason'='null'::jsonb) or (p_page->>'kind'<>'baseline' and n.state is not null and (p_page#>>'{nextState,pts}')::bigint<(n.state->>'pts')::bigint) then raise exception 'Invalid native progression' using errcode='22023';end if;
 perform app.telegram_extraction_lock_v1();select * into quota from app.telegram_history_limits for update;
 delta:=app.telegram_native_apply_changes_v1(a.id,p_page->'changes');
 if quota.stored_bytes+delta>quota.max_bytes then raise exception 'Native source capacity exceeded' using errcode='23514';end if;
 update app.telegram_history_limits set stored_bytes=stored_bytes+delta;
 reason:=p_page->>'gapReason';
 if reason is not null then
 for ch in select c.id from app.telegram_history_chats c join app.telegram_history_jobs j on j.chat_id=c.id where c.account_id=a.id and c.peer_kind<>'channel' and c.selected and j.status not in('paused','cancelled') loop perform app.telegram_native_repair_v1(ch.id,reason);end loop;
 end if;
 result:=jsonb_build_object('ok',true,'status',case when p_page->>'kind'='gap' then 'repair_required' else 'native_checked' end,'replayed',false);
 update app.telegram_native_accounts set state=p_page->'nextState',needs_baseline=p_page->>'kind'='gap',due_at=case when p_page->>'kind'='empty' then now()+interval '5 seconds' else now() end,last_native_at=now(),error_code=null,lease_token=null,lease_expires_at=null,receipt_id=(p_page->>'pageId')::uuid,receipt_digest=d,receipt_generation=p_generation,receipt_scope=n.scope_digest,receipt_result=result where account_id=a.id;
 return result;
end $$;
create function app.telegram_native_defer_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_lease uuid,p_code text,p_delay integer) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;ch record;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null or p_lease is null or p_code is null or p_code not in('FLOOD_WAIT','TELEGRAM_UNAVAILABLE','INVALID_RESULT','CAPACITY_LIMIT','PROVIDER_GAP') or p_delay is null or p_delay not between 1 and 604800 then raise exception 'Invalid native defer' using errcode='22023';end if;
 update app.telegram_native_accounts set lease_token=null,lease_expires_at=null,due_at=now()+make_interval(secs=>p_delay),error_code=p_code,needs_baseline=needs_baseline or p_code='PROVIDER_GAP' where account_id=a.id and generation=p_generation and lease_token=p_lease;
 if not found then raise exception 'Native lease changed' using errcode='40001';end if;
 if p_code='PROVIDER_GAP' then
 perform app.telegram_extraction_lock_v1();
 for ch in select c.id from app.telegram_history_chats c join app.telegram_history_jobs j on j.chat_id=c.id where c.account_id=a.id and c.peer_kind<>'channel' and c.selected and j.status not in('paused','cancelled') loop perform app.telegram_native_repair_v1(ch.id,'PROVIDER_GAP');end loop;
 end if;
 if p_code='FLOOD_WAIT' then update app.telegram_history_accounts set cooldown_until=now()+make_interval(secs=>p_delay) where id=a.id;end if;
 return jsonb_build_object('ok',true);
end $$;
alter function app.telegram_source_updates_status_v1(uuid[]) rename to telegram_source_updates_status_before_native_account_v1;
revoke all on function app.telegram_source_updates_status_before_native_account_v1(uuid[]) from app_staff;
create function app.telegram_source_updates_status_v1(p_chat_ids uuid[]) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ declare rows jsonb;begin
 rows:=app.telegram_source_updates_status_before_native_account_v1(p_chat_ids);
 return (select coalesce(jsonb_agg(row.value||case when c.peer_kind='channel' then '{}'::jsonb else jsonb_build_object('mode','native_updates_with_reconciliation','nativeStatus',case when n.state is null then 'baseline_pending' when n.error_code is not null then 'waiting' when n.needs_baseline or (c.native_repair_requested_at is not null and (c.native_repair_completed_at is null or c.native_repair_completed_at<c.native_repair_requested_at) and (s.last_cycle_at is null or s.last_cycle_at<c.native_repair_requested_at)) then 'repair_required' else 'live' end,'lastNativeAt',n.last_native_at,'repairRequestedAt',c.native_repair_requested_at,'repairCompletedAt',case when s.last_cycle_at>=c.native_repair_requested_at then greatest(s.last_cycle_at,c.native_repair_completed_at) else c.native_repair_completed_at end,'gapReason',c.native_gap_reason,'nativeErrorCode',n.error_code) end order by row.value->>'chatId'),'[]') from jsonb_array_elements(rows) row(value) join app.telegram_history_chats c on c.id=(row.value->>'chatId')::uuid left join app.telegram_native_accounts n on n.account_id=c.account_id left join app.telegram_source_sweeps s on s.chat_id=c.id);
end $$;
revoke all on function app.telegram_source_updates_status_v1(uuid[]) from public;
grant execute on function app.telegram_source_updates_status_v1(uuid[]) to app_staff;
-- Restrict every helper, including validation functions, to the definer boundary.
do $$ declare f record;begin for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='app' and p.proname like 'telegram_native_%' loop execute format('revoke all on function %s from public',f.signature);end loop;end $$;
grant execute on function app.telegram_native_claim_v1(text,uuid,bigint,uuid,text),app.telegram_native_resolve_v1(text,uuid,bigint,uuid,text,uuid,text,jsonb),app.telegram_native_complete_v1(text,uuid,bigint,uuid,text,uuid,jsonb),app.telegram_native_defer_v1(text,uuid,bigint,uuid,text,uuid,text,integer) to app_telegram_worker;
reset role;set local role app_owner;revoke create on schema app from app_executor;
commit;
