begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_drafts add column human_fields text[] not null default '{}';
grant trigger on app.telegram_drafts to app_executor;
create table app.telegram_extraction_jobs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, owner_user_id uuid not null, chat_id uuid not null,
 schema_version text not null default 'candidate-extraction-v1' check(schema_version='candidate-extraction-v1'),
 source jsonb not null check(jsonb_typeof(source)='object' and octet_length(source::text)<=49152),
 source_digest bytea not null check(octet_length(source_digest)=32), message_count integer not null check(message_count between 0 and 40), blocked_message_id bigint,
 status text not null default 'queued' check(status in ('queued','leased','waiting','failed','completed')),
 attempts integer not null default 0 check(attempts between 0 and 5), lease_token uuid, lease_worker_id uuid references app.telegram_workers(id), lease_expires_at timestamptz,
 available_at timestamptz not null default now(), error_code text, result_digest bytea, receipt jsonb, metadata jsonb,
 created_at timestamptz not null default now(), completed_at timestamptz, reviewed_at timestamptz,
 unique(organization_id,owner_user_id,id), foreign key(organization_id,owner_user_id,chat_id) references app.telegram_history_chats(organization_id,owner_user_id,id)
);
create unique index telegram_extraction_chat_active_idx on app.telegram_extraction_jobs(chat_id) where status<>'completed';
create index telegram_extraction_claim_idx on app.telegram_extraction_jobs(organization_id,owner_user_id,status,available_at,created_at,id);
create index telegram_extraction_list_idx on app.telegram_extraction_jobs(organization_id,owner_user_id,created_at desc,id desc);
-- Durable indexed unassigned work avoids rescanning an ever-growing processed prefix.
alter table app.telegram_history_messages add column extraction_job_id uuid references app.telegram_extraction_jobs(id);
create index telegram_extraction_unassigned_idx on app.telegram_history_messages(chat_id,message_id desc) where extraction_job_id is null;
create table app.telegram_extraction_sources (
 organization_id uuid not null, owner_user_id uuid not null, chat_id uuid not null, message_id bigint not null, job_id uuid not null,
 primary key(chat_id,message_id), foreign key(chat_id,message_id) references app.telegram_history_messages(chat_id,message_id),
 foreign key(organization_id,owner_user_id,job_id) references app.telegram_extraction_jobs(organization_id,owner_user_id,id)
);
create index telegram_extraction_sources_job_idx on app.telegram_extraction_sources(job_id);
create table app.telegram_extraction_subjects (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, owner_user_id uuid not null,
 identity_key text not null check(char_length(identity_key) between 1 and 320), draft_id uuid not null,
 reviewed_fields jsonb, unique(organization_id,owner_user_id,identity_key), unique(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id)
);
create index telegram_extraction_subject_draft_idx on app.telegram_extraction_subjects(draft_id);
create table app.telegram_extraction_proposals (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, owner_user_id uuid not null, job_id uuid not null, draft_id uuid not null,
 field text not null check(field in ('firstName','lastName','primaryEmail','secondaryEmails','headline','location','professionalUrl','professionalSummary','compensationPreference','telegramUserId','telegramUsername')),
 suggested_value jsonb not null, evidence jsonb not null check(jsonb_typeof(evidence)='array' and jsonb_array_length(evidence)<=3),
 status text not null check(status in ('pending','applied','dismissed')), created_at timestamptz not null default now(),
 unique(job_id,draft_id,field), foreign key(organization_id,owner_user_id,job_id) references app.telegram_extraction_jobs(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id)
);
create index telegram_extraction_proposals_draft_idx on app.telegram_extraction_proposals(draft_id,status,id);
create table app.telegram_extraction_attachments (
 organization_id uuid not null, owner_user_id uuid not null, job_id uuid not null, draft_id uuid not null, message_id text not null, attachment_index integer not null check(attachment_index between 0 and 15), metadata jsonb not null,
 primary key(job_id,draft_id,message_id,attachment_index),
 foreign key(organization_id,owner_user_id,job_id) references app.telegram_extraction_jobs(organization_id,owner_user_id,id),
 foreign key(organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id)
);
do $$ declare t text; begin
 foreach t in array array['telegram_extraction_jobs','telegram_extraction_sources','telegram_extraction_subjects','telegram_extraction_proposals','telegram_extraction_attachments'] loop
 execute format('alter table app.%I enable row level security',t); execute format('alter table app.%I force row level security',t);
 execute format('grant select,insert,update,delete on app.%I to app_executor',t);
 execute format('create policy telegram_extraction_owner on app.%I for all to app_executor using(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id'')) with check(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id''))',t);
 end loop;
end $$;
grant create on schema app to app_executor;
reset role;
set local role app_executor;

-- Serialize worker completions/queue creation for one private owner. Staff draft
-- edits take only draft locks; approval obtains the existing organization lock.
create function app.telegram_extraction_lock_v1() returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin
 perform 1 from app.telegram_history_limits where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') for update;
end $$;
create function app.telegram_extraction_enqueue_v1(p_chat uuid) returns boolean language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare ch app.telegram_history_chats; a app.telegram_history_accounts; m record; src jsonb; trial jsonb; jid uuid; n integer:=0;
begin
 select * into ch from app.telegram_history_chats where id=p_chat for share;
 if not found then raise exception 'Chat unavailable' using errcode='P0002'; end if;
 if exists(select 1 from app.telegram_extraction_jobs where chat_id=p_chat and status<>'completed') then return false; end if;
 select * into strict a from app.telegram_history_accounts where id=ch.account_id;
 src:=jsonb_build_object('chat',jsonb_build_object('id',ch.id,'title',ch.title,'peer',jsonb_build_object('kind',ch.peer_kind,'id',ch.peer_id),'accountUserId',a.account_user_id),'messages','[]'::jsonb);
 for m in select h.body from app.telegram_history_messages h where h.chat_id=p_chat and h.extraction_job_id is null order by h.message_id desc limit 40 loop
 trial:=jsonb_set(src,'{messages}',(src->'messages')||jsonb_build_array(m.body));
 if octet_length(trial::text)>49152 then
  if n=0 then
   insert into app.telegram_extraction_jobs(organization_id,owner_user_id,chat_id,source,source_digest,message_count,status,error_code,blocked_message_id) values(ch.organization_id,ch.owner_user_id,p_chat,src,sha256(convert_to(src::text,'UTF8')),0,'failed','INPUT_TOO_LARGE',(m.body->>'messageId')::bigint);
   return true;
  end if;
  exit;
 end if;
 src:=trial; n:=n+1;
 end loop;
 if n=0 then return false; end if;
 insert into app.telegram_extraction_jobs(organization_id,owner_user_id,chat_id,source,source_digest,message_count)
 values(ch.organization_id,ch.owner_user_id,p_chat,src,sha256(convert_to(src::text,'UTF8')),n) returning id into jid;
 insert into app.telegram_extraction_sources(organization_id,owner_user_id,chat_id,message_id,job_id)
 select ch.organization_id,ch.owner_user_id,p_chat,(value->>'messageId')::bigint,jid from jsonb_array_elements(src->'messages');
 update app.telegram_history_messages set extraction_job_id=jid where chat_id=p_chat and message_id in(select (value->>'messageId')::bigint from jsonb_array_elements(src->'messages'));
 return true;
end $$;

-- Restrict field types here as well as in the shared application validator: the
-- restricted worker role is not trusted to invent identity or source references.
create function app.telegram_extraction_value_v1(k text,v jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$ declare s text; e jsonb; begin
 if k='secondaryEmails' then
  if jsonb_typeof(v)<>'array' or jsonb_array_length(v) not between 1 and 9 then return false; end if;
  if (select count(distinct value) from jsonb_array_elements(v))<>jsonb_array_length(v) then return false; end if;
  for e in select value from jsonb_array_elements(v) loop if not app.telegram_extraction_value_v1('primaryEmail',e) then return false; end if; end loop; return true;
 end if;
 if jsonb_typeof(v) is distinct from 'string' then return false; end if; s:=v#>>'{}';
 if btrim(s)='' then return false; end if;
 if k in ('firstName','lastName') then return char_length(s)<=60 and s !~ '[[:cntrl:]]'; end if;
 if k='primaryEmail' then return char_length(s)<=254 and s=lower(btrim(s)) and s ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and s !~ '[[:cntrl:]]'; end if;
 if k in ('headline','location') then return char_length(s)<=200; end if;
 if k='professionalUrl' then return char_length(s)<=2048 and s ~ '^https?://[^[:space:]]+$'; end if;
 if k='professionalSummary' then return char_length(s)<=8000; end if;
 if k='compensationPreference' then return char_length(s)<=500; end if;
 return false;
end $$;
create function app.telegram_extraction_validate_v1(r jsonb,src jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$
declare s jsonb; f jsonb; e jsonb; m jsonb; a jsonb; ident jsonb; v jsonb;
begin
 if not coalesce(app.telegram_history_keys_v1(r,array['subjects']) and jsonb_typeof(r->'subjects')='array' and jsonb_array_length(r->'subjects')<=12,false) then return false; end if;
 if (select count(distinct value->>'key') from jsonb_array_elements(r->'subjects'))<>jsonb_array_length(r->'subjects') then return false; end if;
 for s in select value from jsonb_array_elements(r->'subjects') loop
  if not coalesce(app.telegram_history_keys_v1(s,array['key','identity','facts','attachments']) and s->>'key' ~ '^[A-Za-z0-9_-]{1,40}$' and jsonb_typeof(s->'facts')='array' and jsonb_array_length(s->'facts') between 1 and 12 and jsonb_typeof(s->'attachments')='array' and jsonb_array_length(s->'attachments')<=8,false) then return false; end if;
  if (select count(distinct value->>'field') from jsonb_array_elements(s->'facts'))<>jsonb_array_length(s->'facts') then return false; end if;
  for f in select value from jsonb_array_elements(s->'facts') loop
   if not coalesce(app.telegram_history_keys_v1(f,array['field','value','evidence']) and app.telegram_extraction_value_v1(f->>'field',f->'value') and jsonb_typeof(f->'evidence')='array' and jsonb_array_length(f->'evidence') between 1 and 3,false) then return false; end if;
   for e in select value from jsonb_array_elements(f->'evidence') loop
    select value into m from jsonb_array_elements(src->'messages') where value->>'messageId'=e->>'messageId';
    if not coalesce(app.telegram_history_keys_v1(e,array['messageId','quote']) and jsonb_typeof(e->'quote')='string' and char_length(e->>'quote') between 1 and 2000 and btrim(e->>'quote')<>'' and strpos(m->>'text',e->>'quote')>0,false) then return false; end if;
   end loop;
   if f->>'field' in ('firstName','lastName','primaryEmail','secondaryEmails') then
    for v in select value from jsonb_array_elements(case when f->>'field'='secondaryEmails' then f->'value' else jsonb_build_array(f->'value') end) loop
     if not exists(select 1 from jsonb_array_elements(f->'evidence') q where strpos(lower(q->>'quote'),lower(v#>>'{}'))>0) then return false; end if;
    end loop;
   end if;
  end loop;
  ident:=s->'identity';
  if ident='null'::jsonb then null;
  elsif ident->>'kind'='email' then
   if not coalesce(app.telegram_history_keys_v1(ident,array['kind','email']) and app.telegram_extraction_value_v1('primaryEmail',ident->'email'),false) then return false; end if;
   if not exists(select 1 from jsonb_array_elements(s->'facts') q where (q->>'field'='primaryEmail' and q->'value'=ident->'email') or (q->>'field'='secondaryEmails' and q->'value' @> jsonb_build_array(ident->'email'))) then return false; end if;
  elsif ident->>'kind'='telegram_sender' then
   select value into m from jsonb_array_elements(src->'messages') where value->>'messageId'=ident->>'messageId';
   if not coalesce(app.telegram_history_keys_v1(ident,array['kind','messageId','quote']) and char_length(ident->>'quote') between 1 and 2000 and btrim(ident->>'quote')<>'' and strpos(m->>'text',ident->>'quote')>0 and m#>>'{sender,peer,kind}'='user' and m#>>'{sender,peer,id}' ~ '^[1-9][0-9]{0,29}$' and m->'forwardedFrom'='null'::jsonb,false) then return false; end if;
  else return false; end if;
  for a in select value from jsonb_array_elements(s->'attachments') loop
   select value into m from jsonb_array_elements(src->'messages') where value->>'messageId'=a->>'messageId';
   if not coalesce(app.telegram_history_keys_v1(a,array['messageId','attachmentIndex']) and jsonb_typeof(a->'attachmentIndex')='number' and a->>'attachmentIndex' ~ '^[0-9]+$' and (a->>'attachmentIndex')::numeric between 0 and 15 and m->'attachments'->((a->>'attachmentIndex')::integer) is not null,false) then return false; end if;
  end loop;
 end loop; return true;
end $$;

create function app.telegram_extraction_claim_v1(p_token text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare w uuid; j app.telegram_extraction_jobs; begin
 w:=app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 update app.telegram_extraction_jobs set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_expires_at=null where status='leased' and lease_expires_at<=clock_timestamp() and attempts>=5;
 select * into j from app.telegram_extraction_jobs where ((status in ('queued','waiting') and available_at<=clock_timestamp()) or (status='leased' and lease_expires_at<=clock_timestamp())) and attempts<5 order by available_at,created_at,id limit 1 for update;
 if not found then return jsonb_build_object('job',null); end if;
 update app.telegram_extraction_jobs set status='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_worker_id=w,lease_expires_at=clock_timestamp()+interval '180 seconds',error_code=null where id=j.id returning * into j;
 return jsonb_build_object('job',jsonb_build_object('id',j.id,'leaseToken',j.lease_token,'leaseExpiresAt',j.lease_expires_at,'sourceDigest',encode(j.source_digest,'hex'),'schemaVersion',j.schema_version,'promptVersion','candidate-extraction-prompt-v1','source',j.source));
end $$;
create function app.telegram_extraction_source_v1(p_token text,p_job uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare src jsonb; begin
 perform app.telegram_worker_context_v1(p_token); select source into src from app.telegram_extraction_jobs where id=p_job;
 if not found then raise exception 'Job unavailable' using errcode='P0002'; end if; return src;
end $$;
create function app.telegram_extraction_complete_v1(p_token text,p_job uuid,p_lease uuid,p_source_digest text,p_result jsonb,p_metadata jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; j app.telegram_extraction_jobs; s jsonb; f jsonb; facts jsonb; e jsonb; m jsonb; a jsonb; subj app.telegram_extraction_subjects; d app.telegram_drafts;
 ident text; digest bytea; eid uuid; did uuid; ids uuid[]:='{}'; n integer:=0; next_queued boolean; current_fields jsonb; k text; val jsonb; state text; changed boolean; seen text[]:='{}';
begin
 w:=app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 select * into j from app.telegram_extraction_jobs where id=p_job for update;
 if not found then raise exception 'Job unavailable' using errcode='P0002'; end if;
 if not coalesce(app.telegram_history_keys_v1(p_metadata,array['model','promptVersion','reportedModel']) and p_metadata->>'promptVersion'='candidate-extraction-prompt-v1' and p_metadata->>'model' ~ '^[A-Za-z0-9._:/-]{1,120}$' and strpos(p_metadata->>'model','://')=0 and (p_metadata->'reportedModel'='null'::jsonb or (p_metadata->>'reportedModel' ~ '^[A-Za-z0-9._:/-]{1,120}$' and strpos(p_metadata->>'reportedModel','://')=0)),false) or octet_length(p_result::text)>150000 or not app.telegram_extraction_validate_v1(p_result,j.source) then raise exception 'Invalid extraction result' using errcode='22023'; end if;
 digest:=sha256(convert_to(jsonb_build_object('result',p_result,'metadata',p_metadata)::text,'UTF8'));
 if encode(j.source_digest,'hex') is distinct from p_source_digest then raise exception 'Source changed' using errcode='40001'; end if;
 if j.status='completed' then
  if j.result_digest=digest then return j.receipt; end if;
  raise exception 'Result changed' using errcode='40001';
 end if;
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
create function app.telegram_extraction_fail_v1(p_token text,p_job uuid,p_lease uuid,p_code text,p_delay integer) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare w uuid; j app.telegram_extraction_jobs; begin
 w:=app.telegram_worker_context_v1(p_token); perform app.telegram_extraction_lock_v1();
 if p_code not in ('PROVIDER_UNAVAILABLE','INVALID_RESULT','WORKER_ERROR') or p_delay not between 1 and 3600 then raise exception 'Invalid failure' using errcode='22023'; end if;
 select * into j from app.telegram_extraction_jobs where id=p_job for update;
 if not found then raise exception 'Job unavailable' using errcode='P0002'; end if;
 if j.lease_token=p_lease and j.lease_worker_id=w and j.status in ('waiting','failed') and j.error_code=p_code then return jsonb_build_object('ok',true); end if;
 if j.status<>'leased' or j.lease_token is distinct from p_lease or j.lease_worker_id is distinct from w or j.lease_expires_at<=clock_timestamp() then raise exception 'Lease changed' using errcode='40001'; end if;
 update app.telegram_extraction_jobs set status=case when attempts>=5 or p_code='INVALID_RESULT' then 'failed' else 'waiting' end,error_code=p_code,available_at=clock_timestamp()+make_interval(secs=>p_delay),lease_expires_at=null where id=p_job;
 return jsonb_build_object('ok',true);
end $$;

-- A before trigger gates even direct calls to the existing approval procedure.
-- It also keeps a reviewed-field receipt after that procedure clears private drafts.
create function app.telegram_extraction_decision_v1() returns trigger language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 if new.status='approved' and old.status<>'approved' then
  if exists(select 1 from app.telegram_extraction_proposals where draft_id=old.id and status='pending') then raise exception 'Resolve extraction proposals before approval' using errcode='23514'; end if;
  update app.telegram_extraction_subjects set reviewed_fields=old.fields where draft_id=old.id;
 elsif new.status='discarded' and old.status<>'discarded' then
  update app.telegram_extraction_proposals set status='dismissed' where draft_id=old.id and status='pending';
 end if;
 return new;
end $$;
create trigger telegram_extraction_decision before update of status on app.telegram_drafts for each row execute function app.telegram_extraction_decision_v1();

create or replace function app.telegram_draft_json_v1(d app.telegram_drafts)
returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('id',d.id,'version',d.version,'status',d.status,'fields',d.fields,
 'cv',case when d.document is null then null else jsonb_build_object('filename',d.document->>'filename','status','validated') end,
 'missingFields',to_jsonb(app.telegram_missing_v1(d.fields,d.document)||case when p.n>0 then array['proposals'] else '{}'::text[] end),
 'pendingProposalCount',p.n,'sourceTitle',d.source_title,'updatedAt',d.updated_at,'candidateId',d.approved_candidate_id)
 from (select count(*) n from app.telegram_extraction_proposals where draft_id=d.id and status='pending') p;
$$;
create or replace function app.telegram_update_draft_v1(p_id uuid,p_version bigint,p_fields jsonb)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare d app.telegram_drafts; locks text[]; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into d from app.telegram_drafts where id=p_id for update;
 if not found or d.version<>p_version or d.status not in ('pending','snoozed','duplicate') then raise exception 'Draft changed or is unavailable' using errcode='40001'; end if;
 select coalesce(array_agg(distinct k),'{}') into locks from (select unnest(d.human_fields) k union select key from jsonb_each(p_fields) where value is distinct from d.fields->key and not ((d.fields->key is null or d.fields->key in ('null'::jsonb,'""'::jsonb,'[]'::jsonb)) and value in ('null'::jsonb,'""'::jsonb,'[]'::jsonb))) q;
 update app.telegram_drafts set fields=p_fields,human_fields=locks,status=case when status='duplicate' then 'pending' else status end,version=version+1,updated_at=clock_timestamp() where id=p_id returning * into d;
 delete from app.telegram_draft_embeddings where draft_id=p_id;
 return app.telegram_draft_json_v1(d);
end $$;
create function app.telegram_extraction_status_v1(p_draft uuid default null,p_view text default 'all',p_after uuid default null) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
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
 select jsonb_build_object('queued',count(*) filter(where status='queued'),'leased',count(*) filter(where status='leased'),'waiting',count(*) filter(where status='waiting'),'failed',count(*) filter(where status='failed'),'completed',count(*) filter(where status='completed'),'needsReview',count(*) filter(where status='completed' and reviewed_at is null)) into counts from app.telegram_extraction_jobs;
 with q as (select j.* from app.telegram_extraction_jobs j where (p_view='all' or (status='completed' and reviewed_at is null)) and (p_after is null or (created_at,id)<(cursor_date,p_after)) order by created_at desc,id desc limit 51), n as (select *,row_number() over(order by created_at desc,id desc) rn from q)
 select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'chatId',j.chat_id,'chatTitle',j.source#>>'{chat,title}','status',j.status,'messageCount',j.message_count,'attempts',j.attempts,'errorCode',j.error_code,'availableAt',j.available_at,'createdAt',j.created_at,'completedAt',j.completed_at,'reviewedAt',j.reviewed_at,'draftIds',coalesce(j.receipt->'draftIds','[]'::jsonb)) order by j.created_at desc,j.id desc) filter(where rn<=50),'[]'),case when count(*)>50 then (array_agg(id order by created_at desc,id desc))[50] end into rows_json,next_id from n j;
 return jsonb_build_object('counts',counts,'jobs',rows_json,'nextAfter',next_id);
end $$;
create function app.telegram_extraction_action_v1(p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a text; x jsonb; n integer:=0; j app.telegram_extraction_jobs; p app.telegram_extraction_proposals; d app.telegram_drafts; f jsonb; locks text[];
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false); a:=p_input->>'action';
 if a='enqueue' then
  if jsonb_typeof(p_input->'chatIds') is distinct from 'array' or jsonb_array_length(p_input->'chatIds') not between 1 and 50 then raise exception 'Invalid selection' using errcode='22023'; end if;
  perform app.telegram_extraction_lock_v1();
  for x in select value from jsonb_array_elements(p_input->'chatIds') loop if app.telegram_extraction_enqueue_v1((x#>>'{}')::uuid) then n:=n+1; end if; end loop;
  return jsonb_build_object('queued',n);
 elsif a in ('retry','reviewBatch') then
  perform app.telegram_extraction_lock_v1(); select * into j from app.telegram_extraction_jobs where id=(p_input->>'jobId')::uuid for update;
  if not found then raise exception 'Job unavailable' using errcode='P0002'; end if;
  if a='retry' then
   if j.status<>'failed' then raise exception 'Job changed' using errcode='40001'; end if;
   if j.blocked_message_id is not null then
    -- No source row was reserved or submitted to a provider for this explicit block.
    delete from app.telegram_extraction_jobs where id=j.id; perform app.telegram_extraction_enqueue_v1(j.chat_id);
   else
    update app.telegram_extraction_jobs set status='queued',attempts=0,lease_token=null,lease_worker_id=null,lease_expires_at=null,available_at=clock_timestamp(),error_code=null where id=j.id;
   end if;
  else
   if j.status<>'completed' or exists(select 1 from app.telegram_extraction_proposals where job_id=j.id and status='pending') or exists(select 1 from app.telegram_drafts where id in(select (value#>>'{}')::uuid from jsonb_array_elements(j.receipt->'draftIds')) and status not in ('approved','discarded')) then raise exception 'Finish draft review first' using errcode='23514'; end if;
   update app.telegram_extraction_jobs set reviewed_at=coalesce(reviewed_at,clock_timestamp()) where id=j.id;
  end if; return jsonb_build_object('ok',true);
 elsif a='resolve' then
  if p_input->>'decision' not in ('apply','dismiss') then raise exception 'Invalid decision' using errcode='22023'; end if;
  select * into p from app.telegram_extraction_proposals where id=(p_input->>'proposalId')::uuid;
  if not found then raise exception 'Proposal unavailable' using errcode='P0002'; end if;
  select * into d from app.telegram_drafts where id=p.draft_id for update;
  select * into p from app.telegram_extraction_proposals where id=p.id for update;
  if p.status<>'pending' or d.version is distinct from (p_input->>'expectedDraftVersion')::bigint or (d.status in ('approved','discarded') and p_input->>'decision'='apply') then raise exception 'Draft or proposal changed' using errcode='40001'; end if;
  f:=d.fields;
  if p_input->>'decision'='apply' then f:=jsonb_set(f,array[p.field],p.suggested_value,true); end if;
  if f->>'primaryEmail'<>'' and coalesce(f->'secondaryEmails','[]') @> jsonb_build_array(f->'primaryEmail') then raise exception 'Emails must be distinct' using errcode='23514'; end if;
  select array_agg(distinct k) into locks from unnest(d.human_fields||p.field) k;
  update app.telegram_extraction_proposals set status=case p_input->>'decision' when 'apply' then 'applied' else 'dismissed' end where id=p.id;
  update app.telegram_drafts set fields=f,human_fields=locks,version=version+1,updated_at=clock_timestamp() where id=d.id returning * into d;
  delete from app.telegram_draft_embeddings where draft_id=d.id;
  return jsonb_build_object('draft',app.telegram_get_draft_v1(d.id));
 end if;
 raise exception 'Invalid extraction action' using errcode='22023';
end $$;

create or replace function app.telegram_list_drafts_v1(p_view text,p_missing text,p_query text,p_page integer)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare rows_json jsonb; counts_json jsonb; more boolean;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    if p_view not in ('ready','needs_information','snoozed','duplicates','all') or p_page not between 1 and 10000 or char_length(p_query)>200
        or (p_missing is not null and p_missing not in ('firstName','lastName','primaryEmail','cv')) then
        raise exception 'Invalid inbox filter' using errcode='22023';
    end if;
    select jsonb_build_object('ready',count(*) filter(where status='pending' and cardinality(app.telegram_missing_v1(fields,document))=0 and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=telegram_drafts.id and p.status='pending')),
        'needs_information',count(*) filter(where status='pending' and (cardinality(app.telegram_missing_v1(fields,document))>0 or exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=telegram_drafts.id and p.status='pending'))),
        'snoozed',count(*) filter(where status='snoozed'),'duplicates',count(*) filter(where status='duplicate'),
        'all',count(*) filter(where status in ('pending','snoozed','duplicate'))) into counts_json from app.telegram_drafts;
    with filtered as (
        select d.* from app.telegram_drafts d where
            case p_view when 'ready' then status='pending' and cardinality(app.telegram_missing_v1(fields,document))=0 and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending')
            when 'needs_information' then status='pending' and (cardinality(app.telegram_missing_v1(fields,document))>0 or exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending'))
            when 'snoozed' then status='snoozed' when 'duplicates' then status='duplicate' else status in ('pending','snoozed','duplicate') end
            and (p_missing is null or p_missing=any(app.telegram_missing_v1(fields,document)))
            and (coalesce(p_query,'')='' or strpos(lower(concat_ws(' ',fields->>'firstName',fields->>'lastName',fields->>'primaryEmail',fields->>'telegramUsername',source_title)),lower(p_query))>0)
        order by updated_at desc,id limit 26 offset (p_page-1)*25
    ), numbered as (select f.*,row_number() over(order by updated_at desc,id) n from filtered f)
    select coalesce(jsonb_agg(app.telegram_draft_json_v1(d) order by n.n) filter(where n.n<=25),'[]'),count(*)>25 into rows_json,more
        from numbered n join app.telegram_drafts d on d.id=n.id;
    return jsonb_build_object('drafts',rows_json,'counts',counts_json,'page',p_page,'hasMore',more);
end $$;


create function app.telegram_extraction_proposal_v1(p_id uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare p app.telegram_extraction_proposals; f jsonb; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into p from app.telegram_extraction_proposals where id=p_id; if not found then raise exception 'Proposal unavailable' using errcode='P0002'; end if;
 select fields into f from app.telegram_drafts where id=p.draft_id;
 return jsonb_build_object('fields',f,'field',p.field,'value',p.suggested_value);
end $$;

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
        result:=app.create_candidate_upload_v1(d.candidate_target_id,d.fields-array['telegramUsername','telegramUserId'],d.document,p_operation,gen_random_uuid());
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

create or replace function app.telegram_get_draft_v1(p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; result jsonb; total bigint;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into d from app.telegram_drafts where id=p_id;
 if not found then raise exception 'Draft not found' using errcode='P0002'; end if;
 select count(*) into total from app.telegram_draft_evidence where draft_id=p_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'text',e.text,'senderName',e.sender_name,'sentAt',e.sent_at) order by e.sent_at desc nulls last,e.id),'[]'::jsonb)
 into result from (select e.* from app.telegram_evidence e join app.telegram_draft_evidence x on x.evidence_id=e.id where x.draft_id=p_id order by e.sent_at desc nulls last,e.id limit 100) e;
 return app.telegram_draft_json_v1(d)||jsonb_build_object('evidence',result,'evidenceCount',total,'evidenceTruncated',total>100);
end $$;
create function app.telegram_extraction_batch_v1(p_id uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare j app.telegram_extraction_jobs; begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into j from app.telegram_extraction_jobs where id=p_id; if not found then raise exception 'Batch unavailable' using errcode='P0002'; end if;
 return jsonb_build_object('jobId',j.id,'source',j.source,'schemaVersion',j.schema_version,'metadata',j.metadata,'reviewedAt',j.reviewed_at);
end $$;

-- New definer entry points only; private helpers are never callable by runtime roles.
do $$ declare r record; begin
 for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname like 'telegram_extraction_%' loop execute format('revoke all on function %s from public',r.sig); end loop;
end $$;
grant execute on function app.telegram_extraction_batch_v1(uuid),app.telegram_extraction_proposal_v1(uuid),app.telegram_extraction_status_v1(uuid,text,uuid),app.telegram_extraction_action_v1(jsonb) to app_staff;
grant execute on function app.telegram_extraction_claim_v1(text),app.telegram_extraction_source_v1(text,uuid),app.telegram_extraction_complete_v1(text,uuid,uuid,text,jsonb,jsonb),app.telegram_extraction_fail_v1(text,uuid,uuid,text,integer) to app_telegram_worker;
reset role;
set local role app_owner;
revoke trigger on app.telegram_drafts from app_executor;
revoke create on schema app from app_executor;
commit;
