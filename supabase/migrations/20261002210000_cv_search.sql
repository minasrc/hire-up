begin;
set local lock_timeout='2s';set local statement_timeout='30s';set local role app_owner;
alter table app.profile_search_sources add column component text not null default 'profile' check(component in('profile','cv')),
 add column reviewed_text_id uuid,add column document_id uuid,add column document_sha256 text,
 add constraint profile_cv_candidate_only check(component='profile' or (source_type='candidate' and owner_user_id is null));
alter table app.profile_search_sources drop constraint profile_search_sources_source_type_source_id_key;
alter table app.profile_search_sources add unique(source_type,source_id,component);
alter table app.profile_search_chunks add column component text not null default 'profile' check(component in('profile','cv'));
alter table app.profile_search_results add column start_byte integer,add column end_byte integer,add constraint cv_search_result_bounds check((start_byte is null and end_byte is null) or (start_byte>=0 and end_byte>start_byte and end_byte-start_byte<=16384));
alter table app.profile_search_queries add column include_cv boolean not null default false,add column cv_safety_revision bigint,add column cv_growth_revision bigint,add column capacity jsonb;
create table app.cv_search_epochs(organization_id uuid primary key references app.organizations(id),safety_revision bigint not null default 0,growth_revision bigint not null default 0);
alter table app.cv_search_epochs enable row level security;alter table app.cv_search_epochs force row level security;
grant select,insert,update on app.cv_search_epochs to app_executor;
create policy cv_search_epoch_scope on app.cv_search_epochs for all to app_executor using(organization_id=app.context_uuid_v1('app.organization_id')) with check(organization_id=app.context_uuid_v1('app.organization_id'));
create index cv_search_component_claim on app.profile_search_sources(organization_id,component,owner_user_id,served_at,id) where status in('queued','planning','embedding');
create index cv_search_document on app.profile_search_sources(document_id) where component='cv';
grant update(candidate_id) on app.candidate_reviewed_cv_text to app_executor;
create policy cv_reviewed_merge_read on app.candidate_reviewed_cv_text for select to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and (pg_trigger_depth()>0 or app.has_permission_v1('candidates.merge')));
create policy cv_reviewed_merge_update on app.candidate_reviewed_cv_text for update to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and app.has_permission_v1('candidates.merge')) with check(organization_id=app.context_uuid_v1('app.organization_id') and app.has_permission_v1('candidates.merge'));
create policy cv_search_candidate_trigger_read on app.candidates for select to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and pg_trigger_depth()>0);
create policy cv_search_document_read on app.documents for select to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and (pg_trigger_depth()>0 or app.has_permission_v1('documents.download') and app.has_permission_v1('candidates.read')));
create policy cv_search_blob_read on app.file_blobs for select to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and (pg_trigger_depth()>0 or app.has_permission_v1('documents.download') and app.has_permission_v1('candidates.read')));
grant trigger on app.candidates,app.documents,app.file_blobs,app.candidate_reviewed_cv_text,app.profile_search_chunks to app_executor;
grant create on schema app to app_executor;reset role;set local role app_executor;
create or replace function app.profile_search_versions_v1() returns jsonb language sql immutable set search_path=pg_catalog,app,pg_temp as $$ select jsonb_build_object('indexVersion','sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2@e8f8c211226b894fcb81acc59f3b34ba3efd5f42:mean-pool:l2:384:v1','projectionVersion','candidate-profile-v1','chunkerVersion','minilm-utf8-128-v1') $$;
create function app.cv_search_limit_v1() returns integer language sql immutable as $$ select 100000 $$; -- PROVISIONAL: root concurrent benchmark must approve before release.
create function app.cv_search_mode_v1() returns boolean language sql stable as $$ select coalesce(current_setting('app.cv_search_mode',true),'')='on' $$;
create function app.cv_search_binding_v1(p_candidate uuid,p_reviewed uuid,p_document uuid,p_sha text) returns boolean language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select exists(select 1 from app.candidate_reviewed_cv_text r join app.candidates c on c.id=r.candidate_id join app.documents d on d.id=r.document_id join app.file_blobs b on b.id=d.blob_id where r.id=p_reviewed and c.id=p_candidate and c.current_document_id=d.id and d.id=p_document and c.lifecycle='active' and d.lifecycle='active' and b.lifecycle='live' and b.scan_state<>'infected' and encode(b.sha256,'hex')=p_sha and r.document_sha256=p_sha)
$$;
create function app.cv_search_chunk_binding_v1(p_source uuid) returns boolean language sql stable set search_path=pg_catalog,app,pg_temp as $$ select exists(select 1 from app.profile_search_sources s where s.id=p_source and s.component='cv') $$;
reset role;set local role app_owner;
drop policy profile_search_scope on app.profile_search_sources;
create policy profile_search_scope on app.profile_search_sources for all to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and (owner_user_id is null or owner_user_id=app.context_uuid_v1('app.actor_id')) and (component='profile' or pg_trigger_depth()>0 or ((select app.has_permission_v1('documents.download')) and exists(select 1 from app.candidate_reviewed_cv_text binding_r join app.candidates binding_c on binding_c.id=binding_r.candidate_id join app.documents binding_d on binding_d.id=binding_r.document_id join app.file_blobs binding_b on binding_b.id=binding_d.blob_id where binding_r.id=app.profile_search_sources.reviewed_text_id and binding_c.id=app.profile_search_sources.source_id and binding_c.current_document_id=binding_d.id and binding_d.id=app.profile_search_sources.document_id and binding_c.lifecycle='active' and binding_d.lifecycle='active' and binding_b.lifecycle='live' and binding_b.scan_state<>'infected' and encode(binding_b.sha256,'hex')=app.profile_search_sources.document_sha256 and binding_r.document_sha256=app.profile_search_sources.document_sha256)))) with check(organization_id=app.context_uuid_v1('app.organization_id') and (owner_user_id is null or owner_user_id=app.context_uuid_v1('app.actor_id')) and (component='profile' or pg_trigger_depth()>0 or ((select app.has_permission_v1('documents.download')) and exists(select 1 from app.candidate_reviewed_cv_text binding_r join app.candidates binding_c on binding_c.id=binding_r.candidate_id join app.documents binding_d on binding_d.id=binding_r.document_id join app.file_blobs binding_b on binding_b.id=binding_d.blob_id where binding_r.id=app.profile_search_sources.reviewed_text_id and binding_c.id=app.profile_search_sources.source_id and binding_c.current_document_id=binding_d.id and binding_d.id=app.profile_search_sources.document_id and binding_c.lifecycle='active' and binding_d.lifecycle='active' and binding_b.lifecycle='live' and binding_b.scan_state<>'infected' and encode(binding_b.sha256,'hex')=app.profile_search_sources.document_sha256 and binding_r.document_sha256=app.profile_search_sources.document_sha256))));
drop policy profile_search_scope on app.profile_search_chunks;
create policy profile_search_scope on app.profile_search_chunks for all to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and (owner_user_id is null or owner_user_id=app.context_uuid_v1('app.actor_id')) and (component='profile' or pg_trigger_depth()>0 or ((select app.has_permission_v1('documents.download')) and source_id in(select authorized.id from app.profile_search_sources authorized where authorized.component='cv' and authorized.organization_id=app.context_uuid_v1('app.organization_id') and exists(select 1 from app.candidate_reviewed_cv_text binding_r join app.candidates binding_c on binding_c.id=binding_r.candidate_id join app.documents binding_d on binding_d.id=binding_r.document_id join app.file_blobs binding_b on binding_b.id=binding_d.blob_id where binding_r.id=authorized.reviewed_text_id and binding_c.id=authorized.source_id and binding_c.current_document_id=binding_d.id and binding_d.id=authorized.document_id and binding_c.lifecycle='active' and binding_d.lifecycle='active' and binding_b.lifecycle='live' and binding_b.scan_state<>'infected' and encode(binding_b.sha256,'hex')=authorized.document_sha256 and binding_r.document_sha256=authorized.document_sha256))))) with check(organization_id=app.context_uuid_v1('app.organization_id') and (owner_user_id is null or owner_user_id=app.context_uuid_v1('app.actor_id')) and (component='profile' or pg_trigger_depth()>0 or ((select app.has_permission_v1('documents.download')) and source_id in(select authorized.id from app.profile_search_sources authorized where authorized.component='cv' and authorized.organization_id=app.context_uuid_v1('app.organization_id') and exists(select 1 from app.candidate_reviewed_cv_text binding_r join app.candidates binding_c on binding_c.id=binding_r.candidate_id join app.documents binding_d on binding_d.id=binding_r.document_id join app.file_blobs binding_b on binding_b.id=binding_d.blob_id where binding_r.id=authorized.reviewed_text_id and binding_c.id=authorized.source_id and binding_c.current_document_id=binding_d.id and binding_d.id=authorized.document_id and binding_c.lifecycle='active' and binding_d.lifecycle='active' and binding_b.lifecycle='live' and binding_b.scan_state<>'infected' and encode(binding_b.sha256,'hex')=authorized.document_sha256 and binding_r.document_sha256=authorized.document_sha256)))));
reset role;set local role app_executor;
create function app.cv_search_chunk_component_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 select component into strict new.component from app.profile_search_sources where id=new.source_id;return new;end $$;
create trigger cv_search_chunk_component before insert or update of source_id,component on app.profile_search_chunks for each row execute function app.cv_search_chunk_component_v1();
create function app.cv_search_refresh_v1(p_org uuid,p_candidate uuid) returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare old_org text:=current_setting('app.organization_id',true);r app.candidate_reviewed_cv_text;s app.profile_search_sources;doc uuid;begin
 perform set_config('app.organization_id',p_org::text,true);
 -- Canonical mutation has already locked its row. Epoch always precedes source.
 insert into app.cv_search_epochs(organization_id) values(p_org) on conflict do nothing;
 perform 1 from app.cv_search_epochs where organization_id=p_org for update;
 select a.* into r from app.candidate_reviewed_cv_text a join app.candidates c on c.id=a.candidate_id join app.documents d on d.id=a.document_id join app.file_blobs b on b.id=d.blob_id where c.id=p_candidate and c.lifecycle='active' and c.current_document_id=d.id and d.lifecycle='active' and b.lifecycle='live' and b.scan_state<>'infected' and encode(b.sha256,'hex')=a.document_sha256;
 select * into s from app.profile_search_sources where source_type='candidate' and source_id=p_candidate and component='cv' for update;
 if r.id is null then
 if s.id is not null and s.status<>'retired' then
 update app.cv_search_epochs set safety_revision=safety_revision+1,growth_revision=growth_revision+1 where organization_id=p_org;
 update app.profile_search_sources set revision=revision+1,status='retired',projection_text=null,source_sha256=null,manifest_sha256=null,lease_token=null,receipt=null,receipt_digest=null where id=s.id;delete from app.profile_search_chunks where source_id=s.id;
 end if;
 elsif s.id is null or s.status='retired' or s.reviewed_text_id is distinct from r.id or s.document_id is distinct from r.document_id or s.document_sha256 is distinct from r.document_sha256 or s.source_sha256 is distinct from r.text_sha256 then
 update app.cv_search_epochs set safety_revision=safety_revision+case when s.id is not null then 1 else 0 end,growth_revision=growth_revision+1 where organization_id=p_org;
 insert into app.profile_search_sources(organization_id,source_type,source_id,component,reviewed_text_id,document_id,document_sha256,source_sha256) values(p_org,'candidate',p_candidate,'cv',r.id,r.document_id,r.document_sha256,r.text_sha256)
 on conflict(source_type,source_id,component) do update set revision=app.profile_search_sources.revision+1,status='queued',reviewed_text_id=excluded.reviewed_text_id,document_id=excluded.document_id,document_sha256=excluded.document_sha256,source_sha256=excluded.source_sha256,projection_text=null,manifest_sha256=null,lease_token=null,lease_worker_id=null,lease_expires_at=null,lease_kind=null,lease_ordinals=null,receipt_token=null,receipt_digest=null,receipt=null,attempts=0,error_code=null,available_at=now() returning id into doc;
 delete from app.profile_search_chunks where source_id=doc;
 end if;
 perform set_config('app.organization_id',coalesce(old_org,''),true);
end $$;
create function app.cv_search_event_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ declare n jsonb:=coalesce(to_jsonb(new),to_jsonb(old));org uuid:=(n->>'organization_id')::uuid;cid uuid;old_org text:=current_setting('app.organization_id',true);begin
 perform set_config('app.organization_id',org::text,true);
 if tg_table_name='candidates' then perform app.cv_search_refresh_v1(org,(n->>'id')::uuid);
 elsif tg_table_name='file_blobs' then for cid in select distinct candidate_id from app.documents where blob_id=(n->>'id')::uuid order by candidate_id loop perform app.cv_search_refresh_v1(org,cid);end loop;
 else
 if tg_op<>'INSERT' then perform app.cv_search_refresh_v1(org,old.candidate_id);end if;
 if tg_op<>'DELETE' then perform app.cv_search_refresh_v1(org,new.candidate_id);end if;
 end if;perform set_config('app.organization_id',coalesce(old_org,''),true);return coalesce(new,old);end $$;
create trigger zz_cv_search_candidate after insert or update of current_document_id,lifecycle or delete on app.candidates for each row execute function app.cv_search_event_v1();
create trigger cv_search_document after update of lifecycle,blob_id,candidate_id or delete on app.documents for each row execute function app.cv_search_event_v1();
create trigger cv_search_blob after update of lifecycle,sha256,scan_state or delete on app.file_blobs for each row execute function app.cv_search_event_v1();
create trigger cv_search_reviewed after insert or update or delete on app.candidate_reviewed_cv_text for each row execute function app.cv_search_event_v1();
create or replace function app.profile_search_lock_v1() returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin
 insert into app.profile_search_epochs(organization_id,owner_user_id) values(app.context_uuid_v1('app.organization_id'),null),(app.context_uuid_v1('app.organization_id'),app.context_uuid_v1('app.actor_id')) on conflict do nothing;
 perform 1 from app.profile_search_epochs order by owner_user_id nulls first for update;
 insert into app.cv_search_epochs(organization_id) values(app.context_uuid_v1('app.organization_id')) on conflict do nothing; perform 1 from app.cv_search_epochs where organization_id=app.context_uuid_v1('app.organization_id') for update; end $$;
create or replace function app.profile_search_invalidate_v1(p_org uuid,p_owner uuid,p_type text,p_id uuid,p_retire boolean,p_changed boolean) returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
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
 on conflict(source_type,source_id,component) do update set revision=app.profile_search_sources.revision+1,status=excluded.status,projection_text=null,source_sha256=null,manifest_sha256=null,error_code=null,lease_token=null,lease_worker_id=null,lease_expires_at=null,lease_kind=null,lease_ordinals=null,receipt_token=null,receipt_digest=null,receipt=null,attempts=0,available_at=now()
 returning id into sid;
 delete from app.profile_search_chunks where source_id=sid;
 end if;
 perform set_config('app.organization_id',coalesce(old_org,''),true); perform set_config('app.actor_id',coalesce(old_actor,''),true);
end $$;
create or replace function app.profile_search_eligible_v1(p_scope text,p_ready boolean) returns setof app.profile_search_sources language sql stable as $$
 select s.* from app.profile_search_sources s where s.status<>'retired' and (s.component='profile' or app.cv_search_mode_v1()) and ((s.source_type='candidate' and p_scope<>'my_drafts') or (s.source_type='draft' and p_scope<>'approved' and exists(select 1 from app.telegram_drafts d where d.id=s.source_id and d.status in('pending','snoozed','duplicate') and (not p_ready or (cardinality(app.telegram_missing_v1(d.fields,d.document))=0 and not app.cv_analysis_required_v1(d) and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending'))))))
$$;
create function app.cv_search_growth_v1() returns void language sql volatile set search_path=pg_catalog,app,pg_temp as $$ insert into app.cv_search_epochs(organization_id) values(app.context_uuid_v1('app.organization_id')) on conflict(organization_id) do update set growth_revision=app.cv_search_epochs.growth_revision+1 $$;
create function app.cv_search_capacity_v1(p_scope text,p_ready boolean) returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$ select jsonb_build_object('readyChunks',count(*),'maxReadyChunks',app.cv_search_limit_v1(),'withinLimit',count(*)<=app.cv_search_limit_v1()) from app.profile_search_eligible_v1(p_scope,p_ready) s join app.profile_search_chunks ch on ch.source_id=s.id and ch.revision=s.revision where s.status='ready' and ch.embedding is not null $$;
create or replace function app.profile_search_coverage_v1(p_scope text,p_ready boolean) returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
 with selected as materialized(select * from app.profile_search_eligible_v1(p_scope,p_ready)), profiles as(select source_type,source_id,bool_or(status='ready') indexed,bool_and(status='ready') complete,bool_or(status in('queued','planning','embedding')) pending,bool_or(status='failed') failed from selected group by source_type,source_id)
 select jsonb_build_object('eligible',count(*),'indexed',count(*)filter(where indexed),'fullyIndexed',count(*)filter(where complete),'pending',count(*)filter(where pending),'failed',count(*)filter(where failed),'retryable',(select count(*) from selected where status='failed' and error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED')),'corpusChanged',false,'cv',case when app.cv_search_mode_v1() then
 (select jsonb_build_object('attached',(select count(*) from app.candidates c join app.documents d on d.id=c.current_document_id where c.lifecycle='active' and d.lifecycle='active'),'withoutRetainedText',(select count(*) from app.candidates c join app.documents d on d.id=c.current_document_id where c.lifecycle='active' and d.lifecycle='active')-count(*),'eligible',count(*),'indexed',count(*)filter(where status='ready'),'pending',count(*)filter(where status in('queued','planning','embedding')),'failed',count(*)filter(where status='failed'),'retryable',count(*)filter(where status='failed' and error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED'))) from selected where component='cv') else null end) from profiles
$$;
create function app.cv_search_query_guard_v1(p_id uuid) returns boolean language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ declare q app.profile_search_queries;code text;epoch bigint;begin
 select * into q from app.profile_search_queries where id=p_id;
 if not q.include_cv or q.status in('cancelled','expired') then return true;end if;
 select safety_revision into epoch from app.cv_search_epochs where organization_id=q.organization_id;
 code:=case when not app.has_permission_v1('documents.download') then 'CV_ACCESS_CHANGED' when q.cv_safety_revision is not null and q.cv_safety_revision<>coalesce(epoch,0) then 'CV_RESULTS_CHANGED' end;
 if code is null then return true;end if;
 update app.profile_search_queries set status='failed',error_code=code,embedding=null,lease_token=null,coverage=null,capacity=null,receipt=jsonb_build_object('ok',true,'status','failed','errorCode',code) where id=q.id;
 return false;
end $$;
create or replace function app.profile_search_action_v1(p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare q app.profile_search_queries; digest bytea; org uuid:=app.context_uuid_v1('app.organization_id'); actor uuid:=app.context_uuid_v1('app.actor_id'); retried integer:=0; remaining integer; source app.profile_search_sources;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p ? 'includeCv' and jsonb_typeof(p->'includeCv') is distinct from 'boolean' then raise exception 'Invalid CV mode' using errcode='22023';end if;
 perform set_config('app.cv_search_mode',case when coalesce((p->>'includeCv')::boolean,false) then 'on' else 'off' end,true);
 if app.cv_search_mode_v1() then if p->>'scope'='my_drafts' then raise exception 'Draft CV mode unavailable' using errcode='22023';end if; if not app.has_permission_v1('documents.download') then raise exception 'Document permission required' using errcode='42501';end if;end if;
 -- Owner row serializes replacement and idempotent submission, without an org UPDATE lock.
 perform 1 from app.organization_memberships where organization_id=org and user_id=actor for update;
 perform app.profile_search_expire_v1();
 if p->>'action'='retryIndex' then
 if coalesce(p->>'scope','') not in('approved','my_drafts','all') or jsonb_typeof(p->'readyOnly') is distinct from 'boolean' then raise exception 'Invalid retry scope' using errcode='22023'; end if;
 perform app.profile_search_lock_v1();
 -- Select the current eligible revision under its source lock; partial manifest
 -- and vectors are durable and need not be regenerated after a temporary outage.
 for source in select s.* from app.profile_search_sources s where s.status='failed' and s.error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED') and s.id in(select e.id from app.profile_search_eligible_v1(p->>'scope',(p->>'readyOnly')::boolean)e) order by s.id for update skip locked limit 100 loop
 update app.profile_search_sources set status=case when manifest_sha256 is null then 'queued' else 'embedding' end,attempts=0,error_code=null,lease_token=null,lease_worker_id=null,lease_expires_at=null,lease_kind=null,lease_ordinals=null,receipt_token=null,receipt_digest=null,receipt=null,available_at=now(),served_at=now() where id=source.id;
 if source.component='cv' then perform app.cv_search_growth_v1();else perform app.profile_search_epoch_v1(source.organization_id,source.owner_user_id);end if; retried:=retried+1;
 end loop;
 select count(*) into remaining from app.profile_search_eligible_v1(p->>'scope',(p->>'readyOnly')::boolean) where status='failed' and error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED');
 return jsonb_build_object('ok',true,'retried',retried,'remainingFailed',remaining);
 end if;
 if p->>'action'='cancel' then
 select * into q from app.profile_search_queries where id=(p->>'queryId')::uuid for update; if not found then raise exception 'Query unavailable' using errcode='P0002'; end if;
 update app.profile_search_queries set status='cancelled',embedding=null,lease_token=null where id=q.id and status in('queued','running'); return jsonb_build_object('ok',true);
 end if;
 if p->>'action'<>'search' or coalesce(p->>'scope','') not in('approved','my_drafts','all') or char_length(trim(p->>'query')) not between 1 and 2000 or octet_length(p->>'query')>8000 or jsonb_typeof(p->'readyOnly')<>'boolean' then raise exception 'Invalid search' using errcode='22023'; end if;
 digest:=sha256(convert_to((case when app.cv_search_mode_v1() then p else p-'includeCv' end)::text,'UTF8'));
 select * into q from app.profile_search_queries where operation_id=(p->>'operationId')::uuid;
 if found then if q.request_digest<>digest then raise exception 'Operation changed' using errcode='40001'; end if; return jsonb_build_object('queryId',q.id,'status',q.status,'expiresAt',q.expires_at); end if;
 update app.profile_search_queries set status='cancelled',embedding=null,lease_token=null where status in('queued','running');
 insert into app.profile_search_queries(organization_id,owner_user_id,operation_id,request_digest,query_text,query_sha256,scope,ready_only,include_cv) values(org,actor,(p->>'operationId')::uuid,digest,p->>'query',encode(sha256(convert_to(p->>'query','UTF8')),'hex'),p->>'scope',(p->>'readyOnly')::boolean,app.cv_search_mode_v1()) returning * into q;
 return jsonb_build_object('queryId',q.id,'status',q.status,'expiresAt',q.expires_at);
end $$;
create or replace function app.profile_search_worker_claim_v1(p_token text,p_cv boolean,p_minilm boolean) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; q app.profile_search_queries; s app.profile_search_sources; profile jsonb; txt text; chunks jsonb; body jsonb; attempt integer;
begin
 w:=app.telegram_worker_context_v1(p_token);if p_minilm is distinct from true then return jsonb_build_object('job',null);end if; update app.telegram_workers set last_search_seen_at=now() where id=w;
 perform app.profile_search_expire_v1();
 update app.profile_search_queries set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_token=null where status in('queued','running') and attempts>=5 and (lease_expires_at is null or lease_expires_at<=now());
 select * into q from app.profile_search_queries where status in('queued','running') and available_at<=now() and expires_at>now() and (lease_expires_at is null or lease_expires_at<=now() or lease_worker_id=w) order by created_at,id for update skip locked limit 1;
 if found then
 if q.lease_token is null or q.lease_expires_at<=now() then q.lease_token:=gen_random_uuid(); q.attempts:=q.attempts+1; end if;
 update app.profile_search_queries set status='running',lease_token=q.lease_token,lease_worker_id=w,lease_expires_at=now()+interval '120 seconds',attempts=q.attempts where id=q.id returning * into q;
 return jsonb_build_object('job',app.profile_search_versions_v1()||jsonb_build_object('id',q.id,'kind','query','leaseToken',q.lease_token,'leaseExpiresAt',q.lease_expires_at,'query',q.query_text,'querySha256',q.query_sha256));
 end if;
 perform app.profile_search_lock_v1();
 perform 1 from app.cv_search_epochs where organization_id=app.context_uuid_v1('app.organization_id') for update;
 for s in update app.profile_search_sources set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_token=null where (component='profile' or p_cv) and status in('queued','planning','embedding') and attempts>=5 and (lease_expires_at is null or lease_expires_at<=now()) returning * loop if s.component='cv' then perform app.cv_search_growth_v1();else perform app.profile_search_epoch_v1(s.organization_id,s.owner_user_id);end if; end loop;
 -- Bounded scan handles retired/missing legacy rows without holding an unbounded transaction.
 for attempt in 1..16 loop
 with shared as materialized(select id,served_at from app.profile_search_sources where owner_user_id is null and (component='profile' or p_cv) and status in('queued','planning','embedding') and available_at<=now() and (lease_expires_at is null or lease_expires_at<=now() or lease_worker_id=w) order by served_at,id for update skip locked limit 1),
 mine as materialized(select id,served_at from app.profile_search_sources where owner_user_id=app.context_uuid_v1('app.actor_id') and status in('queued','planning','embedding') and available_at<=now() and (lease_expires_at is null or lease_expires_at<=now() or lease_worker_id=w) order by served_at,id for update skip locked limit 1),
 picks as(select * from shared union all select * from mine)
 select source.* into s from app.profile_search_sources source join picks on picks.id=source.id order by picks.served_at,picks.id limit 1;
 if not found then return jsonb_build_object('job',null); end if;
 profile:=app.profile_search_profile_v1(s);
 if profile is null then update app.profile_search_sources set status='retired',projection_text=null,lease_token=null where id=s.id; delete from app.profile_search_chunks where source_id=s.id; if s.component='cv' then perform app.cv_search_growth_v1();else perform app.profile_search_epoch_v1(s.organization_id,s.owner_user_id);end if; continue; end if;
 if s.projection_text is null then
 if s.component='cv' then select text_content into txt from app.candidate_reviewed_cv_text where id=s.reviewed_text_id and text_sha256=s.source_sha256;else txt:=app.profile_search_text_v1(profile->'fields');end if;
 if s.component='cv' and (txt is null or encode(sha256(convert_to(txt,'UTF8')),'hex') is distinct from s.source_sha256) then update app.profile_search_sources set status='failed',error_code='INVALID_RESULT' where id=s.id;perform app.cv_search_growth_v1();continue;end if;
 if octet_length(txt)>65536 then update app.profile_search_sources set status='failed',error_code='SOURCE_TOO_LARGE' where id=s.id; if s.component='cv' then perform app.cv_search_growth_v1();else perform app.profile_search_epoch_v1(s.organization_id,s.owner_user_id);end if; continue; end if;
 update app.profile_search_sources set projection_text=txt,source_sha256=encode(sha256(convert_to(txt,'UTF8')),'hex') where id=s.id returning * into s;
 end if;
 if s.lease_token is null or s.lease_expires_at<=now() then
 s.lease_token:=gen_random_uuid(); s.attempts:=s.attempts+1; s.lease_kind:=case when s.manifest_sha256 is null then 'plan' else 'embed' end;
 select array_agg(ordinal order by ordinal) into s.lease_ordinals from(select ordinal from app.profile_search_chunks where source_id=s.id and embedding is null order by ordinal limit 8)c;
 end if;
 update app.profile_search_sources set status=case when s.lease_kind='plan' then 'planning' else 'embedding' end,lease_kind=s.lease_kind,lease_ordinals=s.lease_ordinals,lease_token=s.lease_token,lease_worker_id=w,lease_expires_at=now()+interval '120 seconds',attempts=s.attempts,served_at=now() where id=s.id returning * into s;
 body:=app.profile_search_versions_v1()||jsonb_build_object('id',s.id,'kind',s.lease_kind,'leaseToken',s.lease_token,'leaseExpiresAt',s.lease_expires_at,'source',jsonb_build_object('component',s.component,'sourceType',s.source_type,'sourceId',s.source_id,'revision',s.revision,'sha256',s.source_sha256));
 if s.component='cv' then body:=body||jsonb_build_object('projectionVersion','candidate-reviewed-cv-v1','chunkerVersion','minilm-cv-lines-128-v1');body:=jsonb_set(body,'{source}',(body->'source')||jsonb_build_object('reviewedTextId',s.reviewed_text_id,'document',jsonb_build_object('id',s.document_id,'sha256',s.document_sha256)));end if;
 if s.lease_kind='plan' then body:=jsonb_set(body,'{source,text}',to_jsonb(s.projection_text));
 else
 select jsonb_agg(jsonb_build_object('ordinal',ordinal,'startByte',start_byte,'endByte',end_byte,'sha256',sha256,'text',convert_from(substring(convert_to(s.projection_text,'UTF8') from start_byte+1 for end_byte-start_byte),'UTF8')) order by ordinal) into chunks from app.profile_search_chunks where source_id=s.id and ordinal=any(s.lease_ordinals);
 body:=body||jsonb_build_object('manifestSha256',s.manifest_sha256,'chunks',chunks);
 end if;
 return jsonb_build_object('job',body);
 end loop;
 return jsonb_build_object('job',null);
end $$;
create or replace function app.profile_search_worker_claim_v1(p_token text) returns jsonb language sql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ select app.profile_search_worker_claim_v1(p_token,false,false) $$;
create or replace function app.profile_search_worker_source_v1(p_token text,p_id uuid,p_revision bigint,p_sha text,p_projection text) returns text language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare txt text; begin
 perform app.telegram_worker_context_v1(p_token);
 if p_projection='candidate-reviewed-cv-v1' and not app.has_permission_v1('documents.download') then raise exception 'Document permission required' using errcode='42501';end if;
 select projection_text into txt from app.profile_search_sources where id=p_id and revision=p_revision and source_sha256=p_sha and status<>'retired' and (case when component='cv' then 'candidate-reviewed-cv-v1' else 'candidate-profile-v1' end)=p_projection; if not found then raise exception 'Source changed' using errcode='40001'; end if; return txt;
end $$;
create or replace function app.profile_search_worker_complete_v1(p_token text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; s app.profile_search_sources; q app.profile_search_queries; digest bytea; chunk jsonb; n integer:=0; boundary integer:=0; bytes bytea; piece bytea; text_piece text; manifest text; ordinals integer[]; v_receipt jsonb; versions jsonb:=app.profile_search_versions_v1();
begin
 w:=app.telegram_worker_context_v1(p_token); update app.telegram_workers set last_search_seen_at=now() where id=w;
 if octet_length(p::text)>300000 or p->>'indexVersion' is distinct from versions->>'indexVersion' or coalesce(p->>'projectionVersion','') not in('candidate-profile-v1','candidate-reviewed-cv-v1') or p->>'chunkerVersion' is distinct from (case when p->>'projectionVersion'='candidate-reviewed-cv-v1' then 'minilm-cv-lines-128-v1' else versions->>'chunkerVersion' end) then raise exception 'Invalid version' using errcode='22023'; end if;
 if p->>'projectionVersion'='candidate-reviewed-cv-v1' and not app.has_permission_v1('documents.download') then raise exception 'Document permission required' using errcode='42501';end if;
 digest:=sha256(convert_to((p-'leaseToken')::text,'UTF8'));
 if p->>'kind'='query' then
 select * into q from app.profile_search_queries where id=(p->>'jobId')::uuid for update;
 if not found then raise exception 'Query unavailable' using errcode='P0002'; end if;
 if q.expires_at<=now() or q.status in('cancelled','expired') then raise exception 'Query expired' using errcode='40001'; end if;
 if not app.cv_search_query_guard_v1(q.id) then return (select receipt from app.profile_search_queries where id=q.id);end if;
 if p->>'projectionVersion'<>'candidate-profile-v1' then raise exception 'Invalid query version' using errcode='22023';end if;
 if q.receipt_digest=digest and q.receipt is not null then return q.receipt; end if;
 if q.status<>'running' or q.lease_token is distinct from (p->>'leaseToken')::uuid or q.lease_worker_id<>w or q.lease_expires_at<=now() or q.query_sha256 is distinct from p->>'querySha256' then raise exception 'Query changed' using errcode='40001'; end if;
 update app.profile_search_queries set embedding=app.profile_search_vector_v1(p#>'{result,embedding}'),receipt_digest=digest where id=q.id;
 return jsonb_build_object('ok',true,'status','scoring');
 end if;
 if p->>'kind' not in('plan','embed') then raise exception 'Invalid kind' using errcode='22023'; end if;
 perform app.profile_search_lock_v1();
 perform 1 from app.cv_search_epochs where organization_id=app.context_uuid_v1('app.organization_id') for update;
 select * into s from app.profile_search_sources where id=(p->>'jobId')::uuid for update;
 if not found then raise exception 'Source changed' using errcode='40001'; end if;
 if p->>'projectionVersion' is distinct from (case when s.component='cv' then 'candidate-reviewed-cv-v1' else 'candidate-profile-v1' end) or p->>'chunkerVersion' is distinct from (case when s.component='cv' then 'minilm-cv-lines-128-v1' else 'minilm-utf8-128-v1' end) then raise exception 'Component version changed' using errcode='40001';end if;
 if s.revision is distinct from (p->>'sourceRevision')::bigint or s.source_sha256 is distinct from p->>'sourceSha256' or s.status='retired' then raise exception 'Source changed' using errcode='40001'; end if;
 if s.receipt_digest=digest and s.receipt_token=(p->>'leaseToken')::uuid then return s.receipt; end if;
 if s.lease_token is distinct from (p->>'leaseToken')::uuid or s.lease_worker_id<>w or s.lease_expires_at<=now() or s.lease_kind is distinct from p->>'kind' then raise exception 'Lease changed' using errcode='40001'; end if;
 if p->>'kind'='plan' then
 if jsonb_typeof(p#>'{result,chunks}')<>'array' or jsonb_array_length(p#>'{result,chunks}') not between 1 and 256 or (p#>>'{result,byteLength}')::integer<>octet_length(s.projection_text) then raise exception 'Invalid manifest' using errcode='22023'; end if;
 bytes:=convert_to(s.projection_text,'UTF8');
 for chunk in select value from jsonb_array_elements(p#>'{result,chunks}') loop
 if (chunk->>'ordinal')::integer<>n or (chunk->>'startByte')::integer<>boundary or (chunk->>'endByte')::integer<=boundary or (chunk->>'endByte')::integer-boundary>16384 or (chunk->>'tokenCount')::integer not between 1 and 128 then raise exception 'Invalid chunk bounds' using errcode='22023'; end if;
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
 if v_receipt->>'status'='ready' then if s.component='cv' then perform app.cv_search_growth_v1();else perform app.profile_search_epoch_v1(s.organization_id,s.owner_user_id);end if; end if;
 end if;
 return v_receipt;
end $$;
create or replace function app.profile_search_score_v1(p_token text,p_id uuid,p_lease uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid; q app.profile_search_queries; v_receipt jsonb; inserted_rows bigint;
begin
 w:=app.telegram_worker_context_v1(p_token);
 select * into q from app.profile_search_queries where id=p_id for update;
 if not found then raise exception 'Query unavailable' using errcode='P0002'; end if;
 if q.expires_at<=now() or q.status in('cancelled','expired') then raise exception 'Query expired' using errcode='40001'; end if;
 if not app.cv_search_query_guard_v1(q.id) then return (select receipt from app.profile_search_queries where id=q.id);end if;
 perform set_config('app.cv_search_mode',case when q.include_cv then 'on' else 'off' end,true);
 if q.receipt is not null and q.status in('completed','failed') then return q.receipt; end if;
 if q.status<>'running' or q.embedding is null or q.lease_token is distinct from p_lease or q.lease_worker_id<>w or q.lease_expires_at<=now() then raise exception 'Query changed' using errcode='40001'; end if;
 select app.profile_search_coverage_v1(q.scope,q.ready_only),app.profile_search_revision_v1(q.scope),case when q.include_cv then coalesce((select safety_revision from app.cv_search_epochs where organization_id=q.organization_id),0) end,case when q.include_cv then coalesce((select growth_revision from app.cv_search_epochs where organization_id=q.organization_id),0) end into q.coverage,q.corpus_revision,q.cv_safety_revision,q.cv_growth_revision;
 update app.profile_search_queries set cv_safety_revision=q.cv_safety_revision,cv_growth_revision=q.cv_growth_revision where id=q.id;
 -- Count and ranking share one MVCC snapshot; over-capacity scans produce no ranks.
 with eligible as materialized(select id,revision,source_type,source_id,component from app.profile_search_eligible_v1(q.scope,q.ready_only) where status='ready'),
 ready_chunks as materialized(select s.*,ch.ordinal,ch.start_byte,ch.end_byte,ch.embedding from eligible s join app.profile_search_chunks ch on ch.source_id=s.id and ch.revision=s.revision where ch.embedding is not null),
 limits as materialized(select count(*) n from ready_chunks),
 ranked as(select distinct on(s.source_type,s.source_id) s.id,s.revision,s.source_type,s.source_id,s.ordinal,s.start_byte,s.end_byte,dot.score
 from ready_chunks s cross join limits
 cross join lateral(select sum(x::double precision*y::double precision) score from unnest(s.embedding,q.embedding) v(x,y)) dot
 where s.embedding is not null and (not q.include_cv or limits.n<=app.cv_search_limit_v1())
 order by s.source_type,s.source_id,dot.score desc,(s.component='profile') desc,s.ordinal),
 writes as(insert into app.profile_search_results(query_id,source_id,organization_id,owner_user_id,source_revision,score,ordinal,source_type,public_source_id,start_byte,end_byte)
 select q.id,id,q.organization_id,q.owner_user_id,revision,score,ordinal,source_type,source_id,start_byte,end_byte from ranked returning 1)
 select case when q.include_cv then jsonb_build_object('readyChunks',limits.n,'maxReadyChunks',app.cv_search_limit_v1(),'withinLimit',limits.n<=app.cv_search_limit_v1()) end,(select count(*) from writes) into q.capacity,inserted_rows from limits;
 if not app.cv_search_query_guard_v1(q.id) then return (select receipt from app.profile_search_queries where id=q.id);end if;
 if q.include_cv and not(q.capacity->>'withinLimit')::boolean then v_receipt:=jsonb_build_object('ok',true,'status','failed','errorCode','SEARCH_CAPACITY');update app.profile_search_queries set status='failed',error_code='SEARCH_CAPACITY',capacity=q.capacity,receipt=v_receipt,embedding=null,lease_token=null where id=q.id;return v_receipt;end if;

 v_receipt:=jsonb_build_object('ok',true,'status','completed');
 update app.profile_search_queries set status='completed',error_code=null,coverage=q.coverage,capacity=q.capacity,corpus_revision=q.corpus_revision,receipt=v_receipt,lease_token=null where id=q.id;
 return v_receipt;
end $$;
create or replace function app.cv_search_status_v1(p_scope text,p_ready boolean,p_query uuid,p_after jsonb,p_cv boolean) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare q app.profile_search_queries; available boolean; records jsonb; cv jsonb; cursor jsonb; n integer;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_scope not in('approved','my_drafts','all') then raise exception 'Invalid scope' using errcode='22023'; end if;
 perform set_config('app.cv_search_mode',case when p_cv then 'on' else 'off' end,true);
 if p_query is null and p_cv then if p_scope='my_drafts' then raise exception 'Draft CV search unavailable' using errcode='22023';end if;if not app.has_permission_v1('documents.download') then raise exception 'Document permission required' using errcode='42501';end if;end if;
 if p_query is not null then update app.profile_search_queries set status='expired',query_text=null,embedding=null,receipt=null,receipt_digest=null,lease_token=null,result_cleanup_pending=true where id=p_query and expires_at<=now() and status<>'expired';end if;
 perform app.profile_search_expire_v1();
 select exists(select 1 from app.telegram_workers where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and revoked_at is null and expires_at>now() and last_search_seen_at>now()-interval '90 seconds') into available;
 if p_query is null then return app.profile_search_versions_v1()||jsonb_build_object('coverage',app.profile_search_coverage_v1(p_scope,p_ready),'workerAvailable',available,'cvAvailable',app.has_permission_v1('documents.download'),'includeCv',p_cv,'cvProjectionVersion','candidate-reviewed-cv-v1','capacity',case when p_cv then app.cv_search_capacity_v1(p_scope,p_ready) end); end if;
 select * into q from app.profile_search_queries where id=p_query; if not found then raise exception 'Query unavailable' using errcode='P0002'; end if;
 if not app.cv_search_query_guard_v1(q.id) then select * into q from app.profile_search_queries where id=q.id;end if;
 perform set_config('app.cv_search_mode',case when q.include_cv and app.has_permission_v1('documents.download') and q.status not in('cancelled','expired') and q.error_code is distinct from 'CV_ACCESS_CHANGED' and q.error_code is distinct from 'CV_RESULTS_CHANGED' then 'on' else 'off' end,true);
 cv:=case when q.include_cv and not app.cv_search_mode_v1() then app.profile_search_coverage_v1(q.scope,q.ready_only) else coalesce(q.coverage,app.profile_search_coverage_v1(q.scope,q.ready_only)) end;
 if not app.cv_search_mode_v1() then q.capacity:=null;end if;
 cv:=cv||jsonb_build_object('corpusChanged',q.corpus_revision is not null and (q.corpus_revision<>app.profile_search_revision_v1(q.scope) or q.include_cv and q.cv_growth_revision is distinct from (select growth_revision from app.cv_search_epochs where organization_id=q.organization_id)),'retryable',(select count(*) from app.profile_search_eligible_v1(q.scope,q.ready_only) where status='failed' and error_code in('EMBEDDING_UNAVAILABLE','WORKER_ERROR','ATTEMPTS_EXHAUSTED')));
 records:='[]'; cursor:=null;
 if q.status='completed' then
 -- Paginate ranks before reading contact identifiers or constructing profile
 -- DTOs. Evaluating a full projection before LIMIT scales with the whole corpus.
 with page as materialized (
 select r.*,s::app.profile_search_sources as source from (
 select * from app.profile_search_results r where r.query_id=q.id
 and (p_after is null or r.score<(p_after->>'score')::double precision or (r.score=(p_after->>'score')::double precision and (r.source_type,r.public_source_id)>(p_after->>'sourceType',(p_after->>'sourceId')::uuid)))
 order by r.score desc,r.source_type,r.public_source_id offset 0
 ) r join lateral(select live.* from app.profile_search_sources live where live.id=r.source_id and live.revision=r.source_revision and live.status='ready' limit 1) s on true
 where (s.source_type='candidate' or exists(select 1 from app.telegram_drafts d where d.id=s.source_id and d.status in('pending','snoozed','duplicate') and (not q.ready_only or (cardinality(app.telegram_missing_v1(d.fields,d.document))=0 and not app.cv_analysis_required_v1(d) and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending')))))
 and (p_after is null or r.score<(p_after->>'score')::double precision or (r.score=(p_after->>'score')::double precision and (r.source_type,r.public_source_id)>(p_after->>'sourceType',(p_after->>'sourceId')::uuid))) order by r.score desc,r.source_type,r.public_source_id limit 26
 ), profiles as materialized(select page.*,app.profile_search_profile_v1(page.source) profile from page)
 select coalesce(jsonb_agg(jsonb_build_object('sourceType',p.source_type,'sourceId',p.public_source_id,'sourceRevision',p.source_revision,'displayName',p.profile->>'displayName','headline',p.profile->>'headline','location',p.profile->>'location','hasCv',p.profile->'hasCv','missingFields',p.profile->'missingFields','score',p.score,'matchedComponent',(p.source).component,'matchedDocument',case when (p.source).component='cv' then jsonb_build_object('id',(p.source).document_id,'filename',(select original_filename from app.documents where id=(p.source).document_id)) end,'matchedText',left(convert_from(substring(convert_to((p.source).projection_text,'UTF8') from coalesce(p.start_byte,ch.start_byte)+1 for coalesce(p.end_byte,ch.end_byte)-coalesce(p.start_byte,ch.start_byte)),'UTF8'),500),'href',case when p.source_type='candidate' then '/staff/candidates/'||p.public_source_id else '/staff/telegram-intake?draft='||p.public_source_id end) order by p.score desc,p.source_type,p.public_source_id),'[]'),count(*) into records,n
 from profiles p left join lateral(select start_byte,end_byte from app.profile_search_chunks where p.start_byte is null and source_id=p.source_id and ordinal=p.ordinal limit 1) ch on true where p.profile is not null;
 if n>25 then records:=records-25; cursor:=jsonb_build_object('queryId',q.id,'score',records->24->'score','sourceType',records->24->>'sourceType','sourceId',records->24->>'sourceId'); end if;
 end if;
 if not app.cv_search_query_guard_v1(q.id) then select * into q from app.profile_search_queries where id=q.id;records:='[]';cursor:=null;perform set_config('app.cv_search_mode','off',true);cv:=app.profile_search_coverage_v1(q.scope,q.ready_only);end if;
 return jsonb_build_object('includeCv',q.include_cv,'cvAvailable',app.has_permission_v1('documents.download'),'capacity',q.capacity,'queryId',q.id,'query',q.query_text,'scope',q.scope,'readyOnly',q.ready_only,'status',q.status,'results',records,'nextAfter',cursor,'coverage',cv,'workerAvailable',available,'errorCode',q.error_code,'expiresAt',q.expires_at);
end $$;
create or replace function app.profile_search_status_v1(p_scope text,p_ready boolean,p_query uuid,p_after jsonb) returns jsonb language sql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ select app.cv_search_status_v1(p_scope,p_ready,p_query,p_after,false) $$;
create or replace function app.merge_candidates_v1(
    p_review_id uuid,
    p_expected_review_version bigint,
    p_target_candidate_id uuid,
    p_expected_target_version bigint,
    p_expected_source_version bigint,
    p_primary_email text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_actor uuid;
    v_review app.candidate_duplicate_reviews;
    v_target app.candidates;
    v_source app.candidates;
    v_existing app.candidate_merge_events;
    v_source_id uuid;
    v_email text;
    v_email_id uuid;
    v_blob app.file_blobs;
    v_canonical app.file_blobs;
    v_source_primary uuid;
    v_target_primary uuid;
    v_retired jsonb := '[]'::jsonb;
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    v_actor := app.recruitment_actor_v1(
        array['candidates.read', 'duplicates.review', 'candidates.merge'],
        null, null, false);
    if p_review_id is null or p_target_candidate_id is null
        or p_expected_review_version is null or p_expected_review_version < 1
        or p_expected_target_version is null or p_expected_target_version < 1
        or p_expected_source_version is null or p_expected_source_version < 1
        or (p_primary_email is not null and
            (char_length(p_primary_email) > 254 or btrim(p_primary_email) = '')) then
        raise exception 'Invalid merge request' using errcode = '22023';
    end if;

    select * into v_existing from app.candidate_merge_events
    where organization_id = v_org and review_id = p_review_id;
    if found then
        if v_existing.target_candidate_id <> p_target_candidate_id
            or v_existing.target_version <> p_expected_target_version
            or v_existing.source_version <> p_expected_source_version
            or (v_existing.primary_email_identifier_id is null) <> (p_primary_email is null) then
            raise exception 'Review was merged with different choices'
                using errcode = '40001';
        end if;
        return pg_catalog.jsonb_build_object('targetCandidateId', p_target_candidate_id,
            'sourceCandidateId', v_existing.source_candidate_id, 'replayed', true);
    end if;

    select * into v_review from app.candidate_duplicate_reviews
    where organization_id = v_org and id = p_review_id for update;
    if not found then
        raise exception 'Duplicate review not found' using errcode = 'P0002';
    end if;
    if v_review.version <> p_expected_review_version
        or v_review.status = 'different_people' then
        raise exception 'Duplicate review changed' using errcode = '40001';
    end if;
    if p_target_candidate_id not in (v_review.candidate_a_id, v_review.candidate_b_id) then
        raise exception 'Primary candidate is not in the review'
            using errcode = '22023';
    end if;
    v_source_id := case when p_target_candidate_id = v_review.candidate_a_id
        then v_review.candidate_b_id else v_review.candidate_a_id end;

    -- Lock both records in a stable order. Profile updates, document writes,
    -- restrictions and concurrent merges must observe these locks.
    perform 1 from app.candidates
    where organization_id = v_org
        and id in (p_target_candidate_id, v_source_id)
    order by id for update;
    select * into v_target from app.candidates
    where organization_id = v_org and id = p_target_candidate_id;
    select * into v_source from app.candidates
    where organization_id = v_org and id = v_source_id;
    if v_target.lifecycle <> 'active' or v_source.lifecycle <> 'active' then
        raise exception 'Only active candidates can be merged'
            using errcode = '42501';
    end if;
    if v_target.version <> p_expected_target_version
        or v_source.version <> p_expected_source_version then
        raise exception 'Candidate changed; review both profiles again'
            using errcode = '40001';
    end if;

    -- Privacy cases and retained disclosure history need a separate reviewed
    -- resolution. Nothing is moved if either candidate has such records.
    if exists (select 1 from app.candidate_processing_purposes
        where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.privacy_requests
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.privacy_request_subjects
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.privacy_events
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.privacy_complaints
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.document_disclosures
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id))
        or exists (select 1 from app.legacy_records
            where organization_id = v_org and candidate_id in (v_source_id, p_target_candidate_id)) then
        raise exception 'Privacy-linked records require manual merge review'
            using errcode = '23514';
    end if;
    if exists (select 1 from app.file_blobs b
        where b.organization_id = v_org and b.candidate_id = v_source_id
            and (b.lifecycle <> 'live' or b.retired_into_id is not null))
        or exists (select 1 from app.file_blobs b
            join app.file_blobs r on r.organization_id = b.organization_id
                and r.candidate_id = b.candidate_id and r.retired_into_id = b.id
            where b.organization_id = v_org and b.candidate_id = v_source_id) then
        raise exception 'Archived file history requires manual merge review'
            using errcode = '23514';
    end if;

    if p_primary_email is not null then
        select i.id, i.raw_value into v_email_id, v_email from app.candidate_identifiers i
        where i.organization_id = v_org
            and i.candidate_id in (v_source_id, p_target_candidate_id)
            and i.kind = 'email'
            and lower(btrim(i.raw_value)) = lower(btrim(p_primary_email))
        order by (i.candidate_id = p_target_candidate_id) desc,
            i.received_at desc, i.id desc limit 1;
        if v_email is null then
            raise exception 'Primary email must belong to one of the candidates'
                using errcode = '22023';
        end if;
    elsif exists (select 1 from app.candidate_identifiers i
        where i.organization_id = v_org
            and i.candidate_id in (v_source_id, p_target_candidate_id)
            and i.kind = 'email') then
        raise exception 'Choose a primary email' using errcode = '22023';
    end if;

    -- Composite ownership references are checked at commit, after every
    -- dependent row has been reparented. The live-hash uniqueness is immediate.
    set constraints applications_source_fk, candidate_identifiers_source_fk,
        documents_blob_fk, documents_source_fk, documents_supersedes_fk,
        application_documents_application_fk, application_documents_document_fk,
        candidates_current_document_fk, file_blobs_candidate_fk,
        file_blobs_retired_into_fk deferred;

    -- Both canonical rows are locked by the merge above. Preserve reviewed
    -- provenance only for the exact current document that the target adopts.
    if v_target.current_document_id is null and v_source.current_document_id is not null then
        perform app.profile_search_lock_v1();
        update app.candidate_reviewed_cv_text set candidate_id=p_target_candidate_id
        where candidate_id=v_source_id and document_id=v_source.current_document_id;
    end if;

    update app.candidates set current_document_id = null,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and id = v_source_id;

    for v_blob in select * from app.file_blobs
        where organization_id = v_org and candidate_id = v_source_id
        order by id for update loop
        select * into v_canonical from app.file_blobs
        where organization_id = v_org and candidate_id = p_target_candidate_id
            and sha256 = v_blob.sha256 and lifecycle = 'live'
        for update;
        if found then
            if v_canonical.size_bytes <> v_blob.size_bytes
                or v_canonical.mime_type <> v_blob.mime_type
                or v_canonical.extension <> v_blob.extension then
                raise exception 'Identical hashes have conflicting file metadata'
                    using errcode = '23514';
            end if;
            if v_blob.scan_state = 'infected'
                or v_canonical.scan_state = 'infected' then
                raise exception 'An infected file needs manual merge review'
                    using errcode = '23514';
            end if;
            select l.id into v_source_primary from app.blob_locations l
            where l.organization_id = v_org and l.blob_id = v_blob.id
                and l.is_primary and l.state = 'available';
            select l.id into v_target_primary from app.blob_locations l
            where l.organization_id = v_org and l.blob_id = v_canonical.id
                and l.is_primary and l.state = 'available';
            update app.documents set blob_id = v_canonical.id,
                updated_at = v_now, version = version + 1
            where organization_id = v_org and candidate_id = v_source_id
                and blob_id = v_blob.id;
            if v_target_primary is null and v_source_primary is not null then
                update app.blob_locations set is_primary = false,
                    updated_at = v_now, version = version + 1
                where organization_id = v_org and blob_id = v_canonical.id
                    and is_primary;
            end if;
            update app.blob_locations set blob_id = v_canonical.id,
                is_primary = v_target_primary is null and id = v_source_primary,
                updated_at = v_now, version = version + 1
            where organization_id = v_org and blob_id = v_blob.id;
            update app.file_blobs set lifecycle = 'retired',
                updated_at = v_now, version = version + 1
            where organization_id = v_org and id = v_blob.id;
            v_retired := v_retired || pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object('retiredBlobId', v_blob.id,
                    'canonicalBlobId', v_canonical.id));
        else
            update app.file_blobs set candidate_id = p_target_candidate_id,
                updated_at = v_now, version = version + 1
            where organization_id = v_org and id = v_blob.id;
        end if;
    end loop;

    update app.candidate_sources set candidate_id = p_target_candidate_id
    where organization_id = v_org and candidate_id = v_source_id;
    update app.candidate_identifiers set candidate_id = p_target_candidate_id
    where organization_id = v_org and candidate_id = v_source_id;
    update app.applications set candidate_id = p_target_candidate_id,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and candidate_id = v_source_id;
    update app.documents set candidate_id = p_target_candidate_id,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and candidate_id = v_source_id;
    update app.application_documents set candidate_id = p_target_candidate_id
    where organization_id = v_org and candidate_id = v_source_id;
    update app.candidate_notes set candidate_id = p_target_candidate_id,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and candidate_id = v_source_id;

    update app.candidates set
        full_name = coalesce(nullif(btrim(v_target.full_name), ''), v_source.full_name),
        professional_summary = coalesce(v_target.professional_summary,
            v_source.professional_summary),
        headline = coalesce(v_target.headline, v_source.headline),
        location = coalesce(v_target.location, v_source.location),
        owner_membership_id = coalesce(v_target.owner_membership_id,
            v_source.owner_membership_id),
        identity_state = case when v_target.identity_state = 'established'
            or v_source.identity_state = 'established' then 'established'
            else 'provisional' end,
        contact_email = v_email,
        professional_url = coalesce(
            app.candidate_contact_v1(v_target, 'professional_url'),
            app.candidate_contact_v1(v_source, 'professional_url')),
        profile_contact_set = true,
        current_document_id = coalesce(v_target.current_document_id,
            v_source.current_document_id),
        profile_version = profile_version + 1,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and id = p_target_candidate_id;
    update app.candidates set lifecycle = 'merged',
        merged_into_id = p_target_candidate_id,
        updated_at = v_now, version = version + 1
    where organization_id = v_org and id = v_source_id;

    update app.candidate_duplicate_reviews set
        status = 'same_person', reviewer_membership_id = v_actor,
        reviewed_at = v_now, decision_evidence = v_review.evidence,
        version = version + 1, updated_at = v_now
    where organization_id = v_org and id = p_review_id;
    insert into app.candidate_duplicate_review_events (
        organization_id, review_id, reviewer_membership_id,
        previous_status, decision, evidence
    ) values (v_org, p_review_id, v_actor, v_review.status,
        'same_person', v_review.evidence);
    insert into app.candidate_merge_events (
        organization_id, review_id, source_candidate_id, target_candidate_id,
        actor_membership_id, source_version, target_version,
        primary_email_identifier_id,
        retired_blob_ids
    ) values (v_org, p_review_id, v_source_id, p_target_candidate_id,
        v_actor, p_expected_source_version, p_expected_target_version,
        v_email_id, v_retired);

    set constraints applications_source_fk, candidate_identifiers_source_fk,
        documents_blob_fk, documents_source_fk, documents_supersedes_fk,
        application_documents_application_fk, application_documents_document_fk,
        candidates_current_document_fk, file_blobs_candidate_fk,
        file_blobs_retired_into_fk immediate;
    return pg_catalog.jsonb_build_object('targetCandidateId', p_target_candidate_id,
        'sourceCandidateId', v_source_id, 'replayed', false);
end
$$;
create or replace function app.profile_search_worker_fail_v1(p_token text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
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
 perform app.profile_search_lock_v1();
 select * into s from app.profile_search_sources where id=(p->>'jobId')::uuid for update;
 if not found or s.lease_kind is distinct from p->>'kind' or s.lease_token is distinct from (p->>'leaseToken')::uuid or s.lease_worker_id<>w or s.lease_expires_at<=now() then raise exception 'Source changed' using errcode='40001'; end if;
 terminal:=terminal or s.attempts>=5;
 update app.profile_search_sources set status=case when terminal then 'failed' when manifest_sha256 is null then 'queued' else 'embedding' end,error_code=code,lease_token=null,lease_expires_at=null,available_at=now()+make_interval(secs=>delay) where id=s.id;
 if s.component='cv' then perform app.cv_search_growth_v1();else perform app.profile_search_epoch_v1(s.organization_id,s.owner_user_id);end if;
 end if;
 return jsonb_build_object('ok',true);
end $$;
do $$ declare f record;begin
 for f in select oid::regprocedure sig from pg_proc where pronamespace='app'::regnamespace and proname like 'cv_search_%' loop execute format('revoke all on function %s from public',f.sig);end loop;
end $$;
revoke all on function app.profile_search_worker_claim_v1(text,boolean,boolean),app.profile_search_worker_source_v1(text,uuid,bigint,text,text) from public;
grant execute on function app.cv_search_status_v1(text,boolean,uuid,jsonb,boolean) to app_staff;
grant execute on function app.profile_search_worker_claim_v1(text,boolean,boolean),app.profile_search_worker_source_v1(text,uuid,bigint,text,text) to app_telegram_worker;
reset role;set local role app_owner;
revoke create on schema app from app_executor;revoke trigger on app.candidates,app.documents,app.file_blobs,app.candidate_reviewed_cv_text,app.profile_search_chunks from app_executor;
reset role;
-- The measured model change is a new global vector space. Never mix equal-
-- dimensional vectors from different models or allow old workers to publish.
update app.telegram_workers set last_search_seen_at=null;
update app.profile_search_queries set status='failed',error_code='INDEX_CHANGED',embedding=null,receipt=null,receipt_digest=null,lease_token=null,lease_expires_at=null,coverage=null,capacity=null where status not in('cancelled','expired');
delete from app.profile_search_results;
delete from app.profile_search_chunks;
alter table app.profile_search_chunks drop constraint profile_search_chunks_token_count_check;
alter table app.profile_search_chunks add constraint profile_search_chunks_token_count_check check(token_count between 1 and 128);
update app.profile_search_sources set revision=revision+1,status=case when status='retired' then 'retired' else 'queued' end,projection_text=null,source_sha256=case when component='cv' then source_sha256 else null end,manifest_sha256=null,error_code=null,lease_token=null,lease_worker_id=null,lease_expires_at=null,lease_kind=null,lease_ordinals=null,receipt_token=null,receipt_digest=null,receipt=null,attempts=0,available_at=now();
update app.profile_search_epochs set revision=revision+1;
-- Metadata-only queue backfill; trigger derives exact approved document binding.
update app.candidate_reviewed_cv_text set reviewed_at=reviewed_at;
commit;
