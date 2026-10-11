begin;
set local lock_timeout='2s'; set local statement_timeout='30s'; set local role app_owner;
alter table app.telegram_extraction_jobs add column source_invalidated_at timestamptz;
alter table app.telegram_history_chats add column source_needs_reextraction boolean not null default false;
-- Reconciliation is explicitly scoped to retained messages, not a native update feed.
create table app.telegram_source_sweeps(
 organization_id uuid not null, owner_user_id uuid not null, chat_id uuid primary key,
 cursor bigint not null default 0, due_at timestamptz not null default now(), served_at timestamptz not null default 'epoch',
 generation bigint, chat_version bigint, lease_token uuid, lease_expires_at timestamptz, ids jsonb,
 last_checked_at timestamptz, last_cycle_at timestamptz, error_code text,
 receipt_id uuid, receipt_digest bytea, receipt_result jsonb,
 foreign key(organization_id,owner_user_id,chat_id) references app.telegram_history_chats(organization_id,owner_user_id,id)
);
alter table app.telegram_source_sweeps enable row level security; alter table app.telegram_source_sweeps force row level security;
grant select,insert,update,delete on app.telegram_source_sweeps to app_executor;
create policy telegram_source_owner on app.telegram_source_sweeps for all to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')) with check(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
grant create on schema app to app_executor;
reset role; set local role app_executor;
create function app.telegram_source_updates_claim_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts; s app.telegram_source_sweeps; ch app.telegram_history_chats; v_ids jsonb;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null or a.cooldown_until>now() then return jsonb_build_object('job',null); end if;
 insert into app.telegram_source_sweeps(organization_id,owner_user_id,chat_id)
 select candidate.organization_id,candidate.owner_user_id,candidate.id from app.telegram_history_chats candidate where candidate.account_id=a.id and candidate.selected on conflict do nothing;
 select s0.* into s from app.telegram_source_sweeps s0 join app.telegram_history_chats c on c.id=s0.chat_id join app.telegram_history_jobs j on j.chat_id=c.id
 where c.account_id=a.id and c.selected and j.status not in('paused','cancelled') and s0.due_at<=now() order by s0.served_at,s0.chat_id limit 1 for update of s0;
 if not found then return jsonb_build_object('job',null); end if;
 select * into ch from app.telegram_history_chats where id=s.chat_id for share;
 if s.lease_expires_at>now() and s.generation=p_generation and s.chat_version=ch.version then v_ids:=s.ids;
 else
 select coalesce(jsonb_agg(message_id::text order by message_id),'[]') into v_ids from(select message_id from app.telegram_history_messages where chat_id=ch.id and message_id>s.cursor order by message_id limit 4) q;
 if jsonb_array_length(v_ids)=0 then
 update app.telegram_source_sweeps set cursor=0,due_at=now()+interval '60 seconds',served_at=now(),last_cycle_at=now(),lease_token=null,lease_expires_at=null,ids=null where chat_id=ch.id;
 return jsonb_build_object('job',null); end if;
 update app.telegram_source_sweeps set generation=p_generation,chat_version=ch.version,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '120 seconds',ids=v_ids,served_at=now(),error_code=null where chat_id=ch.id returning * into s;
 end if;
 return jsonb_build_object('job',jsonb_build_object('id',ch.id,'connectionId',p_connection,'generation',p_generation,'accountUserId',p_user,'chatVersion',ch.version,'leaseToken',s.lease_token,'leaseExpiresAt',s.lease_expires_at,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'messageIds',v_ids));
end $$;
create function app.telegram_source_updates_complete_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_chat uuid,p_lease uuid,p_page jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts; s app.telegram_source_sweeps; ch app.telegram_history_chats; quota app.telegram_history_limits; r jsonb; m app.telegram_history_messages; jid uuid; delta bigint:=0; d bytea; result jsonb;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null then raise exception 'Connection changed' using errcode='40001'; end if;
 select * into ch from app.telegram_history_chats where id=p_chat and account_id=a.id for share;
 if not found or not ch.selected or exists(select 1 from app.telegram_history_jobs where chat_id=ch.id and status in('paused','cancelled')) then raise exception 'Selection changed' using errcode='40001'; end if;
 select * into s from app.telegram_source_sweeps where chat_id=ch.id for update;
 if not found or s.generation<>p_generation or s.chat_version<>ch.version then raise exception 'Sweep changed' using errcode='40001'; end if;
 if not coalesce(app.telegram_history_keys_v1(p_page,array['pageId','records']),false) or octet_length(p_page::text)>307200 then raise exception 'Invalid source page' using errcode='22023'; end if;
 d:=sha256(convert_to(p_page::text,'UTF8'));
 if s.receipt_id=(p_page->>'pageId')::uuid then
 if s.receipt_digest<>d then raise exception 'Receipt changed' using errcode='40001'; end if; return s.receipt_result||jsonb_build_object('replayed',true); end if;
 if s.lease_token is distinct from p_lease or s.lease_expires_at<=now() then raise exception 'Sweep lease changed' using errcode='40001'; end if;
 if jsonb_typeof(p_page->'records') is distinct from 'array' or jsonb_array_length(p_page->'records')<>jsonb_array_length(s.ids) or (select count(distinct x->>'messageId') from jsonb_array_elements(p_page->'records') x)<>jsonb_array_length(s.ids) then raise exception 'Incomplete source page' using errcode='22023'; end if;
 perform app.telegram_extraction_lock_v1();
 select * into quota from app.telegram_history_limits for update;
 for r in select value from jsonb_array_elements(p_page->'records') loop
 if not coalesce(app.telegram_history_record_v1(r,'history'),false) or not s.ids @> jsonb_build_array(r->>'messageId') then raise exception 'Invalid source record' using errcode='22023'; end if;
 select * into m from app.telegram_history_messages where chat_id=ch.id and message_id=(r->>'messageId')::bigint for update;
 -- Purged raw source is never inserted or restored by a sweep.
 if not found or m.body=r then continue; end if;
 delta:=delta+octet_length(r::text)-m.stored_bytes;
 end loop;
 if quota.stored_bytes+delta>quota.max_bytes then update app.telegram_source_sweeps set lease_token=null,lease_expires_at=null,due_at=now()+interval '60 seconds',error_code='CAPACITY_LIMIT' where chat_id=ch.id; return jsonb_build_object('ok',true,'status','capacity_paused','replayed',false); end if;
 for r in select value from jsonb_array_elements(p_page->'records') loop
 select * into m from app.telegram_history_messages where chat_id=ch.id and message_id=(r->>'messageId')::bigint;
 if not found or m.body=r then continue; end if;
 -- Invalidate the entire dependent batch: leased results and all copied raw evidence
 -- become unusable atomically, while reviewed candidate fields are preserved.
 for jid in select id from app.telegram_extraction_jobs where (m.body-'editedAt') is distinct from (r-'editedAt') and chat_id=ch.id and source is not null and source->'messages' @> jsonb_build_array(jsonb_build_object('messageId',r->>'messageId')) for update loop
 update app.telegram_drafts d0 set fields=case when d0.status in('approved','discarded') then d0.fields else coalesce((select jsonb_object_agg(key,value) from jsonb_each(d0.fields) where key=any(d0.human_fields) or not exists(select 1 from app.telegram_extraction_proposals affected where affected.job_id=jid and affected.draft_id=d0.id and affected.field=key and affected.suggested_value=value) or exists(select 1 from app.telegram_extraction_proposals other join app.telegram_extraction_jobs valid_job on valid_job.id=other.job_id where other.job_id<>jid and other.draft_id=d0.id and other.field=key and other.suggested_value=value and other.status='applied' and valid_job.error_code is distinct from 'SOURCE_CHANGED')),'{}') end,version=version+1,updated_at=now() where id in(select id from app.telegram_retention_drafts_v1(jid));
 update app.telegram_extraction_proposals set status='dismissed',suggested_value='null',evidence='[]' where job_id=jid;
 delete from app.telegram_draft_evidence where evidence_id in(select id from app.telegram_evidence where extraction_job_id=jid);
 delete from app.telegram_evidence where extraction_job_id=jid;
 delete from app.telegram_extraction_attachments where job_id=jid;
 update app.telegram_cv_jobs set source=jsonb_build_object('extractionJobId',jid),source_digest=sha256(convert_to('source-invalidated:'||id::text,'UTF8')) where extraction_job_id=jid;
 update app.telegram_cv_jobs set status='cancelled',lease_token=null,lease_expires_at=null,error_code='SOURCE_CHANGED' where extraction_job_id=jid and status in('queued','leased','waiting');
 update app.telegram_extraction_jobs set source=jsonb_set(source,'{messages}',coalesce((select jsonb_agg(jsonb_build_object('messageId',value->>'messageId','kind','unavailable','sentAt',null,'editedAt',null,'sender',null,'replyToMessageId',null,'forwardedFrom',null,'text','','attachments','[]'::jsonb)) from jsonb_array_elements(source->'messages')),'[]')),source_digest=sha256(convert_to('source-invalidated:'||id::text||':'||(source_version+1)::text,'UTF8')),source_invalidated_at=now(),source_version=source_version+1,status='completed',lease_token=null,lease_expires_at=null,result_digest=null,error_code='SOURCE_CHANGED' where id=jid;
 end loop;
 update app.telegram_history_chats set source_needs_reextraction=true where id=ch.id and m.extraction_job_id is not null and (m.body-'editedAt') is distinct from (r-'editedAt');
 update app.telegram_history_messages set body=r,stored_bytes=octet_length(r::text) where chat_id=ch.id and message_id=m.message_id;
 end loop;
 update app.telegram_history_limits set stored_bytes=stored_bytes+delta;
 result:=jsonb_build_object('ok',true,'status','checked','replayed',false);
 update app.telegram_source_sweeps set cursor=(select max(value::bigint) from jsonb_array_elements_text(s.ids)),lease_token=null,lease_expires_at=null,last_checked_at=now(),receipt_id=(p_page->>'pageId')::uuid,receipt_digest=d,receipt_result=result where chat_id=ch.id;
 return result;
end $$;
create function app.telegram_source_updates_defer_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_chat uuid,p_lease uuid,p_code text,p_delay integer) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null or p_code not in('FLOOD_WAIT','TELEGRAM_UNAVAILABLE','PEER_UNAVAILABLE','PEER_CACHE_MISSING','MESSAGE_TOO_LARGE') or p_delay not between 1 and 604800 then raise exception 'Invalid sweep defer' using errcode='22023'; end if;
 update app.telegram_source_sweeps s set lease_token=null,lease_expires_at=null,due_at=now()+make_interval(secs=>p_delay),error_code=p_code from app.telegram_history_chats c where c.id=s.chat_id and c.account_id=a.id and c.selected and s.chat_id=p_chat and s.generation=p_generation and s.chat_version=c.version and s.lease_token=p_lease;
 if not found then raise exception 'Sweep changed' using errcode='40001'; end if;
 if p_code='FLOOD_WAIT' then update app.telegram_history_accounts set cooldown_until=now()+make_interval(secs=>p_delay) where id=a.id; end if;
 return jsonb_build_object('ok',true);
end $$;
create function app.telegram_source_updates_status_v1() returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 perform app.recruitment_actor_v1(array['candidates.read'],null,null,false);
 return (select coalesce(jsonb_agg(jsonb_build_object('chatId',c.id,'mode','retained_message_reconciliation','needsReextraction',c.source_needs_reextraction,'sourceChangeReason',case when c.source_needs_reextraction then 'SOURCE_CHANGED' end,'cursor',s.cursor::text,'lastCheckedAt',s.last_checked_at,'lastCycleAt',s.last_cycle_at,'nextCheckAt',s.due_at,'errorCode',s.error_code,'status',case when not c.selected then 'off' when cn.status<>'connected' then 'reconnect_required' when cn.lease_expires_at is null or cn.lease_expires_at<=now() then 'worker_offline' when j.status in('paused','cancelled') then 'paused' when s.lease_expires_at>now() then 'checking' when s.error_code is not null then 'waiting' else 'scheduled' end) order by c.id),'[]') from app.telegram_history_chats c join app.telegram_history_accounts a on a.id=c.account_id join app.telegram_connections cn on cn.id=a.connection_id and a.account_user_id=cn.profile->>'telegramUserId' left join app.telegram_source_sweeps s on s.chat_id=c.id left join app.telegram_history_jobs j on j.chat_id=c.id);
end $$;
revoke all on function app.telegram_source_updates_status_v1() from public;
grant execute on function app.telegram_source_updates_status_v1() to app_staff;
revoke all on function app.telegram_source_updates_claim_v1(text,uuid,bigint,uuid,text),app.telegram_source_updates_complete_v1(text,uuid,bigint,uuid,text,uuid,uuid,jsonb),app.telegram_source_updates_defer_v1(text,uuid,bigint,uuid,text,uuid,uuid,text,integer) from public;
grant execute on function app.telegram_source_updates_claim_v1(text,uuid,bigint,uuid,text),app.telegram_source_updates_complete_v1(text,uuid,bigint,uuid,text,uuid,uuid,jsonb),app.telegram_source_updates_defer_v1(text,uuid,bigint,uuid,text,uuid,uuid,text,integer) to app_telegram_worker;
reset role; set local role app_owner; revoke create on schema app from app_executor;
commit;
