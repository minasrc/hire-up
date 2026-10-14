begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
grant create on schema app to app_executor;
reset role;
set local role app_executor;

-- Paused backlogs remain recoverable, but are not active work. Count across the
-- complete private queue, independently of pagination and the selected view.
alter function app.telegram_extraction_status_v1(uuid,text,uuid) rename to telegram_extraction_status_before_activity_v1;
revoke all on function app.telegram_extraction_status_before_activity_v1(uuid,text,uuid) from app_staff;
create function app.telegram_extraction_status_v1(p_draft uuid default null,p_view text default 'all',p_after uuid default null)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r jsonb; active_count bigint; paused_count bigint; jobs jsonb;
begin
 r:=app.telegram_extraction_status_before_activity_v1(p_draft,p_view,p_after);
 if r ? 'counts' then
 select count(*) filter(where c.extraction_enabled or (j.status='leased' and j.lease_expires_at>clock_timestamp())),
 count(*) filter(where not c.extraction_enabled and not coalesce(j.status='leased' and j.lease_expires_at>clock_timestamp(),false))
 into active_count,paused_count from app.telegram_extraction_jobs j join app.telegram_history_chats c on c.id=j.chat_id
 where j.status in('queued','waiting','leased');
 r:=jsonb_set(r,'{counts}',(r->'counts')||jsonb_build_object('active',active_count,'paused',paused_count));
 end if;
 if r ? 'jobs' then
 select coalesce(jsonb_agg(e.value||jsonb_build_object('processingPaused',not c.extraction_enabled and
 j.status in('queued','waiting','leased') and not coalesce(j.status='leased' and j.lease_expires_at>clock_timestamp(),false)) order by e.ordinality),'[]')
 into jobs from jsonb_array_elements(r->'jobs') with ordinality e join app.telegram_extraction_jobs j on j.id=(e.value->>'id')::uuid
 join app.telegram_history_chats c on c.id=j.chat_id;
 r:=jsonb_set(r,'{jobs}',jobs);
 end if;
 return r;
end $$;
revoke all on function app.telegram_extraction_status_v1(uuid,text,uuid) from public;
grant execute on function app.telegram_extraction_status_v1(uuid,text,uuid) to app_staff;

-- The chat's Pause control stops future imports and extraction together.
-- Complete in-flight model requests can still safely publish their reviewed draft.
create function app.telegram_candidate_pause_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r jsonb; v bigint; chat uuid:=(p_input->>'chatId')::uuid;
begin
 if p_input->>'action' is distinct from 'pause' then raise exception 'Invalid action' using errcode='22023'; end if;
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform app.telegram_extraction_lock_v1();
 r:=app.telegram_history_action_v1(p_input);
 select version into strict v from app.telegram_history_chats where id=chat;
 perform app.telegram_extraction_action_v1(jsonb_build_object('action','setExtraction','enabled',false,
 'chats',jsonb_build_array(jsonb_build_object('chatId',chat,'expectedVersion',v))));
 return r;
end $$;
revoke all on function app.telegram_candidate_pause_v1(jsonb) from public;
grant execute on function app.telegram_candidate_pause_v1(jsonb) to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
