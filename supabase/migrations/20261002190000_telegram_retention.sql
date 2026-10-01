begin;
set local lock_timeout='2s'; set local statement_timeout='30s';
create role app_telegram_maintenance nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
set local role app_owner;
grant usage on schema app to app_telegram_maintenance;
alter table app.telegram_history_chats add column extraction_enabled boolean not null default false, add column extraction_pending boolean not null default false, add column extraction_served_at timestamptz not null default 'epoch';
update app.telegram_history_chats c set extraction_enabled=true,extraction_pending=true where exists(select 1 from app.telegram_extraction_jobs j where j.chat_id=c.id);
create index telegram_extraction_catchup_idx on app.telegram_history_chats(organization_id,owner_user_id,extraction_served_at,id) where extraction_enabled and extraction_pending;
alter table app.telegram_extraction_jobs add column source_version bigint not null default 1,add column source_release_requested_at timestamptz,add column source_purged_at timestamptz,add column cleanup_due_at timestamptz;
alter table app.telegram_extraction_jobs alter column source drop not null;
alter table app.telegram_extraction_jobs drop constraint telegram_extraction_jobs_source_check;
alter table app.telegram_extraction_jobs add constraint telegram_extraction_jobs_source_check check((source is null and source_purged_at is not null and status='completed') or (source is not null and jsonb_typeof(source)='object' and (octet_length(source::text)<=49152 or (message_count=1 and octet_length(source::text)<=327680))));
create index telegram_retention_receipt_idx on app.telegram_extraction_jobs using gin(receipt jsonb_path_ops);
create index telegram_retention_due_idx on app.telegram_extraction_jobs(organization_id,owner_user_id,cleanup_due_at,id) where source_release_requested_at is not null and source_purged_at is null;
do $$ declare c record; begin for c in select conname from pg_constraint where conrelid='app.telegram_extraction_sources'::regclass and confrelid='app.telegram_history_messages'::regclass loop execute format('alter table app.telegram_extraction_sources drop constraint %I',c.conname); end loop; end $$;
-- This existing private source ledger now survives raw-body deletion and prevents
-- an explicit history restart/new page ID from restoring reviewed source text.
alter table app.telegram_evidence add column extraction_job_id uuid references app.telegram_extraction_jobs(id);
update app.telegram_evidence set extraction_job_id=substring(source_key from '^extraction:([0-9a-f-]{36}):')::uuid where source_key ~ '^extraction:[0-9a-f-]{36}:';
create index telegram_retention_evidence_idx on app.telegram_evidence(extraction_job_id,id);
create index telegram_retention_evidence_links_idx on app.telegram_draft_evidence(evidence_id,draft_id);
create index telegram_retention_cv_idx on app.telegram_cv_jobs(extraction_job_id,status,draft_id);
create table app.telegram_maintenance_owners(organization_id uuid not null,owner_user_id uuid not null,due_at timestamptz not null,primary key(organization_id,owner_user_id));
alter table app.telegram_maintenance_owners enable row level security; alter table app.telegram_maintenance_owners force row level security;
grant select,insert,update,delete on app.telegram_maintenance_owners to app_executor;
-- Internal queue contains only scope identifiers; no runtime role can SELECT it.
create policy telegram_maintenance_internal on app.telegram_maintenance_owners for all to app_executor using(true) with check(true);
grant trigger on app.telegram_history_messages,app.telegram_evidence,app.telegram_drafts,app.telegram_extraction_proposals,app.telegram_cv_jobs,app.profile_search_queries to app_executor;
grant update(extraction_enabled,extraction_pending,extraction_served_at) on app.telegram_history_chats to app_executor;
grant create on schema app to app_executor;
reset role; set local role app_executor;
create function app.telegram_maintenance_schedule_v1(p_due timestamptz) returns void language sql volatile set search_path=pg_catalog,app,pg_temp as $$
 insert into app.telegram_maintenance_owners values(app.context_uuid_v1('app.organization_id'),app.context_uuid_v1('app.actor_id'),p_due) on conflict(organization_id,owner_user_id) do update set due_at=least(app.telegram_maintenance_owners.due_at,excluded.due_at)
$$;
create function app.telegram_retention_drafts_v1(p_job uuid) returns table(id uuid) language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select (value#>>'{}')::uuid from app.telegram_extraction_jobs j cross join lateral jsonb_array_elements(coalesce(j.receipt->'draftIds','[]')) where j.id=p_job
 union select draft_id from app.telegram_extraction_proposals where job_id=p_job
 union select draft_id from app.telegram_extraction_attachments where job_id=p_job
 union select x.draft_id from app.telegram_draft_evidence x join app.telegram_evidence e on e.id=x.evidence_id where e.extraction_job_id=p_job
 union select draft_id from app.telegram_cv_jobs where extraction_job_id=p_job
$$;
create function app.telegram_retention_needs_review_v1(j app.telegram_extraction_jobs) returns boolean language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select j.status='completed' and j.source_purged_at is null and (j.source_release_requested_at is null
 or exists(select 1 from app.telegram_drafts d join app.telegram_retention_drafts_v1(j.id) r on r.id=d.id where d.status not in('approved','discarded'))
 or exists(select 1 from app.telegram_extraction_proposals where job_id=j.id and status='pending')
 or exists(select 1 from app.telegram_cv_jobs where extraction_job_id=j.id and status in('queued','leased','waiting')))
$$;
create function app.telegram_retention_json_v1(j app.telegram_extraction_jobs) returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('version',j.source_version,'state',case when j.source_purged_at is not null then 'purged' when j.source_release_requested_at is not null then 'release_pending' else 'kept' end,'requestedAt',j.source_release_requested_at,'purgedAt',j.source_purged_at,
 'holds',jsonb_build_object('openDrafts',(select count(*) from app.telegram_drafts d join app.telegram_retention_drafts_v1(j.id) r on r.id=d.id where d.status not in('approved','discarded')),'pendingProposals',(select count(*) from app.telegram_extraction_proposals where job_id=j.id and status='pending'),'activeCv',(select count(*) from app.telegram_cv_jobs where extraction_job_id=j.id and status in('queued','leased','waiting'))),
 'canRelease',j.status='completed' and j.source_purged_at is null and j.source_release_requested_at is null,'canKeep',j.source_purged_at is null and j.source_release_requested_at is not null)
$$;
create function app.telegram_retention_evidence_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 if new.source_key ~ '^extraction:[0-9a-f-]{36}:' then new.extraction_job_id:=substring(new.source_key from '^extraction:([0-9a-f-]{36}):')::uuid; end if; return new;
end $$;
create trigger telegram_retention_evidence before insert on app.telegram_evidence for each row execute function app.telegram_retention_evidence_v1();
create function app.telegram_retention_event_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare old_org text:=current_setting('app.organization_id',true); old_actor text:=current_setting('app.actor_id',true); n jsonb:=coalesce(to_jsonb(new),to_jsonb(old));
begin
 perform set_config('app.organization_id',n->>'organization_id',true); perform set_config('app.actor_id',n->>'owner_user_id',true);
 if tg_table_name='profile_search_queries' then perform app.telegram_maintenance_schedule_v1((n->>'expires_at')::timestamptz);
 else
 -- Scheduling is cheap; cleanup independently rechecks every live hold.
 update app.telegram_extraction_jobs set cleanup_due_at=now() where source_release_requested_at is not null and source_purged_at is null and id in(
 select id from app.telegram_extraction_jobs where tg_table_name='telegram_drafts' and receipt @> jsonb_build_object('draftIds',jsonb_build_array(n->>'id'))
 union select job_id from app.telegram_extraction_proposals where tg_table_name='telegram_drafts' and draft_id=(n->>'id')::uuid
 union select job_id from app.telegram_extraction_attachments where tg_table_name='telegram_drafts' and draft_id=(n->>'id')::uuid
 union select e.extraction_job_id from app.telegram_evidence e join app.telegram_draft_evidence x on x.evidence_id=e.id where tg_table_name='telegram_drafts' and x.draft_id=(n->>'id')::uuid
 union select extraction_job_id from app.telegram_cv_jobs where tg_table_name='telegram_drafts' and draft_id=(n->>'id')::uuid
 union select (n->>'job_id')::uuid where tg_table_name='telegram_extraction_proposals'
 union select (n->>'extraction_job_id')::uuid where tg_table_name='telegram_cv_jobs');
 perform app.telegram_maintenance_schedule_v1(now());
 end if;
 perform set_config('app.organization_id',coalesce(old_org,''),true); perform set_config('app.actor_id',coalesce(old_actor,''),true); return coalesce(new,old);
end $$;
create trigger telegram_retention_draft_event after update of status on app.telegram_drafts for each row execute function app.telegram_retention_event_v1();
create trigger telegram_retention_proposal_event after update of status on app.telegram_extraction_proposals for each row execute function app.telegram_retention_event_v1();
create trigger telegram_retention_cv_event after update of status on app.telegram_cv_jobs for each row execute function app.telegram_retention_event_v1();
create trigger telegram_retention_query_event after insert on app.profile_search_queries for each row execute function app.telegram_retention_event_v1();
create function app.telegram_extraction_import_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ declare scope record; old_org text:=current_setting('app.organization_id',true); old_actor text:=current_setting('app.actor_id',true); begin
 for scope in select distinct organization_id,owner_user_id from imported loop
 perform set_config('app.organization_id',scope.organization_id::text,true); perform set_config('app.actor_id',scope.owner_user_id::text,true);
 update app.telegram_history_chats set extraction_pending=true where extraction_enabled and id in(select distinct chat_id from imported where organization_id=scope.organization_id and owner_user_id=scope.owner_user_id);
 end loop;
 perform set_config('app.organization_id',coalesce(old_org,''),true); perform set_config('app.actor_id',coalesce(old_actor,''),true); return null;
end $$;
create trigger telegram_extraction_import after insert on app.telegram_history_messages referencing new table as imported for each statement execute function app.telegram_extraction_import_v1();

create or replace function app.telegram_extraction_enqueue_v1(p_chat uuid) returns boolean language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare ch app.telegram_history_chats; a app.telegram_history_accounts; m record; src jsonb; trial jsonb; jid uuid; n integer:=0;
begin
 select * into ch from app.telegram_history_chats where id=p_chat for share;
 if not found then raise exception 'Chat unavailable' using errcode='P0002'; end if;
 if not ch.extraction_enabled then return false; end if;
 if exists(select 1 from app.telegram_extraction_jobs where chat_id=p_chat and status<>'completed') then update app.telegram_history_chats set extraction_pending=false,extraction_served_at=now() where id=p_chat; return false; end if;
 select * into strict a from app.telegram_history_accounts where id=ch.account_id;
 src:=jsonb_build_object('chat',jsonb_build_object('id',ch.id,'title',ch.title,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'accountUserId',a.account_user_id),'messages','[]'::jsonb);
 for m in select h.body from app.telegram_history_messages h where h.chat_id=p_chat and h.extraction_job_id is null order by h.message_id desc limit 40 loop
 trial:=jsonb_set(src,'{messages}',(src->'messages')||jsonb_build_array(m.body));
 if octet_length(trial::text)>49152 then
  if n=0 and octet_length(trial::text)<=327680 then src:=trial; n:=1; exit; end if;
  if n=0 then raise exception 'Legal history message exceeds singleton envelope' using errcode='22023'; end if;
  exit;
 end if;
 src:=trial; n:=n+1;
 end loop;
 if n=0 then update app.telegram_history_chats set extraction_pending=false,extraction_served_at=now() where id=p_chat; return false; end if;
 insert into app.telegram_extraction_jobs(organization_id,owner_user_id,chat_id,source,source_digest,message_count)
 values(ch.organization_id,ch.owner_user_id,p_chat,src,sha256(convert_to(src::text,'UTF8')),n) returning id into jid;
 insert into app.telegram_extraction_sources(organization_id,owner_user_id,chat_id,message_id,job_id)
 select ch.organization_id,ch.owner_user_id,p_chat,(value->>'messageId')::bigint,jid from jsonb_array_elements(src->'messages');
 update app.telegram_history_messages set extraction_job_id=jid where chat_id=p_chat and message_id in(select (value->>'messageId')::bigint from jsonb_array_elements(src->'messages'));
 update app.telegram_history_chats set extraction_pending=false,extraction_served_at=now() where id=p_chat;
 return true;
end $$;

create or replace function app.telegram_extraction_claim_v1(p_token text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare w uuid; j app.telegram_extraction_jobs; ch record; begin
 w:=app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 for ch in select id from app.telegram_history_chats where extraction_enabled and extraction_pending order by extraction_served_at,id limit 10 for update skip locked loop perform app.telegram_extraction_enqueue_v1(ch.id); end loop;
 update app.telegram_extraction_jobs set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_expires_at=null where status='leased' and lease_expires_at<=clock_timestamp() and attempts>=5;
 select * into j from app.telegram_extraction_jobs where ((status in ('queued','waiting') and available_at<=clock_timestamp()) or (status='leased' and lease_expires_at<=clock_timestamp())) and attempts<5 and exists(select 1 from app.telegram_history_chats c where c.id=chat_id and c.extraction_enabled) order by available_at,created_at,id limit 1 for update;
 if not found then return jsonb_build_object('job',null); end if;
 update app.telegram_extraction_jobs set status='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_worker_id=w,lease_expires_at=clock_timestamp()+interval '180 seconds',error_code=null where id=j.id returning * into j;
 return jsonb_build_object('job',jsonb_build_object('id',j.id,'leaseToken',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'sourceDigest',encode(j.source_digest,'hex'),'schemaVersion',j.schema_version,'promptVersion','candidate-extraction-prompt-v1','source',j.source,'sourceLimitBytes',case when octet_length(j.source::text)>49152 then 327680 else 49152 end));
end $$;

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
 result:=jsonb_build_object('ok',true,'status',case when done then 'completed' else 'queued' end,'replayed',false);
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
 select ch.id,jsonb_build_object('id',ch.id,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'title',ch.title,'username',ch.username,'selected',ch.selected,'extractionEnabled',ch.extraction_enabled,'extractionPending',ch.extraction_pending,'version',ch.version,'import',case when j.id is null then null else jsonb_build_object('jobId',j.id,'status',case when j.connection_generation<>c.generation and j.status<>'completed' then 'paused' else j.status end,'importedMessages',j.imported_messages,'importedBytes',j.imported_bytes,'errorCode',case when j.connection_generation<>c.generation and j.status<>'completed' then 'CONNECTION_CHANGED' else j.error_code end,'retryAt',j.retry_at) end) value
 from app.telegram_history_chats ch left join app.telegram_history_jobs j on j.chat_id=ch.id where ch.account_id=a.id and (p_after is null or ch.id>p_after) and (p_q='' or ch.title ilike '%'||p_q||'%' or ch.username ilike '%'||p_q||'%') and (p_view='all' or (p_view='selected' and ch.selected) or (p_view='active' and j.status in ('queued','leased','waiting') and j.connection_generation=c.generation) or (p_view='paused' and (j.status in ('paused','capacity_paused','failed') or (j.connection_generation<>c.generation and j.status<>'completed')))) order by ch.id limit 51
 ), numbered as(select *,row_number() over(order by id) n from records)
 select coalesce(jsonb_agg(value order by id) filter(where n<=50),'[]'::jsonb),case when count(*)>50 then (array_agg(id order by id))[50] end into chats,next_cursor from numbered;
 select jsonb_build_object('status',case when count(*)=0 then 'idle' when bool_and(status='completed') then 'completed' when bool_or(status in ('queued','leased','waiting') and connection_generation=c.generation) then 'active' else 'paused' end,'jobs',coalesce(jsonb_agg(jsonb_build_object('id',id,'status',status,'errorCode',error_code,'retryAt',retry_at) order by folder),'[]'::jsonb)) into discovery from app.telegram_history_jobs where account_id=a.id and kind='dialogs';
 return jsonb_build_object('connection',case when c.id is null then null else jsonb_build_object('id',c.id,'generation',c.generation,'status',c.status,'accountUserId',c.profile->>'telegramUserId') end,'account',case when a.id is null then null else jsonb_build_object('id',a.id,'accountUserId',a.account_user_id) end,'canImport',coalesce(c.status='connected',false),'blockedReason',case when c.status is distinct from 'connected' then 'NOT_CONNECTED' end,'discovery',discovery,'totals',jsonb_build_object('chats',total,'selected',selected_total,'messages',coalesce(limits.stored_messages,0),'bytes',coalesce(limits.stored_bytes,0),'maxMessages',coalesce(limits.max_messages,200000),'maxBytes',coalesce(limits.max_bytes,268435456)),'chats',chats,'nextCursor',next_cursor);
end $$;

create or replace function app.telegram_extraction_complete_v1(p_token text,p_job uuid,p_lease uuid,p_source_digest text,p_result jsonb,p_metadata jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; j app.telegram_extraction_jobs; s jsonb; f jsonb; facts jsonb; e jsonb; m jsonb; a jsonb; subj app.telegram_extraction_subjects; d app.telegram_drafts;
 ident text; digest bytea; eid uuid; did uuid; ids uuid[]:='{}'; n integer:=0; next_queued boolean; current_fields jsonb; k text; val jsonb; state text; changed boolean; seen text[]:='{}';
begin
 w:=app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 select * into j from app.telegram_extraction_jobs where id=p_job for update;
 if not found then raise exception 'Job unavailable' using errcode='P0002'; end if;
 if not coalesce(app.telegram_history_keys_v1(p_metadata,array['model','promptVersion','reportedModel']) and p_metadata->>'promptVersion'='candidate-extraction-prompt-v1' and p_metadata->>'model' ~ '^[A-Za-z0-9._:/-]{1,120}$' and strpos(p_metadata->>'model','://')=0 and (p_metadata->'reportedModel'='null'::jsonb or (p_metadata->>'reportedModel' ~ '^[A-Za-z0-9._:/-]{1,120}$' and strpos(p_metadata->>'reportedModel','://')=0)),false) or octet_length(p_result::text)>150000 then raise exception 'Invalid extraction result' using errcode='22023'; end if;
 digest:=sha256(convert_to(jsonb_build_object('result',p_result,'metadata',p_metadata)::text,'UTF8'));
 if encode(j.source_digest,'hex') is distinct from p_source_digest then raise exception 'Source changed' using errcode='40001'; end if;
 if j.status='completed' then
  if j.result_digest=digest then return j.receipt; end if;
  raise exception 'Result changed' using errcode='40001';
 end if;
 if j.source is null or not app.telegram_extraction_validate_v1(p_result,j.source) then raise exception 'Invalid extraction result' using errcode='22023'; end if;
 if j.status<>'leased' or j.lease_token is distinct from p_lease or j.lease_worker_id is distinct from w or j.lease_expires_at<=clock_timestamp() then raise exception 'Lease changed' using errcode='40001'; end if;
 for s in select value from jsonb_array_elements(p_result->'subjects') loop
  facts:=s->'facts';
  if s#>>'{identity,kind}'='email' then ident:='email:'||(s#>>'{identity,email}');
  elsif s#>>'{identity,kind}'='telegram_sender' then
   select value into strict m from jsonb_array_elements(j.source->'messages') where value->>'messageId'=s#>>'{identity,messageId}';
   ident:='telegram:user:'||(m#>>'{sender,peer,id}');
   facts:=facts||jsonb_build_array(jsonb_build_object('field','telegramUserId','value',m#>>'{sender,peer,id}','evidence',jsonb_build_array(jsonb_build_object('messageId',m->>'messageId','quote',s#>>'{identity,quote}'))));
   if m#>>'{sender,username}' ~ '^[A-Za-z0-9_]{1,32}$' then facts:=facts||jsonb_build_array(jsonb_build_object('field','telegramUsername','value',m#>>'{sender,username}','evidence',jsonb_build_array(jsonb_build_object('messageId',m->>'messageId','quote',s#>>'{identity,quote}')))); end if;
  else ident:='batch:'||j.id||':'||(s->>'key'); end if;
  if ident=any(seen) then raise exception 'Repeated subject identity' using errcode='22023'; end if; seen:=array_append(seen,ident);
  select * into subj from app.telegram_extraction_subjects where identity_key=ident;
  if not found then
   did:=gen_random_uuid();
   insert into app.telegram_drafts(id,organization_id,owner_user_id,fields,source_title) values(did,j.organization_id,j.owner_user_id,'{}',j.source#>>'{chat,title}');
   insert into app.telegram_extraction_subjects(organization_id,owner_user_id,identity_key,draft_id) values(j.organization_id,j.owner_user_id,ident,did) returning * into subj;
  end if;
  select * into strict d from app.telegram_drafts where id=subj.draft_id for update;
  if not d.id=any(ids) then ids:=array_append(ids,d.id); end if;
  -- An explicitly discarded subject remains discarded, including late history.
  if d.status='discarded' then continue; end if;
  current_fields:=case when d.status='approved' then coalesce(subj.reviewed_fields,'{}') else d.fields end; changed:=false;
  for f in select value from jsonb_array_elements(facts) loop
   k:=f->>'field'; val:=f->'value'; state:='applied';
   if (current_fields->k) is distinct from val then
    if d.status<>'approved' and not(k=any(d.human_fields)) and (current_fields->k is null or current_fields->k in ('null'::jsonb,'""'::jsonb,'[]'::jsonb))
     and not(k='primaryEmail' and coalesce(current_fields->'secondaryEmails','[]') @> jsonb_build_array(val))
     and not(k='secondaryEmails' and val @> jsonb_build_array(current_fields->'primaryEmail')) then
      current_fields:=jsonb_set(current_fields,array[k],val,true); changed:=true;
    else state:='pending'; n:=n+1; end if;
   end if;
   insert into app.telegram_extraction_proposals(organization_id,owner_user_id,job_id,draft_id,field,suggested_value,evidence,status) values(j.organization_id,j.owner_user_id,j.id,d.id,k,val,f->'evidence',state);
   -- Unchanged reviewed facts need no new raw evidence on a closed draft.
   if d.status='approved' and state='applied' then continue; end if;
   for e in select value from jsonb_array_elements(f->'evidence') loop
    select value into strict m from jsonb_array_elements(j.source->'messages') where value->>'messageId'=e->>'messageId';
    insert into app.telegram_evidence(organization_id,owner_user_id,source_key,text,sender_name,sent_at)
    values(j.organization_id,j.owner_user_id,'extraction:'||j.id||':'||(e->>'messageId')||':'||encode(sha256(convert_to(e->>'quote','UTF8')),'hex'),e->>'quote',m#>>'{sender,displayName}',(m->>'sentAt')::timestamptz)
    on conflict(organization_id,owner_user_id,source_key) do update set source_key=excluded.source_key returning id into eid;
    insert into app.telegram_draft_evidence(organization_id,owner_user_id,draft_id,evidence_id) values(j.organization_id,j.owner_user_id,d.id,eid) on conflict do nothing;
   end loop;
  end loop;
  if changed then
   update app.telegram_drafts set fields=current_fields,version=version+1,updated_at=clock_timestamp() where id=d.id;
   delete from app.telegram_draft_embeddings where draft_id=d.id;
  end if;
  for a in select value from jsonb_array_elements(s->'attachments') loop
   select value into strict m from jsonb_array_elements(j.source->'messages') where value->>'messageId'=a->>'messageId';
   insert into app.telegram_extraction_attachments(organization_id,owner_user_id,job_id,draft_id,message_id,attachment_index,metadata)
   values(j.organization_id,j.owner_user_id,j.id,d.id,a->>'messageId',(a->>'attachmentIndex')::integer,m->'attachments'->((a->>'attachmentIndex')::integer)) on conflict do nothing;
  end loop;
 end loop;
 update app.telegram_extraction_jobs set status='completed',result_digest=digest,metadata=p_metadata,completed_at=clock_timestamp(),lease_expires_at=null where id=j.id;
 next_queued:=app.telegram_extraction_enqueue_v1(j.chat_id);
 update app.telegram_extraction_jobs set receipt=jsonb_build_object('ok',true,'draftIds',to_jsonb(ids),'proposalCount',n,'nextQueued',next_queued) where id=j.id returning * into j;
 return j.receipt;
end $$;

create function app.telegram_extraction_receipt_v1(p_token text,p_job uuid,p_digest text,p_result jsonb,p_metadata jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare j app.telegram_extraction_jobs; d bytea; begin
 perform app.telegram_worker_context_v1(p_token); select * into j from app.telegram_extraction_jobs where id=p_job;
 if not found then raise exception 'Job unavailable' using errcode='P0002'; end if;
 if j.status<>'completed' then return null; end if;
 d:=sha256(convert_to(jsonb_build_object('result',p_result,'metadata',p_metadata)::text,'UTF8'));
 if encode(j.source_digest,'hex') is distinct from p_digest or j.result_digest is distinct from d then raise exception 'Result changed' using errcode='40001'; end if; return j.receipt;
end $$;
alter function app.telegram_extraction_action_v1(jsonb) rename to telegram_extraction_action_before_retention_v1;
revoke all on function app.telegram_extraction_action_before_retention_v1(jsonb) from app_staff;
create function app.telegram_extraction_action_v1(p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a text:=p_input->>'action'; j app.telegram_extraction_jobs; ch app.telegram_history_chats; item jsonb; items jsonb; enabled boolean; n integer:=0; queued integer:=0; mode text;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if a in('enqueue','setExtraction') then
 perform app.telegram_extraction_lock_v1();
 if a='enqueue' then
 if jsonb_typeof(p_input->'chatIds') is distinct from 'array' or jsonb_array_length(p_input->'chatIds') not between 1 and 50 then raise exception 'Invalid selection' using errcode='22023'; end if;
 select jsonb_agg(jsonb_build_object('chatId',value#>>'{}')) into items from jsonb_array_elements(p_input->'chatIds'); enabled:=true;
 else items:=p_input->'chats'; enabled:=(p_input->>'enabled')::boolean;
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 50 or jsonb_typeof(p_input->'enabled') is distinct from 'boolean' then raise exception 'Invalid extraction setting' using errcode='22023'; end if;
 end if;
 if (select count(distinct value->>'chatId') from jsonb_array_elements(items))<>jsonb_array_length(items) then raise exception 'Repeated chat' using errcode='22023'; end if;
 for item in select value from jsonb_array_elements(items) order by value->>'chatId' loop
 select * into ch from app.telegram_history_chats where id=(item->>'chatId')::uuid for update;
 if not found then raise exception 'Chat unavailable' using errcode='P0002'; end if;
 if a='setExtraction' and ch.version is distinct from (item->>'expectedVersion')::bigint then raise exception 'Chat changed' using errcode='40001'; end if;
 update app.telegram_history_chats set extraction_enabled=enabled,extraction_pending=enabled,version=version+case when extraction_enabled is distinct from enabled then 1 else 0 end where id=ch.id;
 if enabled and app.telegram_extraction_enqueue_v1(ch.id) then queued:=queued+1; end if; n:=n+1;
 end loop;
 if a='enqueue' then return jsonb_build_object('queued',queued); end if; return jsonb_build_object('ok',true,'updated',n,'queued',queued);
 elsif a in('sourceRetention','reviewBatch') then
 perform app.telegram_extraction_lock_v1(); select * into j from app.telegram_extraction_jobs where id=(p_input->>'jobId')::uuid for no key update;
 if not found then raise exception 'Job unavailable' using errcode='P0002'; end if;
 mode:=case when a='reviewBatch' then 'release_after_review' else p_input->>'mode' end;
 if mode is null or mode not in('keep','release_after_review') or j.status<>'completed' or j.source_purged_at is not null or (a='sourceRetention' and j.source_version is distinct from (p_input->>'expectedSourceVersion')::bigint) then raise exception 'Source changed or unavailable' using errcode='40001'; end if;
 if a='reviewBatch' and ((app.telegram_retention_json_v1(j)#>>'{holds,openDrafts}')::integer>0 or (app.telegram_retention_json_v1(j)#>>'{holds,pendingProposals}')::integer>0 or (app.telegram_retention_json_v1(j)#>>'{holds,activeCv}')::integer>0) then raise exception 'Finish review first' using errcode='23514'; end if;
 update app.telegram_extraction_jobs set source_release_requested_at=case when mode='keep' then null else coalesce(source_release_requested_at,now()) end,cleanup_due_at=case when mode='keep' then null else now() end,source_version=source_version+1 where id=j.id returning * into j;
 perform app.telegram_maintenance_schedule_v1(now()); return jsonb_build_object('ok',true,'sourceRetention',app.telegram_retention_json_v1(j));
 end if;
 return app.telegram_extraction_action_before_retention_v1(p_input);
end $$;

create or replace function app.telegram_extraction_status_v1(p_draft uuid default null,p_view text default 'all',p_after uuid default null) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; rows_json jsonb; attachments jsonb; counts jsonb; cursor_date timestamptz; next_id uuid; pending bigint;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_view not in ('all','needs_review') then raise exception 'Invalid view' using errcode='22023'; end if;
 if p_draft is not null then
  select * into d from app.telegram_drafts where id=p_draft; if not found then raise exception 'Draft unavailable' using errcode='P0002'; end if;
  select count(*) into pending from app.telegram_extraction_proposals where draft_id=p_draft and status='pending';
  with q as (select * from app.telegram_extraction_proposals where draft_id=p_draft and status='pending' and (p_after is null or id>p_after) order by id limit 51), n as (select *,row_number() over(order by id) rn from q)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'jobId',job_id,'draftId',draft_id,'field',field,'currentValue',coalesce(d.fields->field,(select reviewed_fields->field from app.telegram_extraction_subjects where draft_id=d.id limit 1)),'suggestedValue',suggested_value,'status',status,'evidence',evidence,'createdAt',created_at) order by id) filter(where rn<=50),'[]'),case when count(*)>50 then (array_agg(id order by id))[50] end into rows_json,next_id from n;
  select coalesce(jsonb_agg(metadata||jsonb_build_object('jobId',job_id,'messageId',message_id,'attachmentIndex',attachment_index) order by job_id,message_id,attachment_index),'[]') into attachments from (select * from app.telegram_extraction_attachments where draft_id=p_draft order by job_id,message_id,attachment_index limit 50) q;
  return jsonb_build_object('draftId',p_draft,'proposals',rows_json,'attachments',attachments,'humanFields',to_jsonb(d.human_fields),'candidateId',d.approved_candidate_id,'pendingCount',pending,'nextAfter',next_id);
 end if;
 if p_after is not null then select created_at into cursor_date from app.telegram_extraction_jobs where id=p_after; if not found then raise exception 'Cursor unavailable' using errcode='P0002'; end if; end if;
 select jsonb_build_object('queued',count(*) filter(where status='queued'),'leased',count(*) filter(where status='leased'),'waiting',count(*) filter(where status='waiting'),'failed',count(*) filter(where status='failed'),'completed',count(*) filter(where status='completed'),'needsReview',count(*) filter(where app.telegram_retention_needs_review_v1(j)),'contextKept',count(*) filter(where status='completed' and source_release_requested_at is null and source_purged_at is null),'releasePending',count(*) filter(where source_release_requested_at is not null and source_purged_at is null),'purged',count(*) filter(where source_purged_at is not null)) into counts from app.telegram_extraction_jobs j;
 with q as (select j.* from app.telegram_extraction_jobs j where (p_view='all' or app.telegram_retention_needs_review_v1(j)) and (p_after is null or (created_at,id)<(cursor_date,p_after)) order by created_at desc,id desc limit 51), n as (select *,row_number() over(order by created_at desc,id desc) rn from q)
 select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'chatId',j.chat_id,'chatTitle',coalesce(j.source#>>'{chat,title}',(select title from app.telegram_history_chats where id=j.chat_id)),'extractionEnabled',(select extraction_enabled from app.telegram_history_chats where id=j.chat_id),'sourceRetention',(select app.telegram_retention_json_v1(t) from app.telegram_extraction_jobs t where t.id=j.id),'status',j.status,'messageCount',j.message_count,'attempts',j.attempts,'errorCode',j.error_code,'availableAt',j.available_at,'createdAt',j.created_at,'completedAt',j.completed_at,'reviewedAt',j.reviewed_at,'draftIds',coalesce(j.receipt->'draftIds','[]'::jsonb)) order by j.created_at desc,j.id desc) filter(where rn<=50),'[]'),case when count(*)>50 then (array_agg(id order by created_at desc,id desc))[50] end into rows_json,next_id from n j;
 return jsonb_build_object('counts',counts,'jobs',rows_json,'nextAfter',next_id);
end $$;
create or replace function app.telegram_extraction_batch_v1(p_id uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare j app.telegram_extraction_jobs; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into j from app.telegram_extraction_jobs where id=p_id; if not found then raise exception 'Batch unavailable' using errcode='P0002'; end if;
 return jsonb_build_object('jobId',j.id,'source',j.source,'sourceRetention',app.telegram_retention_json_v1(j),'schemaVersion',j.schema_version,'metadata',j.metadata,'reviewedAt',j.reviewed_at);
end $$;
create function app.telegram_retention_purge_v1(p_id uuid) returns jsonb language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare j app.telegram_extraction_jobs; d record; holds jsonb; removed bigint; bytes bigint;
begin
 perform 1 from app.telegram_history_limits where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') for update nowait;
 select * into j from app.telegram_extraction_jobs where id=p_id for no key update nowait;
 if not found or j.status<>'completed' or j.source_release_requested_at is null or j.source_purged_at is not null then return jsonb_build_object('purged',false); end if;
 for d in select t.id from app.telegram_drafts t join app.telegram_retention_drafts_v1(j.id) r on r.id=t.id order by t.id for update of t nowait loop null; end loop;
 perform 1 from app.telegram_extraction_proposals where job_id=j.id order by id for update nowait;
 perform 1 from app.telegram_cv_jobs where extraction_job_id=j.id order by id for update nowait;
 holds:=app.telegram_retention_json_v1(j)->'holds';
 if (holds->>'openDrafts')::integer>0 or (holds->>'pendingProposals')::integer>0 or (holds->>'activeCv')::integer>0 then
 update app.telegram_extraction_jobs set cleanup_due_at=now()+interval '15 minutes' where id=j.id; return jsonb_build_object('purged',false);
 end if;
 delete from app.telegram_draft_evidence x using app.telegram_evidence e where x.evidence_id=e.id and e.extraction_job_id=j.id;
 delete from app.telegram_evidence e where e.extraction_job_id=j.id and not exists(select 1 from app.telegram_draft_evidence x where x.evidence_id=e.id);
 delete from app.telegram_extraction_proposals where job_id=j.id;
 delete from app.telegram_extraction_attachments where job_id=j.id;
 -- Completed upload replay needs its identity digest and reviewed receipt, not
 -- another copy of Telegram attachment/routing metadata or message text.
 update app.telegram_cv_jobs set source=jsonb_build_object('extractionJobId',j.id) where extraction_job_id=j.id and status in('completed','failed','cancelled');
 with gone as(delete from app.telegram_history_messages where extraction_job_id=j.id returning stored_bytes) select count(*),coalesce(sum(stored_bytes),0) into removed,bytes from gone;
 update app.telegram_history_limits set stored_messages=stored_messages-removed,stored_bytes=stored_bytes-bytes where organization_id=j.organization_id and owner_user_id=j.owner_user_id;
 update app.telegram_extraction_jobs set source=null,source_purged_at=now(),source_version=source_version+1,reviewed_at=coalesce(reviewed_at,now()),cleanup_due_at=null where id=j.id;
 return jsonb_build_object('purged',true,'messages',removed,'bytes',bytes);
end $$;
reset role; set local role app_owner;
alter table app.profile_search_queries add column result_cleanup_pending boolean not null default false;
create index profile_search_result_cleanup_idx on app.profile_search_queries(organization_id,owner_user_id,expires_at,id) where result_cleanup_pending;
grant update(result_cleanup_pending) on app.profile_search_queries to app_executor;
reset role; set local role app_executor;
create function app.telegram_expire_queries_v1(p_queries integer,p_rows integer) returns jsonb language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare expired integer:=0; deleted integer:=0; n integer; q record;
begin
 with due as(select id from app.profile_search_queries where expires_at<=now() and status<>'expired' order by expires_at,id limit p_queries for update skip locked), changed as(update app.profile_search_queries target set status='expired',query_text=null,embedding=null,receipt=null,receipt_digest=null,lease_token=null,result_cleanup_pending=true from due where target.id=due.id returning target.id) select count(*) into expired from changed;
 for q in select id from app.profile_search_queries where result_cleanup_pending order by expires_at,id limit 100 for update skip locked loop
 with gone as(delete from app.profile_search_results where (query_id,source_id) in(select query_id,source_id from app.profile_search_results where query_id=q.id limit greatest(0,p_rows-deleted)) returning 1) select count(*) into n from gone;
 deleted:=deleted+n;
 if not exists(select 1 from app.profile_search_results where query_id=q.id) then update app.profile_search_queries set result_cleanup_pending=false where id=q.id; end if;
 exit when deleted>=p_rows;
 end loop;
 return jsonb_build_object('expired',expired,'deleted',deleted);
end $$;
create or replace function app.profile_search_expire_v1() returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin perform app.telegram_expire_queries_v1(100,500); end $$;
alter function app.profile_search_status_v1(text,boolean,uuid,jsonb) rename to profile_search_status_before_retention_v1;
revoke all on function app.profile_search_status_before_retention_v1(text,boolean,uuid,jsonb) from app_staff;
create function app.profile_search_status_v1(p_scope text,p_ready boolean,p_query uuid,p_after jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_query is not null then
 update app.profile_search_queries set status='expired',query_text=null,embedding=null,receipt=null,receipt_digest=null,lease_token=null,result_cleanup_pending=true where id=p_query and expires_at<=now() and status<>'expired';
 end if;
 return app.profile_search_status_before_retention_v1(p_scope,p_ready,p_query,p_after);
end $$;
create function app.telegram_maintenance_v1(p_limit integer default 10) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare owner record; j record; r jsonb; q jsonb; due timestamptz; progressed boolean; owners integer:=0; batches integer:=0; messages bigint:=0; bytes bigint:=0; expired integer:=0; deleted integer:=0; old_org text:=current_setting('app.organization_id',true); old_actor text:=current_setting('app.actor_id',true);
begin
 if p_limit is null or p_limit not between 1 and 10 then raise exception 'Invalid maintenance bound' using errcode='22023'; end if;
 for owner in select * from app.telegram_maintenance_owners where due_at<=now() order by due_at,organization_id,owner_user_id limit p_limit for update skip locked loop
 perform set_config('app.organization_id',owner.organization_id::text,true); perform set_config('app.actor_id',owner.owner_user_id::text,true); owners:=owners+1;
 q:=app.telegram_expire_queries_v1(100-expired,5000-deleted); expired:=expired+(q->>'expired')::integer; deleted:=deleted+(q->>'deleted')::integer; progressed:=(q->>'expired')::integer>0 or (q->>'deleted')::integer>0;
 for j in select id from app.telegram_extraction_jobs where source_release_requested_at is not null and source_purged_at is null and cleanup_due_at<=now() order by cleanup_due_at,id limit 5 loop
 begin
 r:=app.telegram_retention_purge_v1(j.id);
 if (r->>'purged')::boolean then progressed:=true; batches:=batches+1; messages:=messages+(r->>'messages')::bigint; bytes:=bytes+(r->>'bytes')::bigint; end if;
 exception when lock_not_available then null; end;
 end loop;
 select min(t) into due from (
 select cleanup_due_at t from app.telegram_extraction_jobs where source_release_requested_at is not null and source_purged_at is null
 union all select case when result_cleanup_pending then now() else expires_at end from app.profile_search_queries where status<>'expired' or result_cleanup_pending
 ) deadlines;
 if due is null then delete from app.telegram_maintenance_owners where organization_id=owner.organization_id and owner_user_id=owner.owner_user_id;
 else update app.telegram_maintenance_owners set due_at=greatest(case when progressed then clock_timestamp() else now()+interval '1 minute' end,due) where organization_id=owner.organization_id and owner_user_id=owner.owner_user_id; end if;
 -- Leave unvisited owners in place when this invocation exhausts its budget.
 exit when expired>=100 or deleted>=5000;
 end loop;
 perform set_config('app.organization_id',coalesce(old_org,''),true); perform set_config('app.actor_id',coalesce(old_actor,''),true);
 return jsonb_build_object('ownersProcessed',owners,'batchesPurged',batches,'messagesPurged',messages,'bytesFreed',bytes,'queriesExpired',expired,'queryResultRowsDeleted',deleted,'remainingWork',exists(select 1 from app.telegram_maintenance_owners where due_at<=now()+interval '1 minute'));
end $$;
-- Extracted profiles may omit optional secondary emails until the first human save.
create or replace function app.telegram_decide_draft_v1(p_id uuid,p_version bigint,p_action text,p_operation uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; result jsonb; source_id uuid; username text; user_id text;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],p_operation,gen_random_uuid(),true);
    select * into d from app.telegram_drafts where id=p_id for update;
    if not found then raise exception 'Draft unavailable' using errcode='P0002'; end if;
    if d.status='approved' and p_action='approve' then return jsonb_build_object('status','approved','candidateId',d.approved_candidate_id,'replayed',true); end if;
    if d.version<>p_version or d.status in ('approved','discarded') then raise exception 'Draft changed' using errcode='40001'; end if;
    if p_action='approve' then
        if cardinality(app.telegram_missing_v1(d.fields,d.document))>0 then raise exception 'Required candidate information missing' using errcode='23514'; end if;
        username:=d.fields->>'telegramUsername'; user_id:=d.fields->>'telegramUserId';
        if (username is not null and username !~ '^[A-Za-z0-9_]{1,32}$') or (user_id is not null and user_id !~ '^[0-9]{1,30}$') then raise exception 'Invalid Telegram identity' using errcode='22023'; end if;
        result:=app.create_candidate_upload_v1(d.candidate_target_id,jsonb_build_object('secondaryEmails','[]'::jsonb)||(d.fields-array['telegramUsername','telegramUserId']),d.document,p_operation,gen_random_uuid());
        if result->>'status'='duplicate' then
            update app.telegram_drafts set status='duplicate',version=version+1,updated_at=clock_timestamp() where id=p_id;
            return result;
        end if;
        select id into strict source_id from app.candidate_sources where organization_id=d.organization_id and candidate_id=d.candidate_target_id;
        if username is not null then
            insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,source_id,received_at)
            values(gen_random_uuid(),d.organization_id,d.candidate_target_id,'professional_url','https://t.me/'||username,'https://t.me/'||lower(username),1,'unverified',source_id,now());
        end if;
        if user_id is not null then
            insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,source_id,received_at)
            values(gen_random_uuid(),d.organization_id,d.candidate_target_id,'provider_subject','telegram:user:'||user_id,'telegram:user:'||user_id,1,'unverified',source_id,now());
        end if;
        update app.telegram_drafts set status='approved',approved_candidate_id=d.candidate_target_id,fields='{}',document=null,reviewed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=p_id;
    elsif p_action in ('discard','snooze','reopen') then
        if p_action='discard' and d.document is not null then
            insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key) values(d.organization_id,d.owner_user_id,d.document->>'objectKey') on conflict do nothing;
        end if;
        update app.telegram_drafts set status=case p_action when 'discard' then 'discarded' when 'snooze' then 'snoozed' else 'pending' end,
            fields=case when p_action='discard' then '{}'::jsonb else fields end,
            document=case when p_action='discard' then null else document end,version=version+1,updated_at=clock_timestamp() where id=p_id;
    else raise exception 'Invalid decision' using errcode='22023'; end if;
    if p_action in ('approve','discard') then
        delete from app.telegram_draft_evidence where draft_id=p_id;
        delete from app.telegram_evidence e where not exists(select 1 from app.telegram_draft_evidence x where x.evidence_id=e.id);
        delete from app.telegram_draft_embeddings where draft_id=p_id;
        update app.telegram_jobs set status='cancelled',payload='{}',result_sha256=null,finished_at=clock_timestamp(),lease_token=null where draft_id=p_id;
    end if;
    if p_action='approve' then return jsonb_build_object('status','approved','candidateId',d.candidate_target_id); end if;
    return app.telegram_get_draft_v1(p_id);
end $$;

do $$ declare f record; begin
 for f in select oid::regprocedure sig from pg_proc where pronamespace='app'::regnamespace and (proname like 'telegram_retention_%' or proname like 'telegram_maintenance_%' or proname in('telegram_extraction_import_v1','telegram_expire_queries_v1','telegram_extraction_receipt_v1','telegram_extraction_action_v1','profile_search_status_v1')) loop execute format('revoke all on function %s from public',f.sig); end loop;
end $$;
grant execute on function app.telegram_extraction_action_v1(jsonb),app.profile_search_status_v1(text,boolean,uuid,jsonb) to app_staff;
grant execute on function app.telegram_extraction_receipt_v1(text,uuid,text,jsonb,jsonb) to app_telegram_worker;
grant execute on function app.telegram_maintenance_v1(integer) to app_telegram_maintenance;
reset role; set local role app_owner;
revoke create on schema app from app_executor;
revoke trigger on app.telegram_history_messages,app.telegram_evidence,app.telegram_drafts,app.telegram_extraction_proposals,app.telegram_cv_jobs,app.profile_search_queries from app_executor;
reset role;
-- Migration operator backfills only non-content maintenance scope identifiers.
update app.profile_search_queries q set result_cleanup_pending=true where q.status='expired' and exists(select 1 from app.profile_search_results r where r.query_id=q.id);
insert into app.telegram_maintenance_owners(organization_id,owner_user_id,due_at) select organization_id,owner_user_id,min(case when result_cleanup_pending then now() else expires_at end) from app.profile_search_queries where status<>'expired' or result_cleanup_pending group by organization_id,owner_user_id on conflict do nothing;
commit;
