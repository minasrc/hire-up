begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_workers add column last_search_seen_at timestamptz;
create table app.profile_search_sources (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references app.organizations(id), owner_user_id uuid,
 source_type text not null check(source_type in('candidate','draft')), source_id uuid not null, revision bigint not null default 1,
 status text not null default 'queued' check(status in('queued','planning','embedding','ready','failed','retired')),
 projection_text text, source_sha256 text, manifest_sha256 text, error_code text,
 lease_token uuid, lease_worker_id uuid references app.telegram_workers(id), lease_expires_at timestamptz, lease_kind text, lease_ordinals integer[],
 attempts integer not null default 0 check(attempts between 0 and 5), available_at timestamptz not null default now(), served_at timestamptz not null default '-infinity',
 receipt_token uuid, receipt_digest bytea, receipt jsonb,
 unique(source_type,source_id), check((source_type='candidate')=(owner_user_id is null)), check(projection_text is null or octet_length(projection_text)<=65536)
);
create index profile_search_source_claim_idx on app.profile_search_sources(organization_id,owner_user_id,served_at,id) where status in('queued','planning','embedding');
create index profile_search_source_exhausted_idx on app.profile_search_sources(organization_id,lease_expires_at) where attempts>=5 and status in('queued','planning','embedding');
create index profile_search_source_retry_idx on app.profile_search_sources(organization_id,owner_user_id,id) where status='failed' and error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED');
create index profile_search_source_owner_idx on app.profile_search_sources(organization_id,owner_user_id,source_type,status);
create table app.profile_search_chunks (
 source_id uuid not null references app.profile_search_sources(id) on delete cascade, ordinal integer not null check(ordinal between 0 and 255),
 organization_id uuid not null, owner_user_id uuid, revision bigint not null, start_byte integer not null, end_byte integer not null, sha256 text not null, token_count integer not null check(token_count between 1 and 448),
 embedding real[], primary key(source_id,ordinal), check(start_byte>=0 and end_byte>start_byte and end_byte-start_byte<=16384), check(embedding is null or cardinality(embedding)=384)
);
create table app.profile_search_queries (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, owner_user_id uuid not null,
 operation_id uuid not null, request_digest bytea not null, query_text text, query_sha256 text not null, scope text not null check(scope in('approved','my_drafts','all')), ready_only boolean not null,
 status text not null default 'queued' check(status in('queued','running','completed','failed','cancelled','expired')),
 embedding real[], error_code text, attempts integer not null default 0 check(attempts between 0 and 5), lease_token uuid, lease_worker_id uuid references app.telegram_workers(id), lease_expires_at timestamptz,
 available_at timestamptz not null default now(), created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '15 minutes',
 receipt_digest bytea, receipt jsonb, coverage jsonb, corpus_revision bigint,
 unique(organization_id,owner_user_id,operation_id), check(embedding is null or cardinality(embedding)=384), check(query_text is null or octet_length(query_text)<=8000)
);
create index profile_search_query_expire_idx on app.profile_search_queries(organization_id,owner_user_id,expires_at) where status<>'expired';
create index profile_search_query_claim_idx on app.profile_search_queries(organization_id,owner_user_id,status,available_at,created_at);
create table app.profile_search_results (
 query_id uuid not null references app.profile_search_queries(id) on delete cascade, source_id uuid not null references app.profile_search_sources(id) on delete cascade,
 organization_id uuid not null, owner_user_id uuid not null, source_revision bigint not null, score double precision not null, ordinal integer not null,
 source_type text not null, public_source_id uuid not null, primary key(query_id,source_id)
);
create index profile_search_result_page_idx on app.profile_search_results(query_id,score desc,source_type,public_source_id);
create table app.profile_search_epochs (
 organization_id uuid not null, owner_user_id uuid, revision bigint not null default 1, unique nulls not distinct(organization_id,owner_user_id)
);
do $$ declare t text; begin
 foreach t in array array['profile_search_sources','profile_search_chunks','profile_search_epochs'] loop
 execute format('alter table app.%I enable row level security',t); execute format('alter table app.%I force row level security',t);
 execute format('grant select,insert,update,delete on app.%I to app_executor',t);
 execute format('create policy profile_search_scope on app.%I for all to app_executor using(organization_id=app.context_uuid_v1(''app.organization_id'') and (owner_user_id is null or owner_user_id=app.context_uuid_v1(''app.actor_id''))) with check(organization_id=app.context_uuid_v1(''app.organization_id'') and (owner_user_id is null or owner_user_id=app.context_uuid_v1(''app.actor_id'')))',t);
 end loop;
 foreach t in array array['profile_search_queries','profile_search_results'] loop
 execute format('alter table app.%I enable row level security',t); execute format('alter table app.%I force row level security',t);
 execute format('grant select,insert,update,delete on app.%I to app_executor',t);
 execute format('create policy profile_search_private on app.%I for all to app_executor using(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id'')) with check(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id''))',t);
 end loop;
end $$;
grant trigger on app.candidates,app.candidate_identifiers,app.telegram_drafts,app.telegram_extraction_proposals to app_executor;
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create function app.profile_search_versions_v1() returns jsonb language sql immutable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('indexVersion','intfloat/multilingual-e5-small@614241f622f53c4eeff9890bdc4f31cfecc418b3:e5-prefix:l2:384:v1','projectionVersion','candidate-profile-v1','chunkerVersion','e5-utf8-448-v1')
$$;
create function app.profile_search_epoch_v1(p_org uuid,p_owner uuid) returns void language sql volatile set search_path=pg_catalog,app,pg_temp as $$
 insert into app.profile_search_epochs(organization_id,owner_user_id) values(p_org,p_owner) on conflict(organization_id,owner_user_id) do update set revision=app.profile_search_epochs.revision+1
$$;
create function app.profile_search_revision_v1(p_scope text) returns bigint language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select coalesce(sum(revision),0)::bigint from app.profile_search_epochs where (p_scope<>'my_drafts' and owner_user_id is null) or (p_scope<>'approved' and owner_user_id=app.context_uuid_v1('app.actor_id'))
$$;
-- Only triggers on protected source tables call this helper. They never read a
-- public-intake candidate projection. Context is scoped to the exact written row.
create function app.profile_search_invalidate_v1(p_org uuid,p_owner uuid,p_type text,p_id uuid,p_retire boolean,p_changed boolean) returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare old_org text:=current_setting('app.organization_id',true); old_actor text:=current_setting('app.actor_id',true); sid uuid; active boolean;
begin
 perform set_config('app.organization_id',p_org::text,true); if p_owner is not null then perform set_config('app.actor_id',p_owner::text,true); end if;
 if p_retire is null then
 -- Lock the canonical row before the source row. An identifier update racing a
 -- restriction must not requeue a stale active state after waiting for its lock.
 select lifecycle='active' into active from app.candidates where id=p_id for share; p_retire:=not coalesce(active,false);
 end if;
 perform app.profile_search_epoch_v1(p_org,p_owner);
 if p_changed then
 insert into app.profile_search_sources(organization_id,owner_user_id,source_type,source_id,status) values(p_org,p_owner,p_type,p_id,case when p_retire then 'retired' else 'queued' end)
 on conflict(source_type,source_id) do update set revision=app.profile_search_sources.revision+1,status=excluded.status,projection_text=null,source_sha256=null,manifest_sha256=null,error_code=null,lease_token=null,lease_worker_id=null,lease_expires_at=null,lease_kind=null,lease_ordinals=null,receipt_token=null,receipt_digest=null,receipt=null,attempts=0,available_at=now()
 returning id into sid;
 delete from app.profile_search_chunks where source_id=sid;
 end if;
 perform set_config('app.organization_id',coalesce(old_org,''),true); perform set_config('app.actor_id',coalesce(old_actor,''),true);
end $$;
create function app.profile_search_candidate_trigger_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare n jsonb:=to_jsonb(new); o jsonb:=to_jsonb(old); keys text[]:=array['full_name','professional_summary','headline','location','compensation_preference','contact_email','professional_url','profile_contact_set','secondary_emails','lifecycle']; changed boolean;
begin
 changed:=tg_op<>'UPDATE' or exists(select 1 from unnest(keys) k where n->k is distinct from o->k);
 perform app.profile_search_invalidate_v1(coalesce(new.organization_id,old.organization_id),null,'candidate',coalesce(new.id,old.id),tg_op='DELETE' or new.lifecycle<>'active',changed);
 return coalesce(new,old);
end $$;
create trigger profile_search_candidate after insert or update or delete on app.candidates for each row execute function app.profile_search_candidate_trigger_v1();
create function app.profile_search_identifier_trigger_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 if tg_op<>'INSERT' then perform app.profile_search_invalidate_v1(old.organization_id,null,'candidate',old.candidate_id,null,true); end if;
 if tg_op<>'DELETE' and (tg_op='INSERT' or new.candidate_id is distinct from old.candidate_id or to_jsonb(new) is distinct from to_jsonb(old)) then perform app.profile_search_invalidate_v1(new.organization_id,null,'candidate',new.candidate_id,null,true); end if;
 return coalesce(new,old);
end $$;
create trigger profile_search_identifier after insert or update or delete on app.candidate_identifiers for each row execute function app.profile_search_identifier_trigger_v1();
create function app.profile_search_draft_trigger_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 perform app.profile_search_invalidate_v1(coalesce(new.organization_id,old.organization_id),coalesce(new.owner_user_id,old.owner_user_id),'draft',coalesce(new.id,old.id),tg_op='DELETE' or new.status not in('pending','snoozed','duplicate'),tg_op<>'UPDATE' or new.fields is distinct from old.fields or (new.status in('pending','snoozed','duplicate')) is distinct from (old.status in('pending','snoozed','duplicate')));
 return coalesce(new,old);
end $$;
create trigger profile_search_draft after insert or update or delete on app.telegram_drafts for each row execute function app.profile_search_draft_trigger_v1();
create function app.profile_search_proposal_trigger_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 perform app.profile_search_invalidate_v1(coalesce(new.organization_id,old.organization_id),coalesce(new.owner_user_id,old.owner_user_id),'draft',coalesce(new.draft_id,old.draft_id),false,false); return coalesce(new,old);
end $$;
create trigger profile_search_proposal after insert or update or delete on app.telegram_extraction_proposals for each row execute function app.profile_search_proposal_trigger_v1();
create function app.profile_search_profile_v1(s app.profile_search_sources) returns jsonb language plpgsql stable set search_path=pg_catalog,app,pg_temp as $$
declare c app.candidates; d app.telegram_drafts; f jsonb; missing text[]; ids jsonb;
begin
 if s.source_type='candidate' then
 select * into c from app.candidates where id=s.source_id and lifecycle='active'; if not found then return null; end if;
 select coalesce(jsonb_agg(normalized_value order by normalized_value),'[]') into ids from app.candidate_identifiers where candidate_id=c.id and ((kind='provider_subject' and normalized_value like 'telegram:user:%') or (kind='professional_url' and normalized_value like 'https://t.me/%'));
 f:=jsonb_build_object('fullName',c.full_name,'headline',c.headline,'location',c.location,'compensationPreference',c.compensation_preference,'professionalSummary',c.professional_summary,'primaryEmail',app.candidate_contact_v1(c,'email'),'secondaryEmails',to_jsonb(c.secondary_emails),'professionalUrl',app.candidate_contact_v1(c,'professional_url'),'telegramIdentifiers',ids);
 return jsonb_build_object('fields',f,'displayName',c.full_name,'headline',c.headline,'location',c.location,'hasCv',c.current_document_id is not null,'missingFields','[]'::jsonb,'ready',true);
 end if;
 select * into d from app.telegram_drafts where id=s.source_id and status in('pending','snoozed','duplicate'); if not found then return null; end if;
 f:=d.fields||jsonb_build_object('fullName',trim(concat_ws(' ',d.fields->>'firstName',d.fields->>'lastName')));
 missing:=app.telegram_missing_v1(d.fields,d.document); if exists(select 1 from app.telegram_extraction_proposals where draft_id=d.id and status='pending') then missing:=array_append(missing,'proposals'); end if;
 return jsonb_build_object('fields',f,'displayName',coalesce(nullif(f->>'fullName',''),'Unnamed draft'),'headline',f->>'headline','location',f->>'location','hasCv',d.document is not null,'missingFields',to_jsonb(missing),'ready',cardinality(missing)=0);
end $$;
create function app.profile_search_text_v1(f jsonb) returns text language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$
declare k text; label text; value text; output text:='';
begin
 for k,label in select * from (values('fullName','Name'),('headline','Headline'),('location','Location'),('compensationPreference','Compensation preference'),('professionalSummary','Professional summary'),('primaryEmail','Primary email'),('secondaryEmails','Secondary emails'),('professionalUrl','Professional URL'),('telegramUsername','Telegram username'),('telegramUserId','Telegram user ID'),('telegramIdentifiers','Telegram identifiers')) a(k,label) loop
 if jsonb_typeof(f->k)='array' then select string_agg(v,', ' order by v) into value from jsonb_array_elements_text(f->k) v; else value:=f->>k; end if;
 value:=trim(regexp_replace(coalesce(value,''),'[[:space:]]+',' ','g'));
 if value<>'' then output:=output||case when output='' then '' else E'\n' end||label||': '||value; end if;
 end loop;
 return case when output='' then 'Profile: No information supplied' else output end;
end $$;
create function app.profile_search_eligible_v1(p_scope text,p_ready boolean) returns setof app.profile_search_sources language sql stable as $$
 select s.* from app.profile_search_sources s where s.status<>'retired' and ((s.source_type='candidate' and p_scope<>'my_drafts') or (s.source_type='draft' and p_scope<>'approved' and exists(select 1 from app.telegram_drafts d where d.id=s.source_id and d.status in('pending','snoozed','duplicate') and (not p_ready or (cardinality(app.telegram_missing_v1(d.fields,d.document))=0 and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending'))))))
$$;
create function app.profile_search_coverage_v1(p_scope text,p_ready boolean) returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('eligible',count(*),'indexed',count(*) filter(where status='ready'),'pending',count(*) filter(where status in('queued','planning','embedding')),'failed',count(*) filter(where status='failed'),'retryable',count(*) filter(where status='failed' and error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED')),'corpusChanged',false) from app.profile_search_eligible_v1(p_scope,p_ready)
$$;
create function app.profile_search_expire_v1() returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin
 with expired as(update app.profile_search_queries set status='expired',query_text=null,embedding=null,receipt=null,receipt_digest=null,lease_token=null where expires_at<=now() and status<>'expired' returning id)
 delete from app.profile_search_results r using expired q where r.query_id=q.id;
end $$;
create function app.profile_search_action_v1(p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare q app.profile_search_queries; digest bytea; org uuid:=app.context_uuid_v1('app.organization_id'); actor uuid:=app.context_uuid_v1('app.actor_id'); retried integer:=0; remaining integer; source app.profile_search_sources;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 -- Owner row serializes replacement and idempotent submission, without an org UPDATE lock.
 perform 1 from app.organization_memberships where organization_id=org and user_id=actor for update;
 perform app.profile_search_expire_v1();
 if p->>'action'='retryIndex' then
 if coalesce(p->>'scope','') not in('approved','my_drafts','all') or jsonb_typeof(p->'readyOnly') is distinct from 'boolean' then raise exception 'Invalid retry scope' using errcode='22023'; end if;
 -- Select the current eligible revision under its source lock; partial manifest
 -- and vectors are durable and need not be regenerated after a temporary outage.
 for source in select s.* from app.profile_search_sources s where s.status='failed' and s.error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED') and s.id in(select e.id from app.profile_search_eligible_v1(p->>'scope',(p->>'readyOnly')::boolean)e) order by s.id for update skip locked limit 100 loop
 update app.profile_search_sources set status=case when manifest_sha256 is null then 'queued' else 'embedding' end,attempts=0,error_code=null,lease_token=null,lease_worker_id=null,lease_expires_at=null,lease_kind=null,lease_ordinals=null,receipt_token=null,receipt_digest=null,receipt=null,available_at=now(),served_at=now() where id=source.id;
 perform app.profile_search_epoch_v1(source.organization_id,source.owner_user_id); retried:=retried+1;
 end loop;
 select count(*) into remaining from app.profile_search_eligible_v1(p->>'scope',(p->>'readyOnly')::boolean) where status='failed' and error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED');
 return jsonb_build_object('ok',true,'retried',retried,'remainingFailed',remaining);
 end if;
 if p->>'action'='cancel' then
 select * into q from app.profile_search_queries where id=(p->>'queryId')::uuid for update; if not found then raise exception 'Query unavailable' using errcode='P0002'; end if;
 update app.profile_search_queries set status='cancelled',embedding=null,lease_token=null where id=q.id and status in('queued','running'); return jsonb_build_object('ok',true);
 end if;
 if p->>'action'<>'search' or coalesce(p->>'scope','') not in('approved','my_drafts','all') or char_length(trim(p->>'query')) not between 1 and 2000 or octet_length(p->>'query')>8000 or jsonb_typeof(p->'readyOnly')<>'boolean' then raise exception 'Invalid search' using errcode='22023'; end if;
 digest:=sha256(convert_to(p::text,'UTF8'));
 select * into q from app.profile_search_queries where operation_id=(p->>'operationId')::uuid;
 if found then if q.request_digest<>digest then raise exception 'Operation changed' using errcode='40001'; end if; return jsonb_build_object('queryId',q.id,'status',q.status,'expiresAt',q.expires_at); end if;
 update app.profile_search_queries set status='cancelled',embedding=null,lease_token=null where status in('queued','running');
 insert into app.profile_search_queries(organization_id,owner_user_id,operation_id,request_digest,query_text,query_sha256,scope,ready_only) values(org,actor,(p->>'operationId')::uuid,digest,p->>'query',encode(sha256(convert_to(p->>'query','UTF8')),'hex'),p->>'scope',(p->>'readyOnly')::boolean) returning * into q;
 return jsonb_build_object('queryId',q.id,'status',q.status,'expiresAt',q.expires_at);
end $$;
create function app.profile_search_status_v1(p_scope text,p_ready boolean,p_query uuid,p_after jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare q app.profile_search_queries; available boolean; records jsonb; cv jsonb; cursor jsonb; n integer;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_scope not in('approved','my_drafts','all') then raise exception 'Invalid scope' using errcode='22023'; end if;
 perform app.profile_search_expire_v1();
 select exists(select 1 from app.telegram_workers where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and revoked_at is null and expires_at>now() and last_search_seen_at>now()-interval '90 seconds') into available;
 if p_query is null then return app.profile_search_versions_v1()||jsonb_build_object('coverage',app.profile_search_coverage_v1(p_scope,p_ready),'workerAvailable',available); end if;
 select * into q from app.profile_search_queries where id=p_query; if not found then raise exception 'Query unavailable' using errcode='P0002'; end if;
 cv:=coalesce(q.coverage,app.profile_search_coverage_v1(q.scope,q.ready_only));
 cv:=cv||jsonb_build_object('corpusChanged',q.corpus_revision is not null and q.corpus_revision<>app.profile_search_revision_v1(q.scope),'retryable',(select count(*) from app.profile_search_eligible_v1(q.scope,q.ready_only) where status='failed' and error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED')));
 records:='[]'; cursor:=null;
 if q.status='completed' then
 -- Paginate ranks before reading contact identifiers or constructing profile
 -- DTOs. Evaluating a full projection before LIMIT scales with the whole corpus.
 with page as materialized (
 select r.*,s as source from app.profile_search_results r join app.profile_search_sources s on s.id=r.source_id and s.revision=r.source_revision and s.status='ready'
 where r.query_id=q.id and (s.source_type='candidate' or exists(select 1 from app.telegram_drafts d where d.id=s.source_id and d.status in('pending','snoozed','duplicate') and (not q.ready_only or (cardinality(app.telegram_missing_v1(d.fields,d.document))=0 and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending')))))
 and (p_after is null or r.score<(p_after->>'score')::double precision or (r.score=(p_after->>'score')::double precision and (r.source_type,r.public_source_id)>(p_after->>'sourceType',(p_after->>'sourceId')::uuid))) order by r.score desc,r.source_type,r.public_source_id limit 26
 ), profiles as materialized(select page.*,app.profile_search_profile_v1(page.source) profile from page)
 select coalesce(jsonb_agg(jsonb_build_object('sourceType',p.source_type,'sourceId',p.public_source_id,'sourceRevision',p.source_revision,'displayName',p.profile->>'displayName','headline',p.profile->>'headline','location',p.profile->>'location','hasCv',p.profile->'hasCv','missingFields',p.profile->'missingFields','score',p.score,'matchedText',left(convert_from(substring(convert_to((p.source).projection_text,'UTF8') from ch.start_byte+1 for ch.end_byte-ch.start_byte),'UTF8'),500),'href',case when p.source_type='candidate' then '/staff/candidates/'||p.public_source_id else '/staff/telegram-intake?draft='||p.public_source_id end) order by p.score desc,p.source_type,p.public_source_id),'[]'),count(*) into records,n
 from profiles p join app.profile_search_chunks ch on ch.source_id=p.source_id and ch.ordinal=p.ordinal where p.profile is not null;
 if n>25 then records:=records-25; cursor:=jsonb_build_object('queryId',q.id,'score',records->24->'score','sourceType',records->24->>'sourceType','sourceId',records->24->>'sourceId'); end if;
 end if;
 return jsonb_build_object('queryId',q.id,'query',q.query_text,'scope',q.scope,'readyOnly',q.ready_only,'status',q.status,'results',records,'nextAfter',cursor,'coverage',cv,'workerAvailable',available,'errorCode',q.error_code,'expiresAt',q.expires_at);
end $$;
create function app.profile_search_worker_claim_v1(p_token text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; q app.profile_search_queries; s app.profile_search_sources; profile jsonb; txt text; chunks jsonb; body jsonb; attempt integer;
begin
 w:=app.telegram_worker_context_v1(p_token); update app.telegram_workers set last_search_seen_at=now() where id=w;
 perform app.profile_search_expire_v1();
 update app.profile_search_queries set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_token=null where status in('queued','running') and attempts>=5 and (lease_expires_at is null or lease_expires_at<=now());
 select * into q from app.profile_search_queries where status in('queued','running') and available_at<=now() and expires_at>now() and (lease_expires_at is null or lease_expires_at<=now() or lease_worker_id=w) order by created_at,id for update skip locked limit 1;
 if found then
 if q.lease_token is null or q.lease_expires_at<=now() then q.lease_token:=gen_random_uuid(); q.attempts:=q.attempts+1; end if;
 update app.profile_search_queries set status='running',lease_token=q.lease_token,lease_worker_id=w,lease_expires_at=now()+interval '120 seconds',attempts=q.attempts where id=q.id returning * into q;
 return jsonb_build_object('job',app.profile_search_versions_v1()||jsonb_build_object('id',q.id,'kind','query','leaseToken',q.lease_token,'leaseExpiresAt',q.lease_expires_at,'query',q.query_text,'querySha256',q.query_sha256));
 end if;
 update app.profile_search_sources set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_token=null where status in('queued','planning','embedding') and attempts>=5 and (lease_expires_at is null or lease_expires_at<=now());
 -- Bounded scan handles retired/missing legacy rows without holding an unbounded transaction.
 for attempt in 1..16 loop
 with shared as materialized(select id,served_at from app.profile_search_sources where owner_user_id is null and status in('queued','planning','embedding') and available_at<=now() and (lease_expires_at is null or lease_expires_at<=now() or lease_worker_id=w) order by served_at,id for update skip locked limit 1),
 mine as materialized(select id,served_at from app.profile_search_sources where owner_user_id=app.context_uuid_v1('app.actor_id') and status in('queued','planning','embedding') and available_at<=now() and (lease_expires_at is null or lease_expires_at<=now() or lease_worker_id=w) order by served_at,id for update skip locked limit 1),
 picks as(select * from shared union all select * from mine)
 select source.* into s from app.profile_search_sources source join picks on picks.id=source.id order by picks.served_at,picks.id limit 1;
 if not found then return jsonb_build_object('job',null); end if;
 profile:=app.profile_search_profile_v1(s);
 if profile is null then update app.profile_search_sources set status='retired',projection_text=null,lease_token=null where id=s.id; delete from app.profile_search_chunks where source_id=s.id; continue; end if;
 if s.projection_text is null then
 txt:=app.profile_search_text_v1(profile->'fields');
 if octet_length(txt)>65536 then update app.profile_search_sources set status='failed',error_code='SOURCE_TOO_LARGE' where id=s.id; perform app.profile_search_epoch_v1(s.organization_id,s.owner_user_id); continue; end if;
 update app.profile_search_sources set projection_text=txt,source_sha256=encode(sha256(convert_to(txt,'UTF8')),'hex') where id=s.id returning * into s;
 end if;
 if s.lease_token is null or s.lease_expires_at<=now() then
 s.lease_token:=gen_random_uuid(); s.attempts:=s.attempts+1; s.lease_kind:=case when s.manifest_sha256 is null then 'plan' else 'embed' end;
 select array_agg(ordinal order by ordinal) into s.lease_ordinals from(select ordinal from app.profile_search_chunks where source_id=s.id and embedding is null order by ordinal limit 8)c;
 end if;
 update app.profile_search_sources set status=case when s.lease_kind='plan' then 'planning' else 'embedding' end,lease_kind=s.lease_kind,lease_ordinals=s.lease_ordinals,lease_token=s.lease_token,lease_worker_id=w,lease_expires_at=now()+interval '120 seconds',attempts=s.attempts,served_at=now() where id=s.id returning * into s;
 body:=app.profile_search_versions_v1()||jsonb_build_object('id',s.id,'kind',s.lease_kind,'leaseToken',s.lease_token,'leaseExpiresAt',s.lease_expires_at,'source',jsonb_build_object('sourceType',s.source_type,'sourceId',s.source_id,'revision',s.revision,'sha256',s.source_sha256));
 if s.lease_kind='plan' then body:=jsonb_set(body,'{source,text}',to_jsonb(s.projection_text));
 else
 select jsonb_agg(jsonb_build_object('ordinal',ordinal,'startByte',start_byte,'endByte',end_byte,'sha256',sha256,'text',convert_from(substring(convert_to(s.projection_text,'UTF8') from start_byte+1 for end_byte-start_byte),'UTF8')) order by ordinal) into chunks from app.profile_search_chunks where source_id=s.id and ordinal=any(s.lease_ordinals);
 body:=body||jsonb_build_object('manifestSha256',s.manifest_sha256,'chunks',chunks);
 end if;
 return jsonb_build_object('job',body);
 end loop;
 return jsonb_build_object('job',null);
end $$;
create function app.profile_search_vector_v1(p jsonb) returns real[] language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$
declare v real[]; norm double precision;
begin
 if jsonb_typeof(p)<>'array' or jsonb_array_length(p)<>384 or exists(select 1 from jsonb_array_elements(p)e where jsonb_typeof(e)<>'number') then raise exception 'Invalid vector' using errcode='22023'; end if;
 select array_agg(value::real),sum((value::double precision)*(value::double precision)) into v,norm from jsonb_array_elements_text(p);
 if norm not between 0.98 and 1.02 then raise exception 'Vector is not normalized' using errcode='22023'; end if; return v;
end $$;
-- This read is solely for the host's independent UTF-8 manifest validation.
create function app.profile_search_worker_source_v1(p_token text,p_id uuid,p_revision bigint,p_sha text) returns text language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare txt text; begin
 perform app.telegram_worker_context_v1(p_token);
 select projection_text into txt from app.profile_search_sources where id=p_id and revision=p_revision and source_sha256=p_sha and status<>'retired'; if not found then raise exception 'Source changed' using errcode='40001'; end if; return txt;
end $$;
create function app.profile_search_worker_complete_v1(p_token text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; s app.profile_search_sources; q app.profile_search_queries; digest bytea; chunk jsonb; n integer:=0; boundary integer:=0; bytes bytea; piece bytea; text_piece text; manifest text; ordinals integer[]; v_receipt jsonb; versions jsonb:=app.profile_search_versions_v1();
begin
 w:=app.telegram_worker_context_v1(p_token); update app.telegram_workers set last_search_seen_at=now() where id=w;
 if octet_length(p::text)>300000 or p->>'indexVersion' is distinct from versions->>'indexVersion' or p->>'projectionVersion' is distinct from versions->>'projectionVersion' or p->>'chunkerVersion' is distinct from versions->>'chunkerVersion' then raise exception 'Invalid version' using errcode='22023'; end if;
 digest:=sha256(convert_to((p-'leaseToken')::text,'UTF8'));
 if p->>'kind'='query' then
 select * into q from app.profile_search_queries where id=(p->>'jobId')::uuid for update;
 if not found then raise exception 'Query unavailable' using errcode='P0002'; end if;
 if q.expires_at<=now() or q.status in('cancelled','expired') then raise exception 'Query expired' using errcode='40001'; end if;
 if q.receipt_digest=digest and q.receipt is not null then return q.receipt; end if;
 if q.status<>'running' or q.lease_token is distinct from (p->>'leaseToken')::uuid or q.lease_worker_id<>w or q.lease_expires_at<=now() or q.query_sha256 is distinct from p->>'querySha256' then raise exception 'Query changed' using errcode='40001'; end if;
 update app.profile_search_queries set embedding=app.profile_search_vector_v1(p#>'{result,embedding}'),receipt_digest=digest where id=q.id;
 return jsonb_build_object('ok',true,'status','scoring');
 end if;
 if p->>'kind' not in('plan','embed') then raise exception 'Invalid kind' using errcode='22023'; end if;
 select * into s from app.profile_search_sources where id=(p->>'jobId')::uuid for update;
 if not found then raise exception 'Source unavailable' using errcode='P0002'; end if;
 if s.revision is distinct from (p->>'sourceRevision')::bigint or s.source_sha256 is distinct from p->>'sourceSha256' or s.status='retired' then raise exception 'Source changed' using errcode='40001'; end if;
 if s.receipt_digest=digest and s.receipt_token=(p->>'leaseToken')::uuid then return s.receipt; end if;
 if s.lease_token is distinct from (p->>'leaseToken')::uuid or s.lease_worker_id<>w or s.lease_expires_at<=now() or s.lease_kind is distinct from p->>'kind' then raise exception 'Lease changed' using errcode='40001'; end if;
 if p->>'kind'='plan' then
 if jsonb_typeof(p#>'{result,chunks}')<>'array' or jsonb_array_length(p#>'{result,chunks}') not between 1 and 256 or (p#>>'{result,byteLength}')::integer<>octet_length(s.projection_text) then raise exception 'Invalid manifest' using errcode='22023'; end if;
 bytes:=convert_to(s.projection_text,'UTF8');
 for chunk in select value from jsonb_array_elements(p#>'{result,chunks}') loop
 if (chunk->>'ordinal')::integer<>n or (chunk->>'startByte')::integer<>boundary or (chunk->>'endByte')::integer<=boundary or (chunk->>'endByte')::integer-boundary>16384 or (chunk->>'tokenCount')::integer not between 1 and 448 then raise exception 'Invalid chunk bounds' using errcode='22023'; end if;
 piece:=substring(bytes from boundary+1 for (chunk->>'endByte')::integer-boundary); text_piece:=convert_from(piece,'UTF8');
 if char_length(text_piece)>16000 or encode(sha256(piece),'hex') is distinct from chunk->>'sha256' then raise exception 'Invalid chunk hash' using errcode='22023'; end if;
 insert into app.profile_search_chunks(source_id,ordinal,organization_id,owner_user_id,revision,start_byte,end_byte,sha256,token_count) values(s.id,n,s.organization_id,s.owner_user_id,s.revision,boundary,(chunk->>'endByte')::integer,chunk->>'sha256',(chunk->>'tokenCount')::integer);
 boundary:=(chunk->>'endByte')::integer; n:=n+1;
 end loop;
 if boundary<>octet_length(bytes) then raise exception 'Incomplete source coverage' using errcode='22023'; end if;
 manifest:=encode(sha256(convert_to((p->'result')::text,'UTF8')),'hex');
 v_receipt:=jsonb_build_object('ok',true,'status','embedding','manifestSha256',manifest);
 update app.profile_search_sources set status='embedding',error_code=null,manifest_sha256=manifest,attempts=0,lease_token=null,lease_expires_at=null,receipt_token=(p->>'leaseToken')::uuid,receipt_digest=digest,receipt=v_receipt,available_at=now() where id=s.id;
 else
 if s.manifest_sha256 is distinct from p->>'manifestSha256' or jsonb_typeof(p#>'{result,embeddings}')<>'array' or jsonb_array_length(p#>'{result,embeddings}') not between 1 and 8 then raise exception 'Invalid embedding batch' using errcode='22023'; end if;
 select array_agg((value->>'ordinal')::integer order by (value->>'ordinal')::integer) into ordinals from jsonb_array_elements(p#>'{result,embeddings}');
 if ordinals is distinct from s.lease_ordinals then raise exception 'Embedding batch changed' using errcode='40001'; end if;
 for chunk in select value from jsonb_array_elements(p#>'{result,embeddings}') loop update app.profile_search_chunks set embedding=app.profile_search_vector_v1(chunk->'embedding') where source_id=s.id and ordinal=(chunk->>'ordinal')::integer and revision=s.revision; end loop;
 v_receipt:=jsonb_build_object('ok',true,'status',case when exists(select 1 from app.profile_search_chunks where source_id=s.id and embedding is null) then 'embedding' else 'ready' end);
 update app.profile_search_sources set status=v_receipt->>'status',error_code=null,attempts=0,lease_token=null,lease_expires_at=null,receipt_token=(p->>'leaseToken')::uuid,receipt_digest=digest,receipt=v_receipt,available_at=now() where id=s.id;
 if v_receipt->>'status'='ready' then perform app.profile_search_epoch_v1(s.organization_id,s.owner_user_id); end if;
 end if;
 return v_receipt;
end $$;
-- Exact cosine ranking across all current, authorized, ready profiles. A host
-- statement deadline rolls this transaction back before marking SEARCH_TIMEOUT.
create function app.profile_search_score_v1(p_token text,p_id uuid,p_lease uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; q app.profile_search_queries; v_receipt jsonb;
begin
 w:=app.telegram_worker_context_v1(p_token);
 select * into q from app.profile_search_queries where id=p_id for update;
 if not found then raise exception 'Query unavailable' using errcode='P0002'; end if;
 if q.expires_at<=now() or q.status in('cancelled','expired') then raise exception 'Query expired' using errcode='40001'; end if;
 if q.receipt is not null and q.status in('completed','failed') then return q.receipt; end if;
 if q.status<>'running' or q.embedding is null or q.lease_token is distinct from p_lease or q.lease_worker_id<>w or q.lease_expires_at<=now() then raise exception 'Query changed' using errcode='40001'; end if;
 select app.profile_search_coverage_v1(q.scope,q.ready_only),app.profile_search_revision_v1(q.scope) into q.coverage,q.corpus_revision;
 insert into app.profile_search_results(query_id,source_id,organization_id,owner_user_id,source_revision,score,ordinal,source_type,public_source_id)
 select q.id,ranked.id,q.organization_id,q.owner_user_id,ranked.revision,ranked.score,ranked.ordinal,ranked.source_type,ranked.source_id from (
 select distinct on(s.id) s.id,s.revision,s.source_type,s.source_id,ch.ordinal,dot.score
 from app.profile_search_eligible_v1(q.scope,q.ready_only) s join app.profile_search_chunks ch on ch.source_id=s.id and ch.revision=s.revision
 cross join lateral(select sum(x::double precision*y::double precision) score from unnest(ch.embedding,q.embedding) v(x,y)) dot
 where s.status='ready' and ch.embedding is not null order by s.id,dot.score desc,ch.ordinal) ranked;
 v_receipt:=jsonb_build_object('ok',true,'status','completed');
 update app.profile_search_queries set status='completed',error_code=null,coverage=q.coverage,corpus_revision=q.corpus_revision,receipt=v_receipt,lease_token=null where id=q.id;
 return v_receipt;
end $$;
create function app.profile_search_timeout_v1(p_token text,p_id uuid,p_lease uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; q app.profile_search_queries; v_receipt jsonb:=jsonb_build_object('ok',true,'status','failed','errorCode','SEARCH_TIMEOUT');
begin
 w:=app.telegram_worker_context_v1(p_token); select * into q from app.profile_search_queries where id=p_id for update;
 if not found or q.status<>'running' or q.lease_token is distinct from p_lease or q.lease_worker_id<>w then raise exception 'Query changed' using errcode='40001'; end if;
 update app.profile_search_queries set status='failed',error_code='SEARCH_TIMEOUT',receipt=v_receipt,embedding=null,lease_token=null where id=q.id; return v_receipt;
end $$;
create function app.profile_search_worker_fail_v1(p_token text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; s app.profile_search_sources; q app.profile_search_queries; terminal boolean; delay integer:=(p->>'retryAfterSeconds')::integer; code text:=p->>'code';
begin
 w:=app.telegram_worker_context_v1(p_token); update app.telegram_workers set last_search_seen_at=now() where id=w;
 if code not in('EMBEDDING_UNAVAILABLE','INVALID_RESULT','INPUT_TOO_LONG','WORKER_ERROR') or delay not between 1 and 3600 then raise exception 'Invalid failure' using errcode='22023'; end if;
 terminal:=code in('INVALID_RESULT','INPUT_TOO_LONG');
 if p->>'kind'='query' then
 select * into q from app.profile_search_queries where id=(p->>'jobId')::uuid for update;
 if not found or q.status<>'running' or q.lease_token is distinct from (p->>'leaseToken')::uuid or q.lease_worker_id<>w or q.lease_expires_at<=now() or q.expires_at<=now() then raise exception 'Query changed' using errcode='40001'; end if;
 terminal:=terminal or q.attempts>=5;
 update app.profile_search_queries set status=case when terminal then 'failed' else 'queued' end,error_code=code,lease_token=null,lease_expires_at=null,available_at=now()+make_interval(secs=>delay) where id=q.id;
 else
 select * into s from app.profile_search_sources where id=(p->>'jobId')::uuid for update;
 if not found or s.lease_kind is distinct from p->>'kind' or s.lease_token is distinct from (p->>'leaseToken')::uuid or s.lease_worker_id<>w or s.lease_expires_at<=now() then raise exception 'Source changed' using errcode='40001'; end if;
 terminal:=terminal or s.attempts>=5;
 update app.profile_search_sources set status=case when terminal then 'failed' when manifest_sha256 is null then 'queued' else 'embedding' end,error_code=code,lease_token=null,lease_expires_at=null,available_at=now()+make_interval(secs=>delay) where id=s.id;
 perform app.profile_search_epoch_v1(s.organization_id,s.owner_user_id);
 end if;
 return jsonb_build_object('ok',true);
end $$;
-- No helpers are callable by runtime roles, including trigger context helpers.
do $$ declare p record; begin
 for p in select oid::regprocedure name from pg_proc where pronamespace='app'::regnamespace and proname like 'profile_search_%' loop execute format('revoke all on function %s from public',p.name); end loop;
end $$;
grant execute on function app.profile_search_action_v1(jsonb),app.profile_search_status_v1(text,boolean,uuid,jsonb) to app_staff;
grant execute on function app.profile_search_worker_claim_v1(text),app.profile_search_worker_complete_v1(text,jsonb),app.profile_search_worker_fail_v1(text,jsonb),app.profile_search_worker_source_v1(text,uuid,bigint,text),app.profile_search_score_v1(text,uuid,uuid),app.profile_search_timeout_v1(text,uuid,uuid) to app_telegram_worker;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
revoke trigger on app.candidates,app.candidate_identifiers,app.telegram_drafts,app.telegram_extraction_proposals from app_executor;
reset role;
-- Migration operator is required to bypass RLS. Queue existing profiles without
-- reading or copying their text; normal authorized worker claims build it later.
insert into app.profile_search_sources(organization_id,source_type,source_id,status) select organization_id,'candidate',id,'queued' from app.candidates where lifecycle='active' on conflict do nothing;
insert into app.profile_search_sources(organization_id,owner_user_id,source_type,source_id,status) select organization_id,owner_user_id,'draft',id,'queued' from app.telegram_drafts where status in('pending','snoozed','duplicate') on conflict do nothing;
commit;
