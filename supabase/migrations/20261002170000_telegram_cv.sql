begin;
set local lock_timeout='2s'; set local statement_timeout='30s';
set local role app_owner;
create index telegram_cv_attachment_page_idx on app.telegram_extraction_attachments(draft_id,job_id,(message_id::bigint),attachment_index);
alter table app.telegram_drafts add column document_revision bigint not null default 0 check(document_revision>=0);
update app.telegram_drafts set document_revision=1 where document is not null;
create table app.telegram_cv_jobs (
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,owner_user_id uuid not null,draft_id uuid not null,account_id uuid not null,extraction_job_id uuid not null,
 connection_id uuid not null references app.telegram_connections(id),connection_generation bigint not null check(connection_generation>0),document_revision bigint not null check(document_revision>=0),
 source jsonb not null check(jsonb_typeof(source)='object' and octet_length(source::text)<=4096),source_digest bytea not null check(octet_length(source_digest)=32),
 status text not null default 'queued' check(status in ('queued','leased','waiting','failed','cancelled','completed')),
 attempts integer not null default 0 check(attempts between 0 and 5),lease_token uuid,lease_worker_id uuid references app.telegram_workers(id),lease_expires_at timestamptz,
 available_at timestamptz not null default now(),error_code text,object_key text,upload_lease_token uuid,upload_sha256 text,upload_size integer,upload_type text,upload_extension text,
 receipt jsonb,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,extraction_job_id) references app.telegram_extraction_jobs(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,account_id) references app.telegram_history_accounts(organization_id,owner_user_id,id)
);
create unique index telegram_cv_active_draft_idx on app.telegram_cv_jobs(draft_id) where status in ('queued','leased','waiting');
create index telegram_cv_claim_idx on app.telegram_cv_jobs(organization_id,owner_user_id,account_id,status,available_at,created_at,id);
create index telegram_cv_draft_idx on app.telegram_cv_jobs(draft_id,created_at desc,id desc);
alter table app.telegram_cv_jobs enable row level security; alter table app.telegram_cv_jobs force row level security;
grant select,insert,update,delete on app.telegram_cv_jobs to app_executor;
create policy telegram_cv_owner on app.telegram_cv_jobs for all to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')) with check(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
grant trigger on app.telegram_drafts to app_executor; grant create on schema app to app_executor;
reset role; set local role app_executor;
create function app.telegram_cv_document_guard_v1() returns trigger language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 if new.document is distinct from old.document then new.document_revision:=old.document_revision+1; end if;
 if new.document is distinct from old.document or new.status in ('approved','discarded') then
  update app.telegram_cv_jobs set status='cancelled',error_code=case when new.status in ('approved','discarded') then 'DRAFT_CLOSED' else 'DRAFT_DOCUMENT_CHANGED' end,lease_expires_at=null,updated_at=clock_timestamp() where draft_id=old.id and status in ('queued','leased','waiting');
 end if;
 return new;
end $$;
create trigger telegram_cv_document_guard before update of document,status on app.telegram_drafts for each row execute function app.telegram_cv_document_guard_v1();
create function app.telegram_cv_worker_v1(p_token text,p_connection uuid,p_generation bigint,p_lease uuid,p_user text) returns app.telegram_history_accounts language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ declare a app.telegram_history_accounts; begin
 a:=app.telegram_history_worker_v1(p_token,p_connection,p_generation,p_lease,p_user);
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false);
 if a.id is null then raise exception 'Source account unavailable' using errcode='40001'; end if; return a;
end $$;
create function app.telegram_cv_expire_v1() returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin
 update app.telegram_cv_jobs j set status='failed',error_code='CONNECTION_CHANGED',lease_expires_at=null,updated_at=clock_timestamp()
 where status in ('queued','leased','waiting') and not exists(select 1 from app.telegram_connections c where c.id=j.connection_id and c.status='connected' and c.generation=j.connection_generation and c.profile->>'telegramUserId'=j.source->>'accountUserId');
end $$;
create function app.telegram_cv_eligible_v1(m jsonb,d app.telegram_drafts,account_user text,c app.telegram_connections) returns text language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$ begin
 if d.status not in ('pending','snoozed','duplicate') then return 'DRAFT_CLOSED'; end if;
 if d.document is not null then return 'CV_EXISTS'; end if;
 if not coalesce(m->>'kind'='document' and m->>'id' ~ '^[1-9][0-9]{0,29}$',false) then return 'SOURCE_UNAVAILABLE'; end if;
 if not coalesce(m->>'filename' ~* '\.(pdf|docx)$' and char_length(m->>'filename') between 1 and 512 and m->>'filename' !~ '[[:cntrl:]]',false) then return 'UNSUPPORTED_FILE'; end if;
 if m->>'sizeBytes' is not null and (m->>'sizeBytes')::numeric not between 1 and 4194304 then return 'FILE_TOO_LARGE'; end if;
 if c.id is null or c.status<>'connected' then return 'CONNECTION_REQUIRED'; end if;
 if c.profile->>'telegramUserId' is distinct from account_user then return 'ACCOUNT_MISMATCH'; end if;
 return null;
end $$;
create function app.telegram_cv_job_json_v1(j app.telegram_cv_jobs,d app.telegram_drafts,c app.telegram_connections) returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('id',j.id,'draftId',j.draft_id,'status',j.status,'errorCode',j.error_code,'attempts',j.attempts,'availableAt',j.available_at,'updatedAt',j.updated_at,'source',j.source,'completion',j.receipt,
 'canRetry',coalesce(j.status in ('failed','cancelled') and d.status in ('pending','snoozed','duplicate') and d.document is null and d.document_revision=j.document_revision and c.status='connected' and c.profile->>'telegramUserId'=j.source->>'accountUserId',false));
$$;
create function app.telegram_cv_status_v1(p_draft uuid,p_after_job uuid default null,p_after_message bigint default null,p_after_index integer default null) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts;c app.telegram_connections; rows_json jsonb;jobs jsonb;next_cursor text;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false); perform app.telegram_cv_expire_v1();
 select * into d from app.telegram_drafts where id=p_draft; if not found then raise exception 'Draft unavailable' using errcode='P0002'; end if;
 select * into c from app.telegram_connections;
 with items as (select a.*,j.source#>>'{chat,accountUserId}' account_user,app.telegram_cv_eligible_v1(a.metadata,d,j.source#>>'{chat,accountUserId}',c) reason
 from app.telegram_extraction_attachments a join app.telegram_extraction_jobs j on j.id=a.job_id where a.draft_id=p_draft and (p_after_job is null or (a.job_id,a.message_id::bigint,a.attachment_index)>(p_after_job,p_after_message,p_after_index)) order by a.job_id,a.message_id::bigint,a.attachment_index limit 51), numbered as (select *,row_number() over(order by job_id,message_id::bigint,attachment_index) n from items)
 select coalesce(jsonb_agg(jsonb_build_object('extractionJobId',job_id,'messageId',message_id,'attachmentIndex',attachment_index,'filename',metadata->'filename','mimeType',metadata->'mimeType','sizeBytes',metadata->'sizeBytes','documentId',metadata->'id','eligible',reason is null,'reason',reason) order by n) filter(where n<=50),'[]'),max(case when n=50 then job_id||':'||message_id||':'||attachment_index end) filter(where (select count(*) from numbered)>50) into rows_json,next_cursor from numbered;
 select coalesce(jsonb_agg(app.telegram_cv_job_json_v1(j,d,c) order by j.created_at desc,j.id desc),'[]') into jobs from(select * from app.telegram_cv_jobs where draft_id=p_draft order by created_at desc,id desc limit 20) j;
 return jsonb_build_object('draftId',d.id,'documentRevision',d.document_revision,'cv',case when d.document is null then null else jsonb_build_object('filename',d.document->>'filename','status','validated') end,
 'canRetrieve',coalesce(d.status in ('pending','snoozed','duplicate') and d.document is null and c.status='connected',false),'connectionIssue',case when c.id is null or c.status<>'connected' then 'CONNECTION_REQUIRED' end,'attachments',rows_json,'jobs',jobs,'nextAfter',next_cursor);
end $$;
create function app.telegram_cv_action_v1(p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare c app.telegram_connections;a app.telegram_history_accounts;d app.telegram_drafts;j app.telegram_cv_jobs; hint app.telegram_extraction_attachments;ex app.telegram_extraction_jobs;src jsonb;reason text;act text;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.write'],null,null,false); act:=p_input->>'action';
 select * into c from app.telegram_connections for share;
 if c.status='connected' then select * into a from app.telegram_history_accounts where connection_id=c.id and account_user_id=c.profile->>'telegramUserId' for update; end if;
 if act='retrieve' then
  select * into d from app.telegram_drafts where id=(p_input->>'draftId')::uuid for update;
  if not found then raise exception 'Draft unavailable' using errcode='P0002'; end if;
  if d.document_revision is distinct from (p_input->>'expectedDocumentRevision')::bigint or d.document is not null or d.status not in ('pending','snoozed','duplicate') then raise exception 'CV changed' using errcode='40001'; end if;
  select * into hint from app.telegram_extraction_attachments where draft_id=d.id and job_id=(p_input->>'extractionJobId')::uuid and message_id=p_input->>'messageId' and attachment_index=(p_input->>'attachmentIndex')::integer;
  if not found then raise exception 'Attachment unavailable' using errcode='P0002'; end if;
  select * into strict ex from app.telegram_extraction_jobs where id=hint.job_id;
  reason:=app.telegram_cv_eligible_v1(hint.metadata,d,ex.source#>>'{chat,accountUserId}',c);
  if reason is not null or a.id is null then raise exception 'Attachment cannot be retrieved' using errcode='23514'; end if;
  src:=jsonb_build_object('extractionJobId',hint.job_id,'chatId',ex.chat_id,'accountUserId',a.account_user_id,'peer',ex.source#>'{chat,peer}','messageId',hint.message_id,'attachmentIndex',hint.attachment_index,'documentId',hint.metadata->'id','filename',hint.metadata->'filename','mimeType',hint.metadata->'mimeType','sizeBytes',hint.metadata->'sizeBytes');
  select * into j from app.telegram_cv_jobs where draft_id=d.id and status in ('queued','leased','waiting') for update;
  if found then
   if j.source=src and j.connection_generation=c.generation then return jsonb_build_object('job',app.telegram_cv_job_json_v1(j,d,c)); end if;
   raise exception 'Cancel existing retrieval first' using errcode='40001';
  end if;
  insert into app.telegram_cv_jobs(organization_id,owner_user_id,draft_id,account_id,extraction_job_id,connection_id,connection_generation,document_revision,source,source_digest)
  values(d.organization_id,d.owner_user_id,d.id,a.id,hint.job_id,c.id,c.generation,d.document_revision,src,sha256(convert_to(src::text,'UTF8'))) returning * into j;
 elsif act in ('cancel','retry') then
  select * into j from app.telegram_cv_jobs where id=(p_input->>'jobId')::uuid;
  if not found then raise exception 'Retrieval unavailable' using errcode='P0002'; end if;
  select * into d from app.telegram_drafts where id=j.draft_id for update;
  select * into j from app.telegram_cv_jobs where id=j.id for update;
  if act='cancel' then
   if j.status='completed' then raise exception 'Retrieval completed' using errcode='40001'; end if;
   update app.telegram_cv_jobs set status='cancelled',error_code='CANCELLED',lease_expires_at=null,updated_at=clock_timestamp() where id=j.id returning * into j;
  else
   if j.status not in ('failed','cancelled') or d.status not in ('pending','snoozed','duplicate') or d.document is not null or d.document_revision<>j.document_revision or a.id is distinct from j.account_id then raise exception 'Retrieval cannot retry' using errcode='40001'; end if;
   update app.telegram_cv_jobs set status='queued',connection_generation=c.generation,attempts=0,lease_token=null,lease_worker_id=null,lease_expires_at=null,available_at=clock_timestamp(),error_code=null,object_key=null,upload_lease_token=null,upload_sha256=null,upload_size=null,upload_type=null,upload_extension=null,updated_at=clock_timestamp() where id=j.id returning * into j;
  end if;
 else raise exception 'Invalid CV action' using errcode='22023'; end if;
 return jsonb_build_object('job',app.telegram_cv_job_json_v1(j,d,c));
end $$;
create function app.telegram_cv_claim_v1(p_token text,p_connection uuid,p_generation bigint,p_lease uuid,p_user text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;j app.telegram_cv_jobs;w uuid;begin
 a:=app.telegram_cv_worker_v1(p_token,p_connection,p_generation,p_lease,p_user); select worker_id into w from app.telegram_connections where id=p_connection;
 if a.cooldown_until>clock_timestamp() then return jsonb_build_object('job',null,'retryAt',a.cooldown_until); end if;
 update app.telegram_cv_jobs set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_expires_at=null,updated_at=clock_timestamp() where account_id=a.id and status='leased' and lease_expires_at<=clock_timestamp() and attempts>=5;
 select * into j from app.telegram_cv_jobs where account_id=a.id and connection_generation=p_generation and status='leased' and lease_worker_id=w and lease_expires_at>clock_timestamp() order by created_at,id limit 1 for update;
 if found then update app.telegram_cv_jobs set lease_expires_at=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp() where id=j.id returning * into j;
 else
  select * into j from app.telegram_cv_jobs where account_id=a.id and connection_generation=p_generation and attempts<5 and ((status in ('queued','waiting') and available_at<=clock_timestamp()) or (status='leased' and lease_expires_at<=clock_timestamp())) order by available_at,created_at,id limit 1 for update;
  if not found then return jsonb_build_object('job',null,'retryAt',null); end if;
  update app.telegram_cv_jobs set status='leased',attempts=attempts+1,lease_worker_id=w,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '180 seconds',error_code=null,object_key=null,upload_lease_token=null,upload_sha256=null,upload_size=null,upload_type=null,upload_extension=null,updated_at=clock_timestamp() where id=j.id returning * into j;
 end if;
 return jsonb_build_object('job',jsonb_build_object('id',j.id,'leaseToken',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'sourceDigest',encode(j.source_digest,'hex'),'source',j.source),'retryAt',null);
end $$;
create function app.telegram_cv_defer_v1(p_token text,p_connection uuid,p_generation bigint,p_lease uuid,p_user text,p_job uuid,p_job_lease uuid,p_code text,p_delay integer) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;j app.telegram_cv_jobs;w uuid;retry timestamptz;begin
 a:=app.telegram_cv_worker_v1(p_token,p_connection,p_generation,p_lease,p_user); select worker_id into w from app.telegram_connections where id=p_connection;
 if p_code not in ('FLOOD_WAIT','TELEGRAM_UNAVAILABLE','SOURCE_CHANGED','SOURCE_UNAVAILABLE','FILE_TOO_LARGE','INVALID_FILE','WORKER_ERROR') or p_delay not between 1 and 604800 then raise exception 'Invalid defer' using errcode='22023'; end if;
 select * into j from app.telegram_cv_jobs where id=p_job and account_id=a.id and connection_generation=p_generation for update;
 if not found then raise exception 'Retrieval changed' using errcode='40001'; end if;
 if j.status in ('waiting','failed') and j.lease_token=p_job_lease and j.lease_worker_id=w and j.error_code=p_code then return jsonb_build_object('ok',true); end if;
 if j.status<>'leased' or j.lease_token is distinct from p_job_lease or j.lease_worker_id is distinct from w or j.lease_expires_at<=clock_timestamp() then raise exception 'Retrieval lease changed' using errcode='40001'; end if;
 retry:=clock_timestamp()+make_interval(secs=>p_delay);
 if p_code='FLOOD_WAIT' then update app.telegram_history_accounts set cooldown_until=greatest(coalesce(cooldown_until,retry),retry) where id=a.id; end if;
 update app.telegram_cv_jobs set status=case when p_code='FLOOD_WAIT' or (p_code in ('TELEGRAM_UNAVAILABLE','WORKER_ERROR') and attempts<5) then 'waiting' else 'failed' end,attempts=case when p_code='FLOOD_WAIT' then greatest(0,attempts-1) else attempts end,available_at=retry,error_code=p_code,lease_expires_at=null,updated_at=clock_timestamp() where id=j.id;
 return jsonb_build_object('ok',true);
end $$;

-- All upload stages repeat the connection, permission, draft-document and job
-- checks. Only the restricted host role can call these; Mac has only HTTPS token.
create function app.telegram_cv_upload_stage_v1(p_token text,p_connection uuid,p_generation bigint,p_lease uuid,p_user text,p_job uuid,p_job_lease uuid,p_source_digest text,p_sha text,p_size integer,p_stage text,p_type text default null,p_extension text default null) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.telegram_history_accounts;j app.telegram_cv_jobs;d app.telegram_drafts;w uuid;key text;state text;doc jsonb;
begin
 a:=app.telegram_cv_worker_v1(p_token,p_connection,p_generation,p_lease,p_user); select worker_id into w from app.telegram_connections where id=p_connection;
 select * into j from app.telegram_cv_jobs where id=p_job and account_id=a.id and connection_generation=p_generation;
 if not found then raise exception 'Retrieval changed' using errcode='40001'; end if;
 select * into d from app.telegram_drafts where id=j.draft_id for update;
 select * into j from app.telegram_cv_jobs where id=j.id for update;
 if p_sha is null or p_sha !~ '^[0-9a-f]{64}$' or p_size not between 1 and 4194304 or encode(j.source_digest,'hex') is distinct from p_source_digest then raise exception 'Invalid file identity' using errcode='22023'; end if;
 if j.status='completed' then
  if j.upload_sha256=p_sha and j.upload_size=p_size then return jsonb_build_object('completed',j.receipt); end if;
  raise exception 'Completed file differs' using errcode='40001';
 end if;
 if j.status<>'leased' or j.lease_token is distinct from p_job_lease or j.lease_worker_id is distinct from w or j.lease_expires_at<=clock_timestamp() or d.status not in ('pending','snoozed','duplicate') or d.document is not null or d.document_revision<>j.document_revision then raise exception 'CV or retrieval changed' using errcode='40001'; end if;
 if j.source->>'sizeBytes' is not null and (j.source->>'sizeBytes')::bigint<>p_size then raise exception 'Source size changed' using errcode='22023'; end if;
 if p_stage='preflight' then return jsonb_build_object('completed',null,'filename',j.source->>'filename'); end if;
 if p_stage='reserve' then
  if not coalesce((p_extension='pdf' and p_type='application/pdf') or (p_extension='docx' and p_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'),false) or lower(split_part(j.source->>'filename','.',-1))<>p_extension then raise exception 'Invalid CV type' using errcode='22023'; end if;
  if j.object_key is not null and j.upload_lease_token=p_job_lease then
   if j.upload_sha256 is distinct from p_sha or j.upload_size is distinct from p_size or j.upload_type is distinct from p_type then raise exception 'Upload changed' using errcode='40001'; end if;
   select c.state into state from app.telegram_upload_cleanup c where c.object_key=j.object_key for update;
   if state is distinct from 'pending' then raise exception 'Upload reservation expired' using errcode='40001'; end if;
   key:=j.object_key;
  else
   key:='staff/'||d.organization_id||'/'||d.candidate_target_id||'/'||gen_random_uuid()||'.'||p_extension;
   insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key,available_at) values(d.organization_id,d.owner_user_id,key,clock_timestamp()+interval '1 hour');
   update app.telegram_cv_jobs set object_key=key,upload_lease_token=p_job_lease,upload_sha256=p_sha,upload_size=p_size,upload_type=p_type,upload_extension=p_extension where id=j.id;
  end if;
  return jsonb_build_object('completed',null,'objectKey',key);
 elsif p_stage='finalize' then
  if j.object_key is null or j.upload_lease_token is distinct from p_job_lease or j.upload_sha256 is distinct from p_sha or j.upload_size is distinct from p_size then raise exception 'Upload reservation changed' using errcode='40001'; end if;
  select c.state into state from app.telegram_upload_cleanup c where c.object_key=j.object_key for update;
  if state is distinct from 'pending' then raise exception 'Upload reservation expired' using errcode='40001'; end if;
  doc:=jsonb_build_object('filename',j.source->>'filename','objectKey',j.object_key,'sha256',j.upload_sha256,'sizeBytes',j.upload_size,'mimeType',j.upload_type,'extension',j.upload_extension);
  update app.telegram_cv_jobs set status='completed',lease_expires_at=null,updated_at=clock_timestamp() where id=j.id;
  update app.telegram_drafts set document=doc,version=version+1,updated_at=clock_timestamp() where id=d.id returning * into d;
  delete from app.telegram_upload_cleanup where object_key=j.object_key;
  delete from app.telegram_draft_embeddings where draft_id=d.id;
  update app.telegram_cv_jobs set receipt=jsonb_build_object('ok',true,'jobId',j.id,'draftId',d.id,'status','completed','draftVersion',d.version,'documentRevision',d.document_revision,'cv',jsonb_build_object('filename',doc->>'filename','status','validated')) where id=j.id returning * into j;
  return jsonb_build_object('completed',j.receipt);
 end if;
 raise exception 'Invalid upload stage' using errcode='22023';
end $$;

create or replace function app.telegram_draft_json_v1(d app.telegram_drafts)
returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('id',d.id,'version',d.version,'documentRevision',d.document_revision,'status',d.status,'fields',d.fields,
 'cv',case when d.document is null then null else jsonb_build_object('filename',d.document->>'filename','status','validated') end,
 'missingFields',to_jsonb(app.telegram_missing_v1(d.fields,d.document)||case when p.n>0 then array['proposals'] else '{}'::text[] end),
 'pendingProposalCount',p.n,'sourceTitle',d.source_title,'updatedAt',d.updated_at,'candidateId',d.approved_candidate_id)
 from (select count(*) n from app.telegram_extraction_proposals where draft_id=d.id and status='pending') p;
$$;

do $$ declare r record; begin
 for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname in ('telegram_cv_document_guard_v1','telegram_cv_worker_v1','telegram_cv_expire_v1','telegram_cv_eligible_v1','telegram_cv_job_json_v1','telegram_cv_status_v1','telegram_cv_action_v1','telegram_cv_claim_v1','telegram_cv_defer_v1','telegram_cv_upload_stage_v1') loop execute format('revoke all on function %s from public',r.sig); end loop;
end $$;
grant execute on function app.telegram_cv_status_v1(uuid,uuid,bigint,integer),app.telegram_cv_action_v1(jsonb) to app_staff;
grant execute on function app.telegram_cv_claim_v1(text,uuid,bigint,uuid,text),app.telegram_cv_defer_v1(text,uuid,bigint,uuid,text,uuid,uuid,text,integer),app.telegram_cv_upload_stage_v1(text,uuid,bigint,uuid,text,uuid,uuid,text,text,integer,text,text,text) to app_telegram_worker;
reset role; set local role app_owner; revoke trigger on app.telegram_drafts from app_executor; revoke create on schema app from app_executor; commit;
