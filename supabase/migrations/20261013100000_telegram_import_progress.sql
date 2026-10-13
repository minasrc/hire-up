-- Cached import progress is updated once per accepted page, never by status polls.
-- Dates describe history reached during import; retained-source search reports
-- its current coverage independently after edits or source disposal.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_history_jobs add column last_progress_at timestamptz;
alter table app.telegram_history_chats add column oldest_imported_at timestamptz,
 add column newest_imported_at timestamptz;
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create or replace function app.telegram_history_complete_v1(p_token text,p_connection uuid,p_generation bigint,p_connection_lease uuid,p_user text,p_job uuid,p_job_lease uuid,p_page jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts; j app.telegram_history_jobs; quota app.telegram_history_limits; receipt app.telegram_history_pages; page_digest bytea; v_page_id uuid; records jsonb; r jsonb; n integer; added bigint; added_bytes bigint; min_id bigint; max_id bigint; result jsonb; next_cursor jsonb; done boolean; begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_connection_lease,p_user);
 if a.id is null then raise exception 'History unavailable' using errcode='40001'; end if;
 select * into j from app.telegram_history_jobs where id=p_job and account_id=a.id for update;
 if not found or j.connection_generation<>p_generation then raise exception 'History job changed' using errcode='40001'; end if;
 if not coalesce(app.telegram_history_keys_v1(p_page,array['pageId','fromCursor','nextCursor','done','records']),false) or octet_length(p_page::text)>307200 then raise exception 'Invalid history page' using errcode='22023'; end if;
 v_page_id:=(p_page->>'pageId')::uuid; page_digest:=sha256(convert_to(p_page::text,'UTF8'));
 select * into receipt from app.telegram_history_pages where job_id=j.id and telegram_history_pages.page_id=v_page_id;
 if found then
 if receipt.digest<>page_digest or receipt.run_id<>j.run_id or receipt.generation<>p_generation then raise exception 'Page receipt changed' using errcode='40001'; end if;
 return receipt.result||jsonb_build_object('replayed',true); end if;
 if j.status<>'leased' or j.lease_token is null or j.lease_token is distinct from p_job_lease or j.lease_expires_at is null or j.lease_expires_at<=clock_timestamp() then raise exception 'History lease changed' using errcode='40001'; end if;
 if p_page->'fromCursor' is distinct from j.cursor then raise exception 'History cursor changed' using errcode='40001'; end if;
 records:=p_page->'records'; next_cursor:=p_page->'nextCursor'; done:=(p_page->>'done')::boolean;
 if jsonb_typeof(records) is distinct from 'array' or jsonb_array_length(records)>100 or jsonb_typeof(p_page->'done') is distinct from 'boolean' or not app.telegram_history_cursor_v1(next_cursor,j.kind) then raise exception 'Invalid history records' using errcode='22023'; end if;
 n:=jsonb_array_length(records);
 if done is distinct from (n=0) or (done and next_cursor is distinct from j.cursor) or (not done and next_cursor=j.cursor) then raise exception 'Invalid history progress' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(records) loop
 if not app.telegram_history_record_v1(r,j.kind) then raise exception 'Invalid history record' using errcode='22023'; end if;
 end loop;
 if not done and exists(select 1 from app.telegram_history_pages p where p.job_id=j.id and p.run_id=j.run_id and p.result->>'status'<>'capacity_paused' and p.cursor_digest=sha256(convert_to(next_cursor::text,'UTF8'))) then raise exception 'Repeated history cursor' using errcode='22023'; end if;
 if j.kind='dialogs' then
 if next_cursor->>'folder' is distinct from j.cursor->>'folder' or (not done and next_cursor->>'excludePinned'<>'true') or (select count(distinct (x->'peer')::text) from jsonb_array_elements(records) x)<>n then raise exception 'Invalid dialog cursor' using errcode='22023'; end if;
 select count(*) into added from jsonb_array_elements(records) x where not exists(select 1 from app.telegram_history_chats ch where ch.account_id=a.id and ch.peer_kind=x->'peer'->>'kind' and ch.peer_id=x->'peer'->>'id'); added_bytes:=0;
 else
 select count(distinct (x->>'messageId')::bigint),min((x->>'messageId')::bigint),max((x->>'messageId')::bigint) into added,min_id,max_id from jsonb_array_elements(records) x;
 if added<>n or (n>0 and ((j.cursor->>'beforeMessageId' is not null and max_id>=(j.cursor->>'beforeMessageId')::bigint) or (next_cursor->>'beforeMessageId')::bigint<>min_id or (next_cursor->>'upperMessageId')::bigint<>coalesce((j.cursor->>'upperMessageId')::bigint,max_id))) then raise exception 'Invalid message cursor' using errcode='22023'; end if;
 if (next_cursor ? 'afterMessageId') is distinct from (j.cursor ? 'afterMessageId') then raise exception 'Sync mode changed' using errcode='22023'; end if;
 if j.cursor ? 'afterMessageId' and (next_cursor->>'afterMessageId' is distinct from j.cursor->>'afterMessageId' or (n>0 and (min_id<=(j.cursor->>'afterMessageId')::bigint or (j.cursor->>'upperMessageId' is not null and max_id>(j.cursor->>'upperMessageId')::bigint)))) then raise exception 'Invalid sync interval' using errcode='22023'; end if;
 select count(*),coalesce(sum(octet_length(x::text)),0) into added,added_bytes from jsonb_array_elements(records) x where not exists(select 1 from app.telegram_history_messages m where m.chat_id=j.chat_id and m.message_id=(x->>'messageId')::bigint) and not exists(select 1 from app.telegram_extraction_sources t where t.chat_id=j.chat_id and t.message_id=(x->>'messageId')::bigint);
 end if;
 select * into quota from app.telegram_history_limits for update;
 if (j.kind='dialogs' and quota.stored_chats+added>quota.max_chats) or (j.kind='history' and (quota.stored_messages+added>quota.max_messages or quota.stored_bytes+added_bytes>quota.max_bytes)) then
 update app.telegram_history_jobs set status='capacity_paused',error_code='CAPACITY_LIMIT',lease_token=null,lease_expires_at=null where id=j.id;
 result:=jsonb_build_object('ok',true,'status','capacity_paused','replayed',false);
 else
 if j.kind='dialogs' then
 insert into app.telegram_history_chats(organization_id,owner_user_id,account_id,peer_kind,peer_id,title,username,last_message_at)
 select a.organization_id,a.owner_user_id,a.id,x->'peer'->>'kind',x->'peer'->>'id',x->>'title',x->>'username',(x->>'lastMessageAt')::timestamptz from jsonb_array_elements(records) x
 on conflict(account_id,peer_kind,peer_id) do update set title=excluded.title,username=excluded.username,last_message_at=excluded.last_message_at;
 update app.telegram_history_limits set stored_chats=stored_chats+added;
 else
 insert into app.telegram_history_messages(organization_id,owner_user_id,chat_id,message_id,body,stored_bytes)
 select a.organization_id,a.owner_user_id,j.chat_id,(x->>'messageId')::bigint,x,octet_length(x::text) from jsonb_array_elements(records) x where not exists(select 1 from app.telegram_extraction_sources t where t.chat_id=j.chat_id and t.message_id=(x->>'messageId')::bigint) on conflict do nothing;
 update app.telegram_history_limits set stored_messages=stored_messages+added,stored_bytes=stored_bytes+added_bytes;
 end if;
 update app.telegram_history_jobs set cursor=next_cursor,status=case when done then 'completed' else 'queued' end,page_number=page_number+1,lease_token=null,lease_expires_at=null,attempts=0,retry_at=null,error_code=null,imported_messages=imported_messages+case when kind='history' then added else 0 end,imported_bytes=imported_bytes+added_bytes where id=j.id;
 if j.kind='history' and done then
 update app.telegram_history_chats set history_completed=true,sync_checkpoint=greatest(sync_checkpoint,coalesce((next_cursor->>'upperMessageId')::bigint,0)),last_sync_at=case when j.cursor ? 'afterMessageId' then clock_timestamp() else last_sync_at end,next_sync_at=case when j.cursor ? 'afterMessageId' then clock_timestamp()+interval '60 seconds' else clock_timestamp() end where id=j.chat_id;
 end if;
 result:=jsonb_build_object('ok',true,'status',case when done then 'completed' else 'queued' end,'replayed',false);
 end if;
 if j.kind='history' and result->>'status' in ('queued','completed') then
 update app.telegram_history_jobs set last_progress_at=clock_timestamp() where id=j.id;
 update app.telegram_history_chats set
 oldest_imported_at=least(oldest_imported_at,(select min((x->>'sentAt')::timestamptz) from jsonb_array_elements(records) x)),
 newest_imported_at=greatest(newest_imported_at,(select max((x->>'sentAt')::timestamptz) from jsonb_array_elements(records) x))
 where id=j.chat_id;
 end if;
 insert into app.telegram_history_pages(organization_id,owner_user_id,job_id,run_id,page_id,generation,cursor_digest,digest,result) values(a.organization_id,a.owner_user_id,j.id,j.run_id,v_page_id,p_generation,sha256(convert_to(j.cursor::text,'UTF8')),page_digest,result);
 return result;
end $$;

create or replace function app.telegram_history_status_v1(p_view text,p_q text,p_after uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare c app.telegram_connections; a app.telegram_history_accounts; limits app.telegram_history_limits; chats jsonb; total bigint; selected_total bigint; discovery jsonb; next_cursor uuid; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_view not in ('all','selected','active','paused') or char_length(p_q)>100 then raise exception 'Invalid history filter' using errcode='22023'; end if;
 select * into c from app.telegram_connections;
 select * into a from app.telegram_history_accounts where connection_id=c.id and (c.status<>'connected' or account_user_id=c.profile->>'telegramUserId') order by updated_at desc limit 1;
 select * into limits from app.telegram_history_limits;
 select count(*),count(*) filter(where selected) into total,selected_total from app.telegram_history_chats where account_id=a.id;
 with records as (
 select ch.id,jsonb_build_object('id',ch.id,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'title',ch.title,'username',ch.username,'selected',ch.selected,'historyCompleted',ch.history_completed,'progress',jsonb_build_object('lastProgressAt',j.last_progress_at,'oldestImportedAt',ch.oldest_imported_at,'newestImportedAt',ch.newest_imported_at),'extractionEnabled',ch.extraction_enabled,'extractionPending',ch.extraction_pending,'version',ch.version,'sync',jsonb_build_object('enabled',ch.selected and ch.history_completed and j.status not in ('paused','cancelled'),'status',case when not ch.selected or j.status='cancelled' then 'off' when not ch.history_completed then 'waiting_for_history' when c.status<>'connected' then 'reconnect_required' when c.lease_expires_at is null or c.lease_expires_at<=clock_timestamp() then 'worker_offline' when j.status='completed' then 'up_to_date' when j.status='leased' then 'syncing' else j.status end,'lastSyncedAt',ch.last_sync_at,'nextSyncAt',ch.next_sync_at,'checkpoint',ch.sync_checkpoint::text),'import',case when j.id is null then null else jsonb_build_object('jobId',j.id,'status',case when j.connection_generation<>c.generation and j.status<>'completed' then 'paused' else j.status end,'importedMessages',j.imported_messages,'importedBytes',j.imported_bytes,'errorCode',case when j.connection_generation<>c.generation and j.status<>'completed' then 'CONNECTION_CHANGED' else j.error_code end,'retryAt',j.retry_at) end) value
 from app.telegram_history_chats ch left join app.telegram_history_jobs j on j.chat_id=ch.id where ch.account_id=a.id and (p_after is null or ch.id>p_after) and (p_q='' or ch.title ilike '%'||p_q||'%' or ch.username ilike '%'||p_q||'%') and (p_view='all' or (p_view='selected' and ch.selected) or (p_view='active' and j.status in ('queued','leased','waiting') and j.connection_generation=c.generation) or (p_view='paused' and (j.status in ('paused','capacity_paused','failed') or (j.connection_generation<>c.generation and j.status<>'completed')))) order by ch.id limit 51
 ), numbered as(select *,row_number() over(order by id) n from records)
 select coalesce(jsonb_agg(value order by id) filter(where n<=50),'[]'::jsonb),case when count(*)>50 then (array_agg(id order by id))[50] end into chats,next_cursor from numbered;
 select jsonb_build_object('status',case when count(*)=0 then 'idle' when bool_and(status='completed') then 'completed' when bool_or(status in ('queued','leased','waiting') and connection_generation=c.generation) then 'active' else 'paused' end,'jobs',coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'errorCode',error_code,'retryAt',retry_at) order by folder),'[]'::jsonb)) into discovery from app.telegram_history_jobs where account_id=a.id and kind='dialogs';
 return jsonb_build_object('connection',case when c.id is null then null else jsonb_build_object('id',c.id,'generation',c.generation,'status',c.status,'accountUserId',c.profile->>'telegramUserId') end,'account',case when a.id is null then null else jsonb_build_object('id',a.id,'accountUserId',a.account_user_id) end,'canImport',coalesce(c.status='connected',false),'blockedReason',case when c.status is distinct from 'connected' then 'NOT_CONNECTED' end,'discovery',discovery,'totals',jsonb_build_object('chats',total,'selected',selected_total,'messages',coalesce(limits.stored_messages,0),'bytes',coalesce(limits.stored_bytes,0),'maxMessages',coalesce(limits.max_messages,200000),'maxBytes',coalesce(limits.max_bytes,268435456)),'chats',chats,'nextCursor',next_cursor);
end $$;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
