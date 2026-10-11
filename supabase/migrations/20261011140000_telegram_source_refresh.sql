begin;
set local lock_timeout='2s'; set local statement_timeout='30s'; set local role app_owner;
alter table app.telegram_extraction_sources add column origin_job_id uuid references app.telegram_extraction_jobs(id);
reset role; set local row_security=off;
update app.telegram_history_chats set extraction_pending=true where source_needs_reextraction and extraction_enabled;
update app.telegram_extraction_sources set origin_job_id=job_id;
set local row_security=on; set local role app_owner;
alter table app.telegram_extraction_sources alter column origin_job_id set not null;
alter table app.telegram_extraction_jobs add column source_refresh boolean not null default false, add column source_chat_version bigint, add column source_connection_generation bigint, add column source_origin_jobs uuid[] not null default '{}';
create index telegram_source_origin_idx on app.telegram_extraction_sources(origin_job_id,chat_id,message_id);
create index telegram_refresh_origin_idx on app.telegram_extraction_jobs using gin(source_origin_jobs);
grant trigger on app.telegram_extraction_sources to app_executor;
grant create on schema app to app_executor;
reset role; set local role app_executor;
create function app.telegram_source_origin_v1() returns trigger language plpgsql set search_path=pg_catalog,app,pg_temp as $$ begin
 if tg_op='INSERT' and new.origin_job_id is null then new.origin_job_id:=new.job_id; end if;
 if tg_op='UPDATE' and new.origin_job_id is distinct from old.origin_job_id then raise exception 'Source origin is immutable' using errcode='23514'; end if;
 return new;
end $$;
revoke all on function app.telegram_source_origin_v1() from public;
create trigger telegram_source_origin before insert or update on app.telegram_extraction_sources for each row execute function app.telegram_source_origin_v1();
create function app.telegram_source_invalidate_batch_v1(jid uuid) returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin
 if not exists(select 1 from app.telegram_extraction_jobs where id=jid and source is not null and source_invalidated_at is null and source_purged_at is null) then return; end if;
 update app.telegram_drafts d0 set fields=case when d0.status in('approved','discarded') then d0.fields else coalesce((select jsonb_object_agg(key,value) from jsonb_each(d0.fields) where key=any(d0.human_fields) or not exists(select 1 from app.telegram_extraction_proposals affected where affected.job_id=jid and affected.draft_id=d0.id and affected.field=key and affected.suggested_value=value) or exists(select 1 from app.telegram_extraction_proposals other join app.telegram_extraction_jobs valid_job on valid_job.id=other.job_id where other.job_id<>jid and other.draft_id=d0.id and other.field=key and other.suggested_value=value and other.status='applied' and valid_job.error_code is distinct from 'SOURCE_CHANGED')),'{}') end,version=version+1,updated_at=now() where id in(select id from app.telegram_retention_drafts_v1(jid));
 update app.telegram_extraction_proposals set status='dismissed',suggested_value='null',evidence='[]' where job_id=jid;
 delete from app.telegram_draft_evidence where evidence_id in(select id from app.telegram_evidence where extraction_job_id=jid);
 delete from app.telegram_evidence where extraction_job_id=jid;
 delete from app.telegram_extraction_attachments where job_id=jid;
 update app.telegram_cv_jobs set source=jsonb_build_object('extractionJobId',jid),source_digest=sha256(convert_to('source-invalidated:'||id::text,'UTF8')) where extraction_job_id=jid;
 update app.telegram_cv_jobs set status='cancelled',lease_token=null,lease_expires_at=null,error_code='SOURCE_CHANGED' where extraction_job_id=jid and status in('queued','leased','waiting');
 update app.telegram_extraction_jobs set source=jsonb_set(source,'{messages}',coalesce((select jsonb_agg(jsonb_build_object('messageId',value->>'messageId','kind','unavailable','sentAt',null,'editedAt',null,'sender',null,'replyToMessageId',null,'forwardedFrom',null,'text','','attachments','[]'::jsonb)) from jsonb_array_elements(source->'messages')),'[]')),source_digest=sha256(convert_to('source-invalidated:'||id::text||':'||(source_version+1)::text,'UTF8')),source_invalidated_at=now(),source_version=source_version+1,status='completed',lease_token=null,lease_expires_at=null,result_digest=null,error_code='SOURCE_CHANGED' where id=jid;
 update app.telegram_history_chats set source_needs_reextraction=true,extraction_pending=true where id=(select chat_id from app.telegram_extraction_jobs where id=jid);
end $$;
revoke all on function app.telegram_source_invalidate_batch_v1(uuid) from public;
create or replace function app.telegram_source_updates_complete_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_chat uuid,p_lease uuid,p_page jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts; s app.telegram_source_sweeps; ch app.telegram_history_chats; quota app.telegram_history_limits; r jsonb; m app.telegram_history_messages; jid uuid; delta bigint:=0; d bytea; result jsonb;
begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null then raise exception 'Connection changed' using errcode='40001'; end if;
 select * into ch from app.telegram_history_chats where id=p_chat and account_id=a.id;
 if not found or not ch.selected or exists(select 1 from app.telegram_history_jobs where chat_id=ch.id and status in('paused','cancelled')) then raise exception 'Selection changed' using errcode='40001'; end if;
 select * into s from app.telegram_source_sweeps where chat_id=ch.id for update;
 if not found or s.generation<>p_generation or s.chat_version<>ch.version then raise exception 'Sweep changed' using errcode='40001'; end if;
 if not coalesce(app.telegram_history_keys_v1(p_page,array['pageId','records']),false) or octet_length(p_page::text)>307200 then raise exception 'Invalid source page' using errcode='22023'; end if;
 d:=sha256(convert_to(p_page::text,'UTF8'));
 if s.receipt_id=(p_page->>'pageId')::uuid then
 if s.receipt_digest<>d then raise exception 'Receipt changed' using errcode='40001'; end if; return s.receipt_result||jsonb_build_object('replayed',true); end if;
 if p_lease is null or s.lease_token is null or s.lease_expires_at is null or s.lease_token is distinct from p_lease or s.lease_expires_at<=now() then raise exception 'Sweep lease changed' using errcode='40001'; end if;
 if jsonb_typeof(p_page->'records') is distinct from 'array' or jsonb_array_length(p_page->'records')<>jsonb_array_length(s.ids) or (select count(distinct x->>'messageId') from jsonb_array_elements(p_page->'records') x)<>jsonb_array_length(s.ids) then raise exception 'Incomplete source page' using errcode='22023'; end if;
 perform app.telegram_extraction_lock_v1();
 select * into ch from app.telegram_history_chats where id=p_chat and account_id=a.id for share;
 if not found or not ch.selected or ch.version<>s.chat_version or exists(select 1 from app.telegram_history_jobs where chat_id=ch.id and status in('paused','cancelled')) then raise exception 'Selection changed' using errcode='40001'; end if;
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
 for jid in select id from app.telegram_extraction_jobs where (m.body-'editedAt') is distinct from (r-'editedAt') and id=m.extraction_job_id and chat_id=ch.id and source is not null and source_invalidated_at is null and source_purged_at is null and source->'messages' @> jsonb_build_array(jsonb_build_object('messageId',r->>'messageId')) for update loop
 perform app.telegram_source_invalidate_batch_v1(jid);
 end loop;
 update app.telegram_history_chats set source_needs_reextraction=true,extraction_pending=true where id=ch.id and m.extraction_job_id is not null and (m.body-'editedAt') is distinct from (r-'editedAt');
 update app.telegram_history_messages set body=r,stored_bytes=octet_length(r::text) where chat_id=ch.id and message_id=m.message_id;
 end loop;
 update app.telegram_history_limits set stored_bytes=stored_bytes+delta;
 result:=jsonb_build_object('ok',true,'status','checked','replayed',false);
 update app.telegram_source_sweeps set cursor=(select max(value::bigint) from jsonb_array_elements_text(s.ids)),lease_token=null,lease_expires_at=null,last_checked_at=now(),receipt_id=(p_page->>'pageId')::uuid,receipt_digest=d,receipt_result=result where chat_id=ch.id;
 return result;
end $$;
create or replace function app.telegram_extraction_enqueue_v1(p_chat uuid) returns boolean language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare ch app.telegram_history_chats; a app.telegram_history_accounts; m record; src jsonb; trial jsonb; jid uuid; n integer:=0; refresh boolean:=false; gen bigint; origins uuid[];
begin
 select * into ch from app.telegram_history_chats where id=p_chat for share;
 if not found then raise exception 'Chat unavailable' using errcode='P0002'; end if;
 if not ch.extraction_enabled then return false; end if;
 if ch.source_needs_reextraction and (not ch.selected or exists(select 1 from app.telegram_history_jobs where chat_id=p_chat and status in('paused','cancelled'))) then update app.telegram_history_chats set extraction_served_at=now() where id=p_chat; return false; end if;
 if exists(select 1 from app.telegram_extraction_jobs where chat_id=p_chat and status<>'completed') then update app.telegram_history_chats set extraction_pending=ch.source_needs_reextraction,extraction_served_at=now() where id=p_chat; return false; end if;
 select * into strict a from app.telegram_history_accounts where id=ch.account_id;
 src:=jsonb_build_object('chat',jsonb_build_object('id',ch.id,'title',ch.title,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'accountUserId',a.account_user_id),'messages','[]'::jsonb);
 for m in select h.body from app.telegram_history_messages h where h.chat_id=p_chat and (h.extraction_job_id is null or exists(select 1 from app.telegram_extraction_jobs previous join app.telegram_extraction_sources ledger on ledger.chat_id=h.chat_id and ledger.message_id=h.message_id join app.telegram_extraction_jobs origin on origin.id=ledger.origin_job_id where previous.id=h.extraction_job_id and previous.source_invalidated_at is not null and previous.source_purged_at is null and origin.source_release_requested_at is null and origin.source_purged_at is null)) order by h.message_id desc limit 40 loop
 trial:=jsonb_set(src,'{messages}',(src->'messages')||jsonb_build_array(m.body));
 if octet_length(trial::text)>49152 then
  if n=0 and octet_length(trial::text)<=327680 then src:=trial; n:=1; exit; end if;
  if n=0 then raise exception 'Legal history message exceeds singleton envelope' using errcode='22023'; end if;
  exit;
 end if;
 src:=trial; n:=n+1;
 end loop;
 if n=0 then update app.telegram_history_chats set source_needs_reextraction=exists(select 1 from app.telegram_history_messages h join app.telegram_extraction_jobs old_job on old_job.id=h.extraction_job_id where h.chat_id=p_chat and old_job.source_invalidated_at is not null),extraction_pending=false,extraction_served_at=now() where id=p_chat; return false; end if;
 select exists(select 1 from app.telegram_history_messages h join app.telegram_extraction_jobs old_job on old_job.id=h.extraction_job_id where h.chat_id=p_chat and old_job.source_invalidated_at is not null and src->'messages' @> jsonb_build_array(jsonb_build_object('messageId',h.message_id::text))) into refresh;
 select coalesce(array_agg(distinct ledger.origin_job_id),'{}') into origins from app.telegram_extraction_sources ledger where ledger.chat_id=p_chat and src->'messages' @> jsonb_build_array(jsonb_build_object('messageId',ledger.message_id::text));
 select generation into gen from app.telegram_connections where id=a.connection_id and status='connected' and profile->>'telegramUserId'=a.account_user_id;
 if refresh and gen is null then update app.telegram_history_chats set extraction_served_at=now() where id=p_chat; return false; end if;
 insert into app.telegram_extraction_jobs(organization_id,owner_user_id,chat_id,source,source_digest,message_count,source_refresh,source_chat_version,source_connection_generation,source_origin_jobs)
 values(ch.organization_id,ch.owner_user_id,p_chat,src,sha256(convert_to(src::text,'UTF8')),n,refresh,case when refresh then ch.version end,case when refresh then gen end,origins) returning id into jid;
 insert into app.telegram_extraction_sources(organization_id,owner_user_id,chat_id,message_id,job_id,origin_job_id)
 select ch.organization_id,ch.owner_user_id,p_chat,(value->>'messageId')::bigint,jid,jid from jsonb_array_elements(src->'messages') on conflict(chat_id,message_id) do update set job_id=excluded.job_id;
 update app.telegram_history_messages set extraction_job_id=jid where chat_id=p_chat and message_id in(select (value->>'messageId')::bigint from jsonb_array_elements(src->'messages'));
 update app.telegram_history_chats set source_needs_reextraction=ch.source_needs_reextraction or refresh,extraction_pending=ch.source_needs_reextraction or refresh,extraction_served_at=now() where id=p_chat;
 return true;
end $$;

create function app.telegram_source_refresh_scope_v1(j app.telegram_extraction_jobs) returns boolean language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select not j.source_refresh or exists(select 1 from app.telegram_history_chats ch join app.telegram_history_accounts a on a.id=ch.account_id join app.telegram_connections c on c.id=a.connection_id where ch.id=j.chat_id and ch.selected and ch.extraction_enabled and ch.version=j.source_chat_version and c.status='connected' and c.generation=j.source_connection_generation and c.profile->>'telegramUserId'=a.account_user_id and not exists(select 1 from app.telegram_extraction_jobs origin where origin.id=any(j.source_origin_jobs) and (origin.source_release_requested_at is not null or origin.source_purged_at is not null)) and not exists(select 1 from app.telegram_history_jobs hj where hj.chat_id=ch.id and hj.status in('paused','cancelled')))
$$;
revoke all on function app.telegram_source_refresh_scope_v1(app.telegram_extraction_jobs) from public;
alter function app.telegram_extraction_claim_v1(text) rename to telegram_extraction_claim_before_source_refresh_v1;
revoke all on function app.telegram_extraction_claim_before_source_refresh_v1(text) from app_telegram_worker;
create function app.telegram_extraction_claim_v1(p_token text) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ declare jid uuid; begin
 perform app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 for jid in select id from app.telegram_extraction_jobs j where source_refresh and status<>'completed' and not app.telegram_source_refresh_scope_v1(j) order by created_at,id limit 10 for update loop perform app.telegram_source_invalidate_batch_v1(jid); end loop;
 return app.telegram_extraction_claim_before_source_refresh_v1(p_token);
end $$;
alter function app.telegram_extraction_complete_v1(text,uuid,uuid,text,jsonb,jsonb) rename to telegram_extraction_complete_before_source_refresh_v1;
revoke all on function app.telegram_extraction_complete_before_source_refresh_v1(text,uuid,uuid,text,jsonb,jsonb) from app_telegram_worker;
create function app.telegram_extraction_complete_v1(p_token text,p_job uuid,p_lease uuid,p_source_digest text,p_result jsonb,p_metadata jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ declare j app.telegram_extraction_jobs; begin
 perform app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 select * into j from app.telegram_extraction_jobs where id=p_job for update;
 if j.source_refresh then perform 1 from app.telegram_history_chats ch join app.telegram_history_accounts a on a.id=ch.account_id join app.telegram_connections c on c.id=a.connection_id where ch.id=j.chat_id for share of ch,c; end if;
 if not found or not app.telegram_source_refresh_scope_v1(j) then raise exception 'Refresh scope changed' using errcode='40001'; end if;
 return app.telegram_extraction_complete_before_source_refresh_v1(p_token,p_job,p_lease,p_source_digest,p_result,p_metadata);
end $$;
revoke all on function app.telegram_extraction_claim_v1(text),app.telegram_extraction_complete_v1(text,uuid,uuid,text,jsonb,jsonb) from public;
grant execute on function app.telegram_extraction_claim_v1(text),app.telegram_extraction_complete_v1(text,uuid,uuid,text,jsonb,jsonb) to app_telegram_worker;
alter function app.telegram_extraction_action_v1(jsonb) rename to telegram_extraction_action_before_source_refresh_v1;
revoke all on function app.telegram_extraction_action_before_source_refresh_v1(jsonb) from app_staff;
create function app.telegram_extraction_action_v1(p_input jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ declare r jsonb; begin
 r:=app.telegram_extraction_action_before_source_refresh_v1(p_input);
 if p_input->>'action'='sourceRetention' and p_input->>'mode'='keep' then
 update app.telegram_history_chats ch set source_needs_reextraction=true,extraction_pending=true where exists(select 1 from app.telegram_history_messages h join app.telegram_extraction_sources ledger on ledger.chat_id=h.chat_id and ledger.message_id=h.message_id join app.telegram_extraction_jobs previous on previous.id=h.extraction_job_id where h.chat_id=ch.id and ledger.origin_job_id=(p_input->>'jobId')::uuid and previous.source_invalidated_at is not null);
 end if;
 return r;
end $$;
revoke all on function app.telegram_extraction_action_v1(jsonb) from public;
grant execute on function app.telegram_extraction_action_v1(jsonb) to app_staff;
alter function app.telegram_retention_drafts_v1(uuid) rename to telegram_retention_drafts_before_source_refresh_v1;
create function app.telegram_retention_drafts_v1(p_job uuid) returns table(id uuid) language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select id from app.telegram_retention_drafts_before_source_refresh_v1(p_job)
 union select d.id from app.telegram_extraction_jobs descendant cross join lateral app.telegram_retention_drafts_before_source_refresh_v1(descendant.id) d where descendant.source_origin_jobs @> array[p_job]
$$;
revoke all on function app.telegram_retention_drafts_v1(uuid) from public;
alter function app.telegram_retention_purge_v1(uuid) rename to telegram_retention_purge_before_source_refresh_v1;
create function app.telegram_retention_purge_v1(p_job uuid) returns jsonb language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ declare r jsonb; descendant uuid; removed bigint; bytes bigint; begin
 perform app.telegram_extraction_lock_v1();
 -- Preserve existing review holds before invalidating in-flight refreshes.
 if not exists(select 1 from app.telegram_extraction_jobs where id=p_job and status='completed' and source_release_requested_at is not null and source_purged_at is null) then return jsonb_build_object('purged',false); end if;
 if exists(select 1 from app.telegram_drafts d join app.telegram_retention_drafts_v1(p_job) held on held.id=d.id where d.status not in('approved','discarded')) or exists(select 1 from app.telegram_extraction_proposals p join app.telegram_extraction_jobs j on j.id=p.job_id where p.status='pending' and (j.id=p_job or j.source_origin_jobs @> array[p_job])) then return app.telegram_retention_purge_before_source_refresh_v1(p_job); end if;
 for descendant in select id from app.telegram_extraction_jobs where source is not null and id<>p_job and source_origin_jobs @> array[p_job] for update nowait loop perform app.telegram_source_invalidate_batch_v1(descendant); end loop;
 r:=app.telegram_retention_purge_before_source_refresh_v1(p_job);
 if (r->>'purged')::boolean then
 with gone as(delete from app.telegram_history_messages h using app.telegram_extraction_sources origin where origin.chat_id=h.chat_id and origin.message_id=h.message_id and origin.origin_job_id=p_job returning h.stored_bytes) select count(*),coalesce(sum(stored_bytes),0) into removed,bytes from gone;
 update app.telegram_history_limits set stored_messages=stored_messages-removed,stored_bytes=stored_bytes-bytes;
 r:=r||jsonb_build_object('messages',(r->>'messages')::bigint+removed,'bytes',(r->>'bytes')::bigint+bytes);
 end if;
 return r;
end $$;
revoke all on function app.telegram_retention_purge_v1(uuid) from public;
revoke all on function app.telegram_source_updates_status_v1() from app_staff;
drop function app.telegram_source_updates_status_v1();
create function app.telegram_source_updates_status_v1(p_chat_ids uuid[]) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 if p_chat_ids is null or cardinality(p_chat_ids) not between 1 and 50 or array_position(p_chat_ids,null) is not null then raise exception 'Invalid chat selection' using errcode='22023'; end if;
 perform app.recruitment_actor_v1(array['candidates.read'],null,null,false);
 return (select coalesce(jsonb_agg(jsonb_build_object('chatId',c.id,'mode','retained_message_reconciliation','needsReextraction',c.source_needs_reextraction,'sourceChangeReason',case when c.source_needs_reextraction then 'SOURCE_CHANGED' end,'cursor',s.cursor::text,'lastCheckedAt',s.last_checked_at,'lastCycleAt',s.last_cycle_at,'nextCheckAt',s.due_at,'errorCode',s.error_code,'status',case when not c.selected then 'off' when cn.status<>'connected' then 'reconnect_required' when cn.lease_expires_at is null or cn.lease_expires_at<=now() then 'worker_offline' when j.status in('paused','cancelled') then 'paused' when s.lease_expires_at>now() then 'checking' when s.error_code is not null then 'waiting' else 'scheduled' end) order by c.id),'[]') from app.telegram_history_chats c join app.telegram_history_accounts a on a.id=c.account_id join app.telegram_connections cn on cn.id=a.connection_id and a.account_user_id=cn.profile->>'telegramUserId' left join app.telegram_source_sweeps s on s.chat_id=c.id left join app.telegram_history_jobs j on j.chat_id=c.id where c.id=any(p_chat_ids));
end $$;
revoke all on function app.telegram_source_updates_status_v1(uuid[]) from public;
grant execute on function app.telegram_source_updates_status_v1(uuid[]) to app_staff;
reset role; set local role app_owner; revoke create on schema app from app_executor;
commit;
