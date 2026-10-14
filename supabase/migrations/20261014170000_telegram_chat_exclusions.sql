begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_history_chats add column excluded boolean not null default false;
alter table app.telegram_history_chats add constraint telegram_excluded_not_processing check(not excluded or (not selected and not extraction_enabled and not extraction_pending));
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create function app.telegram_chat_exclusion_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare item jsonb; ch app.telegram_history_chats; hidden boolean; items jsonb;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform app.telegram_extraction_lock_v1();
 if p_input->>'action' is null or p_input->>'action' not in ('exclude','excludeMany','restore') then raise exception 'Invalid action' using errcode='22023'; end if;
 hidden:=p_input->>'action'<>'restore';
 items:=case when p_input->>'action'='excludeMany' then p_input->'chats' else jsonb_build_array(p_input) end;
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items) not between 1 and 50 then raise exception 'Invalid chats' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(items) order by value->>'chatId' loop
 select * into ch from app.telegram_history_chats where id=(item->>'chatId')::uuid for update;
 if not found then raise exception 'Chat unavailable' using errcode='P0002'; end if;
 if ch.version is distinct from (item->>'expectedVersion')::bigint then raise exception 'Chat changed' using errcode='40001'; end if;
 if hidden then
 -- Cancel history/CV leases and fence model results already in flight.
 update app.telegram_cv_jobs set status='cancelled',lease_token=null,lease_worker_id=null,lease_expires_at=null,error_code='CHAT_EXCLUDED',updated_at=now()
 where extraction_job_id in(select id from app.telegram_extraction_jobs where chat_id=ch.id) and status in('queued','leased','waiting');
 update app.cv_analyses set status='cancelled',lease_token=null,lease_worker_id=null,lease_expires_at=null,error_code='CHAT_EXCLUDED',version=version+1,updated_at=now()
 where extraction_job_id in(select id from app.telegram_extraction_jobs where chat_id=ch.id) and status in('queued','leased','waiting');
 update app.telegram_history_jobs set status='cancelled',lease_token=null,lease_expires_at=null where chat_id=ch.id;
 update app.telegram_extraction_jobs set status='queued',lease_token=null,lease_worker_id=null,lease_expires_at=null where chat_id=ch.id and status='leased';
 update app.telegram_history_chats set excluded=true,selected=false,extraction_enabled=false,extraction_pending=false,version=version+1 where id=ch.id;
 else
 -- Restoring visibility never starts an import or resumes processing.
 update app.telegram_history_chats set excluded=false,version=version+1 where id=ch.id;
 end if;
 end loop;
 return jsonb_build_object('ok',true);
end $$;
revoke all on function app.telegram_chat_exclusion_v1(jsonb) from public;
grant execute on function app.telegram_chat_exclusion_v1(jsonb) to app_staff;
create or replace function app.telegram_history_status_v2(p_view text,p_q text,p_after jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare c app.telegram_connections; a app.telegram_history_accounts; limits app.telegram_history_limits; chats jsonb; total bigint; selected_total bigint; available_total bigint; connected_total bigint; excluded_total bigint; discovery jsonb; next_cursor jsonb; anchor_id uuid; anchor_at timestamptz; rows jsonb; result jsonb; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_view is null or p_q is null or p_view not in ('all','selected','active','paused','available','connected','excluded') or char_length(p_q)>100 then raise exception 'Invalid history filter' using errcode='22023'; end if;
 select * into c from app.telegram_connections;
 select * into a from app.telegram_history_accounts where connection_id=c.id and (c.status<>'connected' or account_user_id=c.profile->>'telegramUserId') order by updated_at desc limit 1;

 if p_after is not null then
   if jsonb_typeof(p_after)<>'object' or octet_length(p_after::text)>2048 then raise exception 'Invalid cursor' using errcode='22023'; end if;
   if p_after ? 'legacyId' and (select count(*) from jsonb_object_keys(p_after))=1 then
     select id,last_message_at into anchor_id,anchor_at from app.telegram_history_chats where account_id=a.id and id=(p_after->>'legacyId')::uuid;
   else
     if (select count(*) from jsonb_object_keys(p_after))<>6 or p_after->'v' is distinct from '1'::jsonb or p_after->>'accountId' is distinct from a.id::text or p_after->>'view' is distinct from p_view or p_after->>'q' is distinct from p_q or not(p_after ? 'lastMessageAt') or jsonb_typeof(p_after->'lastMessageAt') not in ('string','null') or jsonb_typeof(p_after->'id') is distinct from 'string' or p_after->>'id' is null then raise exception 'Invalid cursor scope' using errcode='22023'; end if;
     anchor_id:=(p_after->>'id')::uuid;
     anchor_at:=(p_after->>'lastMessageAt')::timestamptz;
     if anchor_at is not null and not isfinite(anchor_at) then raise exception 'Invalid cursor timestamp' using errcode='22023'; end if;
   end if;
 end if;
 select * into limits from app.telegram_history_limits;
 select count(*) filter(where not ch.excluded),count(*) filter(where ch.selected and not ch.excluded),count(*) filter(where not ch.excluded and not ch.selected and j.id is null and ch.removal_state='none'),count(*) filter(where not ch.excluded and (ch.selected or j.id is not null or ch.removal_state<>'none')),count(*) filter(where ch.excluded) into total,selected_total,available_total,connected_total,excluded_total from app.telegram_history_chats ch left join app.telegram_history_jobs j on j.chat_id=ch.id where ch.account_id=a.id;
 with records as (
 select ch.id,ch.last_message_at,jsonb_build_object('lastMessageAt',ch.last_message_at,'id',ch.id,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'title',ch.title,'username',ch.username,'excluded',ch.excluded,'selected',ch.selected,'historyCompleted',ch.history_completed,'progress',jsonb_build_object('lastProgressAt',j.last_progress_at,'oldestImportedAt',ch.oldest_imported_at,'newestImportedAt',ch.newest_imported_at),'extractionEnabled',ch.extraction_enabled,'extractionPending',ch.extraction_pending,'version',ch.version,'sync',jsonb_build_object('enabled',ch.selected and ch.history_completed and j.status not in ('paused','cancelled'),'status',case when not ch.selected or j.status='cancelled' then 'off' when not ch.history_completed then 'waiting_for_history' when c.status<>'connected' then 'reconnect_required' when c.lease_expires_at is null or c.lease_expires_at<=clock_timestamp() then 'worker_offline' when j.status='completed' then 'up_to_date' when j.status='leased' then 'syncing' else j.status end,'lastSyncedAt',ch.last_sync_at,'nextSyncAt',ch.next_sync_at,'checkpoint',ch.sync_checkpoint::text),'import',case when j.id is null then null else jsonb_build_object('jobId',j.id,'status',case when j.connection_generation<>c.generation and j.status<>'completed' then 'paused' else j.status end,'importedMessages',j.imported_messages,'importedBytes',j.imported_bytes,'errorCode',case when j.connection_generation<>c.generation and j.status<>'completed' then 'CONNECTION_CHANGED' else j.error_code end,'retryAt',j.retry_at) end) value
 from app.telegram_history_chats ch left join app.telegram_history_jobs j on j.chat_id=ch.id where ch.account_id=a.id and (case when p_view='excluded' then ch.excluded else not ch.excluded end) and (anchor_id is null or (anchor_at is null and ch.last_message_at is null and ch.id>anchor_id) or (anchor_at is not null and (ch.last_message_at<anchor_at or ch.last_message_at is null or (ch.last_message_at=anchor_at and ch.id>anchor_id)))) and (p_q='' or ch.title ilike '%'||p_q||'%' or ch.username ilike '%'||p_q||'%') and (p_view in ('all','excluded') or (p_view='available' and not ch.selected and j.id is null and ch.removal_state='none') or (p_view='connected' and (ch.selected or j.id is not null or ch.removal_state<>'none')) or (p_view='selected' and ch.selected) or (p_view='active' and j.status in ('queued','leased','waiting') and j.connection_generation=c.generation) or (p_view='paused' and (j.status in ('paused','capacity_paused','failed') or (j.connection_generation<>c.generation and j.status<>'completed')))) order by ch.last_message_at desc nulls last,ch.id limit 51
 ), numbered as(select *,row_number() over(order by last_message_at desc nulls last,id) n from records)
 select coalesce(jsonb_agg(value order by n) filter(where n<=50),'[]'::jsonb),case when count(*)>50 then (jsonb_agg(jsonb_build_object('v',1,'accountId',a.id,'view',p_view,'q',p_q,'lastMessageAt',last_message_at,'id',id) order by n)->49) end into chats,next_cursor from numbered;
 select jsonb_build_object('status',case when count(*)=0 then 'idle' when bool_and(status='completed') then 'completed' when bool_or(status in ('queued','leased','waiting') and connection_generation=c.generation) then 'active' else 'paused' end,'jobs',coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'errorCode',error_code,'retryAt',retry_at) order by folder),'[]'::jsonb)) into discovery from app.telegram_history_jobs where account_id=a.id and kind='dialogs';
 result:=jsonb_build_object('connection',case when c.id is null then null else jsonb_build_object('id',c.id,'generation',c.generation,'status',c.status,'accountUserId',c.profile->>'telegramUserId') end,'account',case when a.id is null then null else jsonb_build_object('id',a.id,'accountUserId',a.account_user_id) end,'canImport',coalesce(c.status='connected',false),'blockedReason',case when c.status is distinct from 'connected' then 'NOT_CONNECTED' end,'discovery',discovery,'totals',jsonb_build_object('chats',total,'selected',selected_total,'available',available_total,'connected',connected_total,'excluded',excluded_total,'messages',coalesce(limits.stored_messages,0),'bytes',coalesce(limits.stored_bytes,0),'maxMessages',coalesce(limits.max_messages,200000),'maxBytes',coalesce(limits.max_bytes,268435456)),'chats',chats,'nextCursor',next_cursor);
 select coalesce(jsonb_agg(ch.value||jsonb_build_object('removalState',rc.removal_state,'removal',case when r.id is null then null else app.telegram_chat_removal_json_v1(r) end) order by ch.ordinality),'[]') into rows from jsonb_array_elements(result->'chats') with ordinality ch(value,ordinality) join app.telegram_history_chats rc on rc.id=(ch.value->>'id')::uuid left join lateral(select r0.* from app.telegram_chat_removals r0 where r0.chat_id=rc.id and r0.organization_id=rc.organization_id and r0.owner_user_id=rc.owner_user_id order by r0.requested_at desc,r0.id desc limit 1) r on true;
 return jsonb_set(result,'{chats}',rows);
end $$;
create or replace function app.telegram_history_status_before_removal_v1(p_view text,p_q text,p_after uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare c app.telegram_connections; a app.telegram_history_accounts; limits app.telegram_history_limits; chats jsonb; total bigint; selected_total bigint; discovery jsonb; next_cursor uuid; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_view not in ('all','selected','active','paused') or char_length(p_q)>100 then raise exception 'Invalid history filter' using errcode='22023'; end if;
 select * into c from app.telegram_connections;
 select * into a from app.telegram_history_accounts where connection_id=c.id and (c.status<>'connected' or account_user_id=c.profile->>'telegramUserId') order by updated_at desc limit 1;
 select * into limits from app.telegram_history_limits;
 select count(*),count(*) filter(where selected) into total,selected_total from app.telegram_history_chats where account_id=a.id and not excluded;
 with records as (
 select ch.id,jsonb_build_object('id',ch.id,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'title',ch.title,'username',ch.username,'selected',ch.selected,'historyCompleted',ch.history_completed,'progress',jsonb_build_object('lastProgressAt',j.last_progress_at,'oldestImportedAt',ch.oldest_imported_at,'newestImportedAt',ch.newest_imported_at),'extractionEnabled',ch.extraction_enabled,'extractionPending',ch.extraction_pending,'version',ch.version,'sync',jsonb_build_object('enabled',ch.selected and ch.history_completed and j.status not in ('paused','cancelled'),'status',case when not ch.selected or j.status='cancelled' then 'off' when not ch.history_completed then 'waiting_for_history' when c.status<>'connected' then 'reconnect_required' when c.lease_expires_at is null or c.lease_expires_at<=clock_timestamp() then 'worker_offline' when j.status='completed' then 'up_to_date' when j.status='leased' then 'syncing' else j.status end,'lastSyncedAt',ch.last_sync_at,'nextSyncAt',ch.next_sync_at,'checkpoint',ch.sync_checkpoint::text),'import',case when j.id is null then null else jsonb_build_object('jobId',j.id,'status',case when j.connection_generation<>c.generation and j.status<>'completed' then 'paused' else j.status end,'importedMessages',j.imported_messages,'importedBytes',j.imported_bytes,'errorCode',case when j.connection_generation<>c.generation and j.status<>'completed' then 'CONNECTION_CHANGED' else j.error_code end,'retryAt',j.retry_at) end) value
 from app.telegram_history_chats ch left join app.telegram_history_jobs j on j.chat_id=ch.id where ch.account_id=a.id and not ch.excluded and (p_after is null or ch.id>p_after) and (p_q='' or ch.title ilike '%'||p_q||'%' or ch.username ilike '%'||p_q||'%') and (p_view='all' or (p_view='selected' and ch.selected) or (p_view='active' and j.status in ('queued','leased','waiting') and j.connection_generation=c.generation) or (p_view='paused' and (j.status in ('paused','capacity_paused','failed') or (j.connection_generation<>c.generation and j.status<>'completed')))) order by ch.id limit 51
 ), numbered as(select *,row_number() over(order by id) n from records)
 select coalesce(jsonb_agg(value order by id) filter(where n<=50),'[]'::jsonb),case when count(*)>50 then (array_agg(id order by id))[50] end into chats,next_cursor from numbered;
 select jsonb_build_object('status',case when count(*)=0 then 'idle' when bool_and(status='completed') then 'completed' when bool_or(status in ('queued','leased','waiting') and connection_generation=c.generation) then 'active' else 'paused' end,'jobs',coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'errorCode',error_code,'retryAt',retry_at) order by folder),'[]'::jsonb)) into discovery from app.telegram_history_jobs where account_id=a.id and kind='dialogs';
 return jsonb_build_object('connection',case when c.id is null then null else jsonb_build_object('id',c.id,'generation',c.generation,'status',c.status,'accountUserId',c.profile->>'telegramUserId') end,'account',case when a.id is null then null else jsonb_build_object('id',a.id,'accountUserId',a.account_user_id) end,'canImport',coalesce(c.status='connected',false),'blockedReason',case when c.status is distinct from 'connected' then 'NOT_CONNECTED' end,'discovery',discovery,'totals',jsonb_build_object('chats',total,'selected',selected_total,'messages',coalesce(limits.stored_messages,0),'bytes',coalesce(limits.stored_bytes,0),'maxMessages',coalesce(limits.max_messages,200000),'maxBytes',coalesce(limits.max_bytes,268435456)),'chats',chats,'nextCursor',next_cursor);
end $$;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
