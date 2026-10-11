begin;
set local lock_timeout='2s';set local statement_timeout='30s';set local role app_owner;
alter table app.telegram_extraction_jobs drop constraint telegram_extraction_jobs_schema_version_check;
alter table app.telegram_extraction_jobs add constraint telegram_extraction_jobs_schema_version_check check(schema_version in('candidate-extraction-v1','candidate-extraction-v2'));
create table app.telegram_extraction_context_dependencies(
 organization_id uuid not null,owner_user_id uuid not null,job_id uuid not null,chat_id uuid not null,message_id bigint not null check(message_id between 1 and 2147483647),origin_job_id uuid not null,body_digest bytea not null check(octet_length(body_digest)=32),
 primary key(job_id,chat_id,message_id),
 foreign key(organization_id,owner_user_id,job_id) references app.telegram_extraction_jobs(organization_id,owner_user_id,id) on delete cascade,
 foreign key(organization_id,owner_user_id,origin_job_id) references app.telegram_extraction_jobs(organization_id,owner_user_id,id) on delete cascade,
 foreign key(organization_id,owner_user_id,chat_id) references app.telegram_history_chats(organization_id,owner_user_id,id) on delete cascade
);
create index telegram_context_dependency_origin_idx on app.telegram_extraction_context_dependencies(origin_job_id,job_id);
create index telegram_context_dependency_message_idx on app.telegram_extraction_context_dependencies(chat_id,message_id,job_id);
alter table app.telegram_extraction_context_dependencies enable row level security;alter table app.telegram_extraction_context_dependencies force row level security;
create policy telegram_context_dependency_owner on app.telegram_extraction_context_dependencies for all to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')) with check(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
grant select,insert,delete on app.telegram_extraction_context_dependencies to app_executor;
grant trigger on app.telegram_history_messages to app_executor;
grant create on schema app to app_executor;
reset role;set local role app_executor;
create or replace function app.telegram_extraction_claim_before_source_refresh_v1(p_token text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare w uuid; j app.telegram_extraction_jobs; ch record; begin
 w:=app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 for ch in select id from app.telegram_history_chats where extraction_enabled and extraction_pending order by extraction_served_at,id limit 10 for update skip locked loop perform app.telegram_extraction_enqueue_v1(ch.id); end loop;
 update app.telegram_extraction_jobs set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_expires_at=null where status='leased' and lease_expires_at<=clock_timestamp() and attempts>=5;
 select * into j from app.telegram_extraction_jobs where (schema_version='candidate-extraction-v1' or current_setting('app.telegram_extraction_context_claim',true)='true') and ((status in ('queued','waiting') and available_at<=clock_timestamp()) or (status='leased' and lease_expires_at<=clock_timestamp())) and attempts<5 and exists(select 1 from app.telegram_history_chats c where c.id=chat_id and c.extraction_enabled) order by available_at,created_at,id limit 1 for update;
 if not found then return jsonb_build_object('job',null); end if;
 update app.telegram_extraction_jobs set status='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_worker_id=w,lease_expires_at=clock_timestamp()+interval '180 seconds',error_code=null where id=j.id returning * into j;
 return jsonb_build_object('job',jsonb_build_object('id',j.id,'leaseToken',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'sourceDigest',encode(j.source_digest,'hex'),'schemaVersion',j.schema_version,'promptVersion',case when j.schema_version='candidate-extraction-v2' then 'candidate-extraction-prompt-v2' else 'candidate-extraction-prompt-v1' end,'source',j.source,'sourceLimitBytes',case when octet_length(j.source::text)>49152 then 327680 else 49152 end));
end $$;

create or replace function app.telegram_extraction_complete_before_source_refresh_v1(p_token text,p_job uuid,p_lease uuid,p_source_digest text,p_result jsonb,p_metadata jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; j app.telegram_extraction_jobs; s jsonb; f jsonb; facts jsonb; e jsonb; m jsonb; a jsonb; subj app.telegram_extraction_subjects; d app.telegram_drafts;
 ident text; digest bytea; eid uuid; did uuid; ids uuid[]:='{}'; n integer:=0; next_queued boolean; current_fields jsonb; k text; val jsonb; state text; changed boolean; seen text[]:='{}';
begin
 w:=app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 select * into j from app.telegram_extraction_jobs where id=p_job for update;
 if not found then raise exception 'Job unavailable' using errcode='P0002'; end if;
 if not coalesce(app.telegram_history_keys_v1(p_metadata,array['model','promptVersion','reportedModel']) and p_metadata->>'promptVersion'=case when j.schema_version='candidate-extraction-v2' then 'candidate-extraction-prompt-v2' else 'candidate-extraction-prompt-v1' end and p_metadata->>'model' ~ '^[A-Za-z0-9._:/-]{1,120}$' and strpos(p_metadata->>'model','://')=0 and (p_metadata->'reportedModel'='null'::jsonb or (p_metadata->>'reportedModel' ~ '^[A-Za-z0-9._:/-]{1,120}$' and strpos(p_metadata->>'reportedModel','://')=0)),false) or octet_length(p_result::text)>150000 then raise exception 'Invalid extraction result' using errcode='22023'; end if;
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


create function app.telegram_context_literal_v2(q text,v text) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$
declare folded text:=translate(q,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');needle text:=translate(v,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');start_at integer:=1;at integer;
begin
 if needle is null or needle='' or folded is null then return false;end if;
 loop
 at:=strpos(substr(folded,start_at),needle);if at=0 then return false;end if;at:=at+start_at-1;
 if (at=1 or substr(folded,at-1,1)!~ '[[:alnum:]]') and (at+length(needle)>length(folded) or substr(folded,at+length(needle),1)!~ '[[:alnum:]]') then return true;end if;
 start_at:=at+length(needle);
 end loop;
end $$;
revoke all on function app.telegram_context_literal_v2(text,text) from public;

-- V2 adds literal primary-value support. This reduces paraphrasing without
-- changing old v1 replay/validation semantics or claiming semantic certainty.
alter function app.telegram_extraction_validate_v1(jsonb,jsonb) rename to telegram_extraction_validate_before_context_v2;
create function app.telegram_extraction_validate_v1(p jsonb,src jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$
declare s jsonb;f jsonb;v jsonb;
begin
 if not app.telegram_extraction_validate_before_context_v2(p,src) then return false;end if;
 if not src ? 'contextOnly' then return true;end if;
 for s in select value from jsonb_array_elements(p->'subjects') loop
 for f in select value from jsonb_array_elements(s->'facts') loop
 for v in select value from jsonb_array_elements(case when jsonb_typeof(f->'value')='array' then f->'value' else jsonb_build_array(f->'value') end) loop
 if not exists(select 1 from jsonb_array_elements(f->'evidence') e where app.telegram_context_literal_v2(e->>'quote',v#>>'{}')) then return false;end if;
 end loop;end loop;end loop;return true;
end $$;
revoke all on function app.telegram_extraction_validate_v1(jsonb,jsonb) from public;

-- Add bounded per-job version metadata after the existing authorization and
-- pagination seam; no full status query or source bodies are duplicated.
alter function app.telegram_extraction_status_v1(uuid,text,uuid) rename to telegram_extraction_status_before_context_v2;
revoke all on function app.telegram_extraction_status_before_context_v2(uuid,text,uuid) from app_staff;
create function app.telegram_extraction_status_v1(p_draft uuid default null,p_view text default 'all',p_after uuid default null) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r jsonb;rows_json jsonb;
begin
 r:=app.telegram_extraction_status_before_context_v2(p_draft,p_view,p_after);
 if r ? 'jobs' then
 select coalesce(jsonb_agg(e.value||jsonb_build_object('schemaVersion',j.schema_version) order by e.ordinality),'[]') into rows_json from jsonb_array_elements(r->'jobs') with ordinality e join app.telegram_extraction_jobs j on j.id=(e.value->>'id')::uuid;
 r:=jsonb_set(r,'{jobs}',rows_json);
 end if;return r;
end $$;
revoke all on function app.telegram_extraction_status_v1(uuid,text,uuid) from public;
grant execute on function app.telegram_extraction_status_v1(uuid,text,uuid) to app_staff;

-- Context is versioned only after an explicit capable-worker claim. Existing
-- enqueue/import primary quotas and all old completion receipts stay unchanged.
alter function app.telegram_extraction_claim_v1(text) rename to telegram_extraction_claim_before_context_v2;
revoke all on function app.telegram_extraction_claim_before_context_v2(text) from app_telegram_worker;
create function app.telegram_extraction_context_claim_v2(p_token text,p_enabled boolean) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp set statement_timeout='10s' as $$
declare r jsonb;j app.telegram_extraction_jobs;m record;src jsonb;ctx jsonb:='[]';trial jsonb;max_bytes integer;prior text:=current_setting('app.telegram_extraction_context_claim',true);origins uuid[];
begin
 perform set_config('app.telegram_extraction_context_claim',case when p_enabled then 'true' else 'false' end,true);
 r:=app.telegram_extraction_claim_before_context_v2(p_token);
 if r->'job'='null'::jsonb then perform set_config('app.telegram_extraction_context_claim',coalesce(prior,''),true);return r;end if;
 select * into strict j from app.telegram_extraction_jobs where id=(r#>>'{job,id}')::uuid for update;
 if p_enabled and j.schema_version='candidate-extraction-v1' then
 src:=j.source;max_bytes:=case when octet_length(src::text)>49152 then 327680 else 49152 end;
 for m in
 with recursive primary_ids as(select (value->>'messageId')::bigint id,value from jsonb_array_elements(src->'messages')),
 replies(id,depth) as(
  select (value->>'replyToMessageId')::bigint,1 from primary_ids where value->>'replyToMessageId' ~ '^[1-9][0-9]{0,9}$'
  union all select (h.body->>'replyToMessageId')::bigint,r.depth+1 from replies r join app.telegram_history_messages h on h.chat_id=j.chat_id and h.message_id=r.id where r.depth<2 and h.body->>'replyToMessageId' ~ '^[1-9][0-9]{0,9}$'
 ), nearby as(select h.message_id id,3 depth from app.telegram_history_messages h where h.chat_id=j.chat_id and h.message_id<(select min(id) from primary_ids) order by h.message_id desc limit 8),
 wanted as(select id,min(depth) depth from(select * from replies union all select * from nearby)w group by id)
 select h.message_id,h.body,l.origin_job_id from wanted w join app.telegram_history_messages h on h.chat_id=j.chat_id and h.message_id=w.id
 join app.telegram_extraction_sources l on l.chat_id=h.chat_id and l.message_id=h.message_id
 join app.telegram_extraction_jobs origin on origin.id=l.origin_job_id and origin.chat_id=j.chat_id
 where h.organization_id=j.organization_id and h.owner_user_id=j.owner_user_id and h.body->>'kind'='message'
 and origin.source_release_requested_at is null and origin.source_purged_at is null and (origin.created_at,origin.id)<(j.created_at,j.id)
 and not exists(select 1 from primary_ids p where p.id=h.message_id)
 order by w.depth,h.message_id desc limit 8 loop
 trial:=jsonb_set(src,'{contextOnly}',ctx||jsonb_build_array(m.body),true);
 if octet_length((ctx||jsonb_build_array(m.body))::text)>8192 or octet_length(trial::text)>max_bytes then continue;end if;
 ctx:=ctx||jsonb_build_array(m.body);
 insert into app.telegram_extraction_context_dependencies(organization_id,owner_user_id,job_id,chat_id,message_id,origin_job_id,body_digest) values(j.organization_id,j.owner_user_id,j.id,j.chat_id,m.message_id,m.origin_job_id,sha256(convert_to(m.body::text,'UTF8')));
 end loop;
 src:=jsonb_set(src,'{contextOnly}',ctx,true);
 -- If a full legal singleton leaves no room even for the empty role marker,
 -- preserve v1; never truncate primary source text to fit optional context.
 if jsonb_array_length(ctx)>0 and octet_length(src::text)<=max_bytes then
 select coalesce(array_agg(distinct x),'{}') into origins from(select unnest(j.source_origin_jobs)x union select origin_job_id from app.telegram_extraction_context_dependencies where job_id=j.id)q;
 update app.telegram_extraction_jobs set schema_version='candidate-extraction-v2',source=src,source_digest=sha256(convert_to(src::text,'UTF8')),source_origin_jobs=origins where id=j.id returning * into j;
 else delete from app.telegram_extraction_context_dependencies where job_id=j.id;end if;
 end if;
 r:=jsonb_build_object('job',(r->'job')||jsonb_build_object('schemaVersion',j.schema_version,'promptVersion',case when j.schema_version='candidate-extraction-v2' then 'candidate-extraction-prompt-v2' else 'candidate-extraction-prompt-v1' end,'source',j.source,'sourceDigest',encode(j.source_digest,'hex')));
 perform set_config('app.telegram_extraction_context_claim',coalesce(prior,''),true);return r;
exception when others then perform set_config('app.telegram_extraction_context_claim',coalesce(prior,''),true);raise;
end $$;
revoke all on function app.telegram_extraction_context_claim_v2(text,boolean) from public;
create function app.telegram_extraction_claim_v1(p_token text) returns jsonb language sql volatile security definer set search_path=pg_catalog,app,pg_temp set statement_timeout='10s' as $$select app.telegram_extraction_context_claim_v2(p_token,false)$$;
create function app.telegram_extraction_claim_v2(p_token text) returns jsonb language sql volatile security definer set search_path=pg_catalog,app,pg_temp set statement_timeout='10s' as $$select app.telegram_extraction_context_claim_v2(p_token,true)$$;
revoke all on function app.telegram_extraction_claim_v1(text),app.telegram_extraction_claim_v2(text) from public;
grant execute on function app.telegram_extraction_claim_v1(text),app.telegram_extraction_claim_v2(text) to app_telegram_worker;

-- Independently fence canonical v2 source roles/digests at the SQL boundary.
-- Exact committed receipts remain replayable after source retention purges.
alter function app.telegram_extraction_complete_v1(text,uuid,uuid,text,jsonb,jsonb) rename to telegram_extraction_complete_before_context_v2;
revoke all on function app.telegram_extraction_complete_before_context_v2(text,uuid,uuid,text,jsonb,jsonb) from app_telegram_worker;
create function app.telegram_extraction_complete_v1(p_token text,p_job uuid,p_lease uuid,p_digest text,p_result jsonb,p_metadata jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp set statement_timeout='10s' as $$
declare j app.telegram_extraction_jobs;
begin
 perform app.telegram_worker_context_v1(p_token);perform app.telegram_extraction_lock_v1();select * into j from app.telegram_extraction_jobs where id=p_job for update;
 if j.schema_version='candidate-extraction-v2' and j.status<>'completed' then
 if j.source is null or jsonb_typeof(j.source->'contextOnly') is distinct from 'array' or jsonb_array_length(j.source->'contextOnly')>8 or octet_length((j.source->'contextOnly')::text)>8192 or sha256(convert_to(j.source::text,'UTF8')) is distinct from j.source_digest
 or (select count(*) from jsonb_array_elements(j.source->'contextOnly'))<>(select count(*) from app.telegram_extraction_context_dependencies where job_id=j.id)
 or exists(select 1 from jsonb_array_elements(j.source->'contextOnly') c where not exists(select 1 from app.telegram_extraction_context_dependencies d where d.job_id=j.id and d.chat_id=j.chat_id and d.message_id::text=c->>'messageId' and d.body_digest=sha256(convert_to(c::text,'UTF8'))) or j.source->'messages' @> jsonb_build_array(jsonb_build_object('messageId',c->>'messageId')))
 then raise exception 'Context source changed' using errcode='40001';end if;
 end if;
 return app.telegram_extraction_complete_before_context_v2(p_token,p_job,p_lease,p_digest,p_result,p_metadata);
end $$;
revoke all on function app.telegram_extraction_complete_v1(text,uuid,uuid,text,jsonb,jsonb) from public;
grant execute on function app.telegram_extraction_complete_v1(text,uuid,uuid,text,jsonb,jsonb) to app_telegram_worker;

alter function app.telegram_source_invalidate_batch_v1(uuid) rename to telegram_source_invalidate_before_context_v2;
create function app.telegram_source_invalidate_batch_v1(jid uuid) returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$begin
 perform app.telegram_source_invalidate_before_context_v2(jid);
 update app.telegram_extraction_jobs set source=jsonb_set(source,'{contextOnly}','[]',true) where id=jid and schema_version='candidate-extraction-v2' and source is not null and source_invalidated_at is not null and source->'contextOnly'<>'[]'::jsonb;
end $$;
revoke all on function app.telegram_source_invalidate_batch_v1(uuid) from public;
create function app.telegram_context_dependency_changed_v2() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp set lock_timeout='2s' as $$
declare jid uuid;prior_org text:=current_setting('app.organization_id',true);prior_actor text:=current_setting('app.actor_id',true);
begin
 if tg_op='UPDATE' and (old.body-'editedAt') is not distinct from (new.body-'editedAt') then return new;end if;
 -- A privileged maintenance writer may have no application scope. OLD owns
 -- the already-authorized row; restore ambient scope after this private trigger.
 perform set_config('app.organization_id',old.organization_id::text,true);perform set_config('app.actor_id',old.owner_user_id::text,true);
 perform 1 from app.telegram_history_limits where organization_id=old.organization_id and owner_user_id=old.owner_user_id for update nowait;
 perform app.telegram_extraction_lock_v1();
 if tg_op='DELETE' and old.extraction_job_id is not null and exists(select 1 from app.telegram_extraction_jobs where id=old.extraction_job_id and source_release_requested_at is null) then perform app.telegram_source_invalidate_batch_v1(old.extraction_job_id);end if;
 for jid in select j.id from app.telegram_extraction_context_dependencies d join app.telegram_extraction_jobs j on j.id=d.job_id where d.chat_id=old.chat_id and d.message_id=old.message_id and j.source is not null and j.source_invalidated_at is null and j.source_purged_at is null order by j.id for update of j loop perform app.telegram_source_invalidate_batch_v1(jid);end loop;
 perform set_config('app.organization_id',coalesce(prior_org,''),true);perform set_config('app.actor_id',coalesce(prior_actor,''),true);return new;
exception when others then perform set_config('app.organization_id',coalesce(prior_org,''),true);perform set_config('app.actor_id',coalesce(prior_actor,''),true);raise;
end $$;
revoke all on function app.telegram_context_dependency_changed_v2() from public;
create trigger telegram_context_dependency_changed after update of body on app.telegram_history_messages for each row execute function app.telegram_context_dependency_changed_v2();
create trigger telegram_context_dependency_deleted after delete on app.telegram_history_messages for each row execute function app.telegram_context_dependency_changed_v2();
reset role;set local role app_owner;revoke trigger on app.telegram_history_messages from app_executor;revoke create on schema app from app_executor;reset role;
commit;
