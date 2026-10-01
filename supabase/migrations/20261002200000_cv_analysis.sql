begin;
set local lock_timeout='2s'; set local statement_timeout='30s';
set local role app_owner;
create table app.cv_analyses(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,owner_user_id uuid not null,draft_id uuid not null,
 approved_document_id uuid,document_revision bigint not null,document_sha256 text not null check(document_sha256~'^[0-9a-f]{64}$'),size_bytes integer not null check(size_bytes between 1 and 4194304),filename text not null,extension text not null check(extension in('pdf','docx')),object_key text not null,
 extraction_job_id uuid references app.telegram_extraction_jobs(id),
 stage text not null default 'parse' check(stage in('parse','facts')),status text not null default 'queued' check(status in('queued','leased','waiting','failed','completed','cancelled')),
 parser_version text not null default 'pdfjs-6.2.108-docx-xml-0.8.15-v1',prompt_version text not null default 'cv-facts-prompt-v1',
 blocks jsonb check(blocks is null or (jsonb_typeof(blocks)='array' and jsonb_array_length(blocks)<=2000 and octet_length(blocks::text)<=1200000)),text_sha256 text,text_byte_length integer not null default 0 check(text_byte_length between 0 and 65536),block_count integer not null default 0,
 text_decision text not null default 'pending' check(text_decision in('pending','include','exclude')),issues jsonb not null default '[]',metadata jsonb,
 attempts integer not null default 0,available_at timestamptz not null default now(),lease_token uuid,lease_worker_id uuid references app.telegram_workers(id),lease_expires_at timestamptz,error_code text,
 source_digest bytea,parse_source_digest bytea,parse_digest bytea,parse_receipt jsonb,facts_source_digest bytea,facts_digest bytea,facts_receipt jsonb,fail_lease_token uuid,fail_digest bytea,
 version bigint not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),cleanup_due_at timestamptz,purged_at timestamptz,
 unique(draft_id,document_revision),unique(organization_id,owner_user_id,id),foreign key(organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id)
);
create index cv_analysis_claim_idx on app.cv_analyses(organization_id,owner_user_id,available_at,created_at,id) where status in('queued','waiting','leased');
create index cv_analysis_draft_idx on app.cv_analyses(draft_id,created_at desc,id desc);
create index cv_analysis_source_idx on app.cv_analyses(extraction_job_id,status);
create index cv_analysis_cleanup_idx on app.cv_analyses(organization_id,owner_user_id,cleanup_due_at,id) where purged_at is null and cleanup_due_at is not null;
create table app.cv_analysis_proposals(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,owner_user_id uuid not null,analysis_id uuid not null,draft_id uuid not null,
 field text not null check(field in('firstName','lastName','primaryEmail','secondaryEmails','headline','location','professionalUrl','professionalSummary','compensationPreference')),
 suggested_value jsonb not null,evidence jsonb not null check(jsonb_typeof(evidence)='array' and jsonb_array_length(evidence) between 1 and 3),status text not null check(status in('pending','applied','dismissed')),created_at timestamptz not null default now(),
 unique(analysis_id,field),foreign key(organization_id,owner_user_id,analysis_id) references app.cv_analyses(organization_id,owner_user_id,id),foreign key(organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id)
);
create index cv_analysis_proposals_draft_idx on app.cv_analysis_proposals(draft_id,id) where status='pending';
create table app.cv_bootstraps(
 organization_id uuid not null,owner_user_id uuid not null,extraction_job_id uuid not null,message_id text not null,attachment_index integer not null,draft_id uuid not null,cv_job_id uuid references app.telegram_cv_jobs(id),
 primary key(organization_id,owner_user_id,extraction_job_id,message_id,attachment_index),foreign key(organization_id,owner_user_id,extraction_job_id) references app.telegram_extraction_jobs(organization_id,owner_user_id,id),foreign key(organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id)
);
create index cv_bootstrap_draft_idx on app.cv_bootstraps(draft_id);
create table app.cv_analysis_operations(organization_id uuid not null,owner_user_id uuid not null,operation_id uuid not null,request_digest bytea not null,draft_id uuid not null,analysis_id uuid,primary key(organization_id,owner_user_id,operation_id));
create table app.candidate_reviewed_cv_text(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null,candidate_id uuid not null,document_id uuid not null,document_sha256 text not null,parser_version text not null,text_sha256 text not null,blocks jsonb not null,text_content text not null check(octet_length(text_content)<=65536),reviewed_by uuid not null,reviewed_at timestamptz not null default now(),
 unique(candidate_id,document_id),foreign key(organization_id,candidate_id) references app.candidates(organization_id,id) on delete cascade,foreign key(document_id) references app.documents(id) on delete cascade
);
do $$ declare t text; begin
 foreach t in array array['cv_analyses','cv_analysis_proposals','cv_bootstraps','cv_analysis_operations'] loop
 execute format('alter table app.%I enable row level security',t); execute format('alter table app.%I force row level security',t);
 execute format('grant select,insert,update,delete on app.%I to app_executor',t);
 execute format('create policy cv_analysis_owner on app.%I for all to app_executor using(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id'')) with check(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id''))',t);
 end loop;
end $$;
alter table app.candidate_reviewed_cv_text enable row level security;alter table app.candidate_reviewed_cv_text force row level security;
grant select,insert on app.candidate_reviewed_cv_text to app_executor;
create policy reviewed_cv_select on app.candidate_reviewed_cv_text for select to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and app.has_permission_v1('documents.download') and app.has_permission_v1('candidates.read') and exists(select 1 from app.candidates c join app.documents d on d.id=candidate_reviewed_cv_text.document_id where c.id=candidate_reviewed_cv_text.candidate_id and c.current_document_id=d.id and c.lifecycle='active' and d.lifecycle='active'));
create policy reviewed_cv_insert on app.candidate_reviewed_cv_text for insert to app_executor with check(organization_id=app.context_uuid_v1('app.organization_id') and reviewed_by=app.context_uuid_v1('app.actor_id') and app.has_permission_v1('documents.download') and app.has_permission_v1('candidates.write'));
grant trigger on app.telegram_drafts,app.telegram_cv_jobs,app.cv_analyses,app.cv_analysis_proposals to app_executor;
grant create on schema app to app_executor;
reset role;set local role app_executor;
create function app.cv_analysis_actor_v1() returns void language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ begin perform app.recruitment_actor_v1(array['candidates.read','candidates.write','documents.download'],null,null,false); end $$;
create function app.cv_analysis_required_v1(d app.telegram_drafts) returns boolean language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select exists(select 1 from app.cv_analyses a where a.draft_id=d.id and a.document_revision=d.document_revision and (a.status in('queued','leased','waiting','failed')))
 or exists(select 1 from app.cv_analysis_proposals where draft_id=d.id and status='pending')
$$;
create function app.cv_analysis_json_v1(a app.cv_analyses,d app.telegram_drafts) returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('id',a.id,'draftId',a.draft_id,'documentRevision',a.document_revision,'documentSha256',a.document_sha256,'filename',a.filename,'stage',a.stage,'status',a.status,'errorCode',a.error_code,'attempts',a.attempts,'availableAt',a.available_at,'version',a.version,'textDecision',a.text_decision,'blockCount',a.block_count,'textByteLength',a.text_byte_length,'pendingProposalCount',(select count(*) from app.cv_analysis_proposals where analysis_id=a.id and status='pending'),'issues',a.issues,'canRetry',a.status in('failed','cancelled') and d.status in('pending','snoozed','duplicate') and d.document_revision=a.document_revision and d.document->>'sha256'=a.document_sha256 and a.facts_receipt is null)
$$;
create function app.cv_analysis_source_v1(a app.cv_analyses) returns jsonb language sql immutable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('draftId',a.draft_id,'documentRevision',a.document_revision,'documentSha256',a.document_sha256,'sizeBytes',a.size_bytes,'filename',a.filename,'extension',a.extension,'parserVersion',a.parser_version,'promptVersion',a.prompt_version,'blocks',case when a.stage='facts' then a.blocks else null end)
$$;
create function app.cv_analysis_enqueue_v1(p_draft uuid,p_revision bigint,p_source uuid default null) returns app.cv_analyses language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts;a app.cv_analyses;begin
 select * into d from app.telegram_drafts where id=p_draft for update;
 if not found or d.status not in('pending','snoozed','duplicate') or d.document_revision<>p_revision or d.document is null then raise exception 'CV changed' using errcode='40001';end if;
 select * into a from app.cv_analyses where draft_id=d.id and document_revision=p_revision;
 if found then return a;end if;
 insert into app.cv_analyses(organization_id,owner_user_id,draft_id,document_revision,document_sha256,size_bytes,filename,extension,object_key,extraction_job_id)
 values(d.organization_id,d.owner_user_id,d.id,d.document_revision,d.document->>'sha256',(d.document->>'sizeBytes')::integer,d.document->>'filename',d.document->>'extension',d.document->>'objectKey',coalesce(p_source,(select extraction_job_id from app.telegram_cv_jobs where draft_id=d.id and status='completed' and receipt->>'documentRevision'=d.document_revision::text order by created_at desc limit 1))) returning * into a;
 update app.cv_analyses set source_digest=sha256(convert_to(app.cv_analysis_source_v1(a)::text,'UTF8')) where id=a.id returning * into a;
 return a;
end $$;
create function app.cv_analysis_guard_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.cv_analyses;c app.candidates;old_org text:=current_setting('app.organization_id',true);old_actor text:=current_setting('app.actor_id',true);begin
 perform set_config('app.organization_id',old.organization_id::text,true);perform set_config('app.actor_id',old.owner_user_id::text,true);
 if old.status is distinct from new.status and new.status='approved' then
 select * into strict c from app.candidates where id=new.approved_candidate_id;
 update app.cv_analyses set approved_document_id=c.current_document_id where draft_id=old.id and document_revision=old.document_revision;
 if app.cv_analysis_required_v1(old) then raise exception 'Review or skip CV analysis before approval' using errcode='23514';end if;
 for a in select * from app.cv_analyses where draft_id=old.id and document_revision=old.document_revision and status='completed' and text_decision='include' loop
 perform app.cv_analysis_actor_v1();select * into strict c from app.candidates where id=new.approved_candidate_id;
 insert into app.candidate_reviewed_cv_text(organization_id,candidate_id,document_id,document_sha256,parser_version,text_sha256,blocks,text_content,reviewed_by)
 values(old.organization_id,c.id,c.current_document_id,a.document_sha256,a.parser_version,a.text_sha256,a.blocks,(select string_agg(value->>'text',E'\n\n' order by (value->>'ordinal')::integer) from jsonb_array_elements(a.blocks)),old.owner_user_id);
 end loop;
 end if;
 if old.document is distinct from new.document or new.status in('approved','discarded') then
 update app.cv_analyses set status=case when status='completed' then status else 'cancelled' end,error_code=case when status='completed' then error_code else 'DRAFT_DOCUMENT_CHANGED' end,lease_expires_at=null,text_decision=case when status='completed' and new.status='approved' then text_decision else 'exclude' end,version=version+1,updated_at=now(),cleanup_due_at=now() where draft_id=old.id;
 update app.cv_analysis_proposals set status='dismissed' where draft_id=old.id and status='pending';
 perform app.telegram_maintenance_schedule_v1(now());
 end if;perform set_config('app.organization_id',coalesce(old_org,''),true);perform set_config('app.actor_id',coalesce(old_actor,''),true);return new;
end $$;
create trigger cv_analysis_document_guard before update of document,status on app.telegram_drafts for each row execute function app.cv_analysis_guard_v1();
create function app.cv_analysis_retrieved_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 if new.status='completed' and new.receipt is not null and old.receipt is distinct from new.receipt and exists(select 1 from app.cv_bootstraps where cv_job_id=new.id) then
 perform app.cv_analysis_actor_v1();perform app.cv_analysis_enqueue_v1(new.draft_id,(new.receipt->>'documentRevision')::bigint,new.extraction_job_id);
 end if;return new;
end $$;
create trigger cv_analysis_retrieved after update of receipt on app.telegram_cv_jobs for each row execute function app.cv_analysis_retrieved_v1();
create function app.cv_analysis_status_v1(p_draft uuid,p_analysis uuid,p_after uuid,p_proposal uuid,p_block integer) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts;a app.cv_analyses;cur app.cv_analyses;rows jsonb;props jsonb;next_id uuid;next_prop uuid;blocks_json jsonb;next_block integer;cursor_time timestamptz;begin
 perform app.cv_analysis_actor_v1();
 if p_analysis is not null then
 select * into a from app.cv_analyses where id=p_analysis;if not found then raise exception 'Analysis unavailable' using errcode='P0002';end if;
 select * into strict d from app.telegram_drafts where id=a.draft_id;
 if not app.cv_analysis_text_visible_v1(a,d) then a.blocks:=null;end if;
 with q as(select value from jsonb_array_elements(coalesce(a.blocks,'[]')) where (value->>'ordinal')::integer>coalesce(p_block,-1) order by (value->>'ordinal')::integer limit 51),n as(select value,row_number() over() rn from q)
 select coalesce(jsonb_agg(value order by (value->>'ordinal')::integer) filter(where rn<=50),'[]'),case when count(*)>50 then (array_agg((value->>'ordinal')::integer order by rn))[50] end into blocks_json,next_block from n;
 return jsonb_build_object('analysis',app.cv_analysis_json_v1(a,d),'blocks',blocks_json,'nextBlockAfter',next_block,'textAvailable',a.blocks is not null);
 end if;
 select * into d from app.telegram_drafts where id=p_draft;if not found then raise exception 'Draft unavailable' using errcode='P0002';end if;
 select * into cur from app.cv_analyses where draft_id=d.id and document_revision=d.document_revision;
 if p_after is not null then select created_at into cursor_time from app.cv_analyses where id=p_after and draft_id=d.id;if not found then raise exception 'Cursor unavailable' using errcode='P0002';end if;end if;
 with q as(select id,created_at from app.cv_analyses where draft_id=d.id and (id=cur.id and p_after is null or id is distinct from cur.id and (p_after is null or (created_at,id)<(cursor_time,p_after))) order by (id=cur.id) desc nulls last,created_at desc,id desc limit 21),n as(select *,row_number() over() rn from q)
 select coalesce(jsonb_agg(app.cv_analysis_json_v1(t,d) order by n.rn) filter(where n.rn<=20),'[]'),case when count(*)>20 then (array_agg(t.id order by n.rn))[20] end into rows,next_id from n join app.cv_analyses t on t.id=n.id;
 with q as(select * from app.cv_analysis_proposals where draft_id=d.id and status='pending' and (p_proposal is null or id>p_proposal) order by id limit 51),n as(select *,row_number() over(order by id) rn from q)
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'analysisId',p.analysis_id,'draftId',p.draft_id,'field',p.field,'currentValue',d.fields->p.field,'suggestedValue',p.suggested_value,'evidence',p.evidence,'documentSha256',joined.document_sha256,'createdAt',p.created_at) order by p.id) filter(where p.rn<=50),'[]'),case when count(*)>50 then (array_agg(p.id order by p.id))[50] end into props,next_prop from n p join app.cv_analyses joined on joined.id=p.analysis_id;
 return jsonb_build_object('draftId',d.id,'documentRevision',d.document_revision,'canAnalyze',d.status in('pending','snoozed','duplicate') and d.document is not null and cur.id is null,'analysisReviewRequired',app.cv_analysis_required_v1(d),'current',case when cur.id is null then null else app.cv_analysis_json_v1(cur,d) end,'jobs',rows,'nextAfter',next_id,'proposals',props,'nextProposalAfter',next_prop);
end $$;
create function app.cv_analysis_action_v1(p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.cv_analyses;d app.telegram_drafts;r app.cv_analysis_proposals;op app.cv_analysis_operations;digest bytea;begin
 perform app.cv_analysis_actor_v1();
 if p->>'action'='analyze' then
 select * into d from app.telegram_drafts where id=(p->>'draftId')::uuid for update;if not found then raise exception 'Draft unavailable' using errcode='P0002';end if;
 digest:=sha256(convert_to(p::text,'UTF8'));select * into op from app.cv_analysis_operations where operation_id=(p->>'operationId')::uuid;
 if found then if op.request_digest<>digest then raise exception 'Operation changed' using errcode='40001';end if;select * into strict a from app.cv_analyses where id=op.analysis_id;
 else a:=app.cv_analysis_enqueue_v1(d.id,(p->>'expectedDocumentRevision')::bigint);
 insert into app.cv_analysis_operations values(d.organization_id,d.owner_user_id,(p->>'operationId')::uuid,digest,d.id,a.id);end if;
 else
 select * into a from app.cv_analyses where id=(p->>'analysisId')::uuid;if not found then raise exception 'Analysis unavailable' using errcode='P0002';end if;
 select * into d from app.telegram_drafts where id=a.draft_id for update;select * into a from app.cv_analyses where id=a.id for update;
 if p->>'action'='resolve' then
 select * into r from app.cv_analysis_proposals where id=(p->>'proposalId')::uuid and analysis_id=a.id for update;
 if not found or r.status<>'pending' or d.version is distinct from (p->>'expectedDraftVersion')::bigint then raise exception 'Suggestion changed' using errcode='40001';end if;
 if p->>'decision'='apply' then
 if d.status not in('pending','snoozed','duplicate') or d.document_revision<>a.document_revision then raise exception 'Draft changed' using errcode='40001';end if;
 perform app.telegram_update_draft_v1(d.id,d.version,jsonb_set(d.fields,array[r.field],r.suggested_value,true));
 elsif p->>'decision'<>'dismiss' or p->>'decision' is null then raise exception 'Invalid decision' using errcode='22023';end if;
 update app.cv_analysis_proposals set status=case when p->>'decision'='apply' then 'applied' else 'dismissed' end where id=r.id;
 update app.telegram_drafts set version=version+1,updated_at=now() where id=d.id;
 return jsonb_build_object('draft',app.telegram_get_draft_v1(d.id));
 end if;
 if a.version is distinct from (p->>'expectedAnalysisVersion')::bigint or d.status not in('pending','snoozed','duplicate') or d.document_revision<>a.document_revision or d.document->>'sha256' is distinct from a.document_sha256 then raise exception 'Analysis changed' using errcode='40001';end if;
 if p->>'action'='cancel' and a.status in('queued','leased','waiting','failed') then
 update app.cv_analyses set status='cancelled',text_decision='exclude',lease_expires_at=null,error_code='CANCELLED',version=version+1,updated_at=now() where id=a.id returning * into a;
 elsif p->>'action'='retry' and a.status in('failed','cancelled') and a.facts_receipt is null then
 update app.cv_analyses set status='queued',text_decision='pending',attempts=0,lease_token=null,lease_expires_at=null,error_code=null,available_at=now(),version=version+1,updated_at=now() where id=a.id returning * into a;
 elsif p->>'action'='reviewText' and a.status='completed' and a.blocks is not null and p->>'decision' in('include','exclude') then
 update app.cv_analyses set text_decision=p->>'decision',version=version+1,updated_at=now() where id=a.id returning * into a;
 else raise exception 'Analysis action unavailable' using errcode='40001';end if;
 end if;
 return jsonb_build_object('analysis',app.cv_analysis_json_v1(a,d));
end $$;
create function app.cv_analysis_worker_v1(p_token text) returns uuid language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ declare w uuid;begin w:=app.telegram_worker_context_v1(p_token);perform app.cv_analysis_actor_v1();perform set_config('app.cv_worker_id',w::text,true);return w;end $$;
create function app.cv_analysis_claim_v1(p_token text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare w uuid;a app.cv_analyses;d app.telegram_drafts;pick record;begin
 w:=app.cv_analysis_worker_v1(p_token);
 update app.cv_analyses set status='failed',error_code='ATTEMPTS_EXHAUSTED',lease_expires_at=null,version=version+1 where status='leased' and lease_expires_at<=clock_timestamp() and attempts>=5;
 for pick in select id,draft_id from app.cv_analyses where attempts<5 and ((status in('queued','waiting') and available_at<=now()) or status='leased' and lease_expires_at<=clock_timestamp()) order by available_at,created_at,id limit 20 loop
 select * into d from app.telegram_drafts where id=pick.draft_id for update skip locked;if not found then continue;end if;
 select * into a from app.cv_analyses where id=pick.id for update skip locked;if not found then continue;end if;
 if d.status not in('pending','snoozed','duplicate') or d.document_revision<>a.document_revision or d.document->>'sha256' is distinct from a.document_sha256 then update app.cv_analyses set status='cancelled',text_decision='exclude',error_code='DRAFT_DOCUMENT_CHANGED',version=version+1 where id=a.id;continue;end if;
 if not (a.status in('queued','waiting') and a.available_at<=now() or a.status='leased' and a.lease_expires_at<=clock_timestamp()) then continue;end if;
 update app.cv_analyses set status='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_worker_id=w,lease_expires_at=clock_timestamp()+interval '120 seconds',error_code=null,version=version+1,updated_at=now() where id=a.id returning * into a;
 return jsonb_build_object('job',jsonb_build_object('id',a.id,'leaseToken',a.lease_token,'leaseExpiresAt',a.lease_expires_at,'stage',a.stage,'sourceDigest',encode(a.source_digest,'hex'),'source',app.cv_analysis_source_v1(a)));
 end loop;return jsonb_build_object('job',null);
end $$;
create function app.cv_analysis_lock_v1(p_job uuid,p_lease uuid,p_digest text) returns app.cv_analyses language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare a app.cv_analyses;d app.telegram_drafts;begin
 select * into a from app.cv_analyses where id=p_job;if not found then raise exception 'Analysis unavailable' using errcode='P0002';end if;
 select * into d from app.telegram_drafts where id=a.draft_id for update;select * into a from app.cv_analyses where id=a.id for update;
 if a.lease_worker_id is distinct from nullif(current_setting('app.cv_worker_id',true),'')::uuid or a.status<>'leased' or a.lease_token is distinct from p_lease or a.lease_expires_at<=clock_timestamp() or encode(a.source_digest,'hex') is distinct from p_digest or d.status not in('pending','snoozed','duplicate') or d.document_revision<>a.document_revision or d.document->>'sha256' is distinct from a.document_sha256 then raise exception 'Analysis changed' using errcode='40001';end if;
 return a;
end $$;
create function app.cv_analysis_content_v1(p_token text,p_job uuid,p_lease uuid,p_digest text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare a app.cv_analyses;begin
 perform app.cv_analysis_worker_v1(p_token);a:=app.cv_analysis_lock_v1(p_job,p_lease,p_digest);if a.stage<>'parse' then raise exception 'Parse changed' using errcode='40001';end if;
 return jsonb_build_object('objectKey',a.object_key,'sha256',a.document_sha256,'sizeBytes',a.size_bytes,'filename',a.filename);
end $$;
create function app.cv_analysis_source_read_v1(p_token text,p_job uuid,p_lease uuid,p_digest text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare a app.cv_analyses;begin perform app.cv_analysis_worker_v1(p_token);a:=app.cv_analysis_lock_v1(p_job,p_lease,p_digest);return app.cv_analysis_source_v1(a);end $$;
create function app.cv_analysis_receipt_v1(p_token text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare a app.cv_analyses;digest bytea;receipt jsonb;begin
 perform app.cv_analysis_worker_v1(p_token);select * into a from app.cv_analyses where id=(p->>'jobId')::uuid;if not found then raise exception 'Analysis unavailable' using errcode='P0002';end if;
 digest:=sha256(convert_to(jsonb_build_object('stage',p->'stage','result',p->'result','metadata',p->'metadata')::text,'UTF8'));
 if p->>'stage'='parse' then
 receipt:=a.parse_receipt;if receipt is not null and (a.parse_digest is distinct from digest or encode(a.parse_source_digest,'hex') is distinct from p->>'sourceDigest') then raise exception 'Result changed' using errcode='40001';end if;
 elsif p->>'stage'='facts' then
 receipt:=a.facts_receipt;if receipt is not null and (a.facts_digest is distinct from digest or encode(a.facts_source_digest,'hex') is distinct from p->>'sourceDigest') then raise exception 'Result changed' using errcode='40001';end if;
 else raise exception 'Invalid stage' using errcode='22023';end if;return receipt;
end $$;
create function app.cv_analysis_parse_valid_v1(p jsonb,a app.cv_analyses) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$
declare b jsonb;n integer:=0;full_text text:='';part text:='';para integer:=0;rank text;prior_rank text:='';begin
 if jsonb_typeof(p) is distinct from 'object' or not(p ?& array['parserVersion','documentSha256','textSha256','blocks']) or p-array['parserVersion','documentSha256','textSha256','blocks']<>'{}' or p->>'parserVersion' is distinct from a.parser_version or p->>'documentSha256' is distinct from a.document_sha256 or jsonb_typeof(p->'blocks') is distinct from 'array' or jsonb_array_length(p->'blocks') not between 1 and 2000 or octet_length(p::text)>1200000 then return false;end if;
 for b in select value from jsonb_array_elements(p->'blocks') loop
 if not(b ?& array['ordinal','kind','text','sha256']) or (b->>'ordinal')::integer is distinct from n or jsonb_typeof(b->'text') is distinct from 'string' or strpos(b->>'text',E'\r')>0 or b->>'sha256' is distinct from encode(sha256(convert_to(b->>'text','UTF8')),'hex') then return false;end if;
 if a.extension='pdf' then
 if not(b ?& array['ordinal','kind','page','text','sha256']) or b-array['ordinal','kind','page','text','sha256']<>'{}' or b->>'kind' is distinct from 'pdf_page' or (b->>'page')::integer is distinct from n+1 or jsonb_array_length(p->'blocks')>50 then return false;end if;
 else
 if not(b ?& array['ordinal','kind','part','paragraph','text','sha256']) or b-array['ordinal','kind','part','paragraph','text','sha256']<>'{}' or b->>'kind' is distinct from 'docx_paragraph' or jsonb_typeof(b->'part') is distinct from 'string' or (b->>'part') !~ '^word/(document|(header|footer)([1-9][0-9]?|100)|footnotes|endnotes)\.xml$' then return false;end if;
 if part is distinct from b->>'part' then
 rank:=case b->>'part' when 'word/document.xml' then '0' when 'word/footnotes.xml' then '2' when 'word/endnotes.xml' then '3' else '1'||(b->>'part') end;
 if part='' and b->>'part'<>'word/document.xml' or part<>'' and rank<=prior_rank then return false;end if;
 part:=b->>'part';prior_rank:=rank;para:=0;end if;
 para:=para+1;if (b->>'paragraph')::integer is distinct from para then return false;end if;
 end if;
 full_text:=full_text||case when n=0 then '' else E'\n\n' end||(b->>'text');n:=n+1;
 end loop;
 return full_text ~ '[^[:space:]]' and octet_length(full_text)<=65536 and p->>'textSha256'=encode(sha256(convert_to(full_text,'UTF8')),'hex');
 exception when others then return false;
end $$;
create function app.cv_analysis_facts_valid_v1(p jsonb,blocks jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog,app,pg_temp as $$
declare f jsonb;e jsonb;b jsonb;v jsonb;k text;quotes text[];fields text[]:='{}';begin
 if jsonb_typeof(p) is distinct from 'object' or not(p ?& array['facts','issues']) or p-array['facts','issues']<>'{}' or jsonb_typeof(p->'facts') is distinct from 'array' or jsonb_array_length(p->'facts')>12 or jsonb_typeof(p->'issues') is distinct from 'array' or jsonb_array_length(p->'issues')>3 or octet_length(p::text)>150000 then return false;end if;
 if exists(select 1 from jsonb_array_elements_text(p->'issues') q where q is null or q not in('NOT_A_CV','MULTIPLE_PEOPLE','NO_CANDIDATE_INFORMATION')) or (select count(distinct value) from jsonb_array_elements(p->'issues'))<>jsonb_array_length(p->'issues') or jsonb_array_length(p->'issues')>0 and jsonb_array_length(p->'facts')>0 then return false;end if;
 for f in select value from jsonb_array_elements(p->'facts') loop
 k:=f->>'field';if not(f ?& array['field','value','evidence']) or k is null or k=any(fields) or k in('telegramUserId','telegramUsername') or app.telegram_extraction_value_v1(k,f->'value') is not true or f-array['field','value','evidence']<>'{}' or jsonb_typeof(f->'evidence') is distinct from 'array' or jsonb_array_length(f->'evidence') not between 1 and 3 then return false;end if;
 fields:=array_append(fields,k);quotes:='{}';
 for e in select value from jsonb_array_elements(f->'evidence') loop
 b:=blocks->((e->>'blockOrdinal')::integer);
 if not(e ?& array['blockOrdinal','startByte','endByte','quote']) or e-array['blockOrdinal','startByte','endByte','quote']<>'{}' or (e->>'blockOrdinal')::integer not between 0 and 1999 or jsonb_typeof(e->'quote') is distinct from 'string' or b is null or (e->>'startByte')::integer<0 or (e->>'endByte')::integer<=(e->>'startByte')::integer or (e->>'endByte')::integer>octet_length(b->>'text') or char_length(e->>'quote') not between 1 and 2000 or octet_length(e->>'quote')>8000 or convert_to(e->>'quote','UTF8') is distinct from substring(convert_to(b->>'text','UTF8') from (e->>'startByte')::integer+1 for (e->>'endByte')::integer-(e->>'startByte')::integer) then return false;end if;
 quotes:=array_append(quotes,lower(e->>'quote'));
 end loop;
 if k in('firstName','lastName','primaryEmail','secondaryEmails') then
 for v in select value from jsonb_array_elements(case when k='secondaryEmails' then f->'value' else jsonb_build_array(f->'value') end) loop
 if not exists(select 1 from unnest(quotes) q where strpos(q,lower(v#>>'{}'))>0) then return false;end if;end loop;
 end if;
 end loop;return true;
 exception when others then return false;
end $$;
create function app.cv_analysis_complete_v1(p_token text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.cv_analyses;d app.telegram_drafts;receipt jsonb;digest bytea;f jsonb;current_fields jsonb;v jsonb;k text;s text;pending integer:=0;changed boolean:=false;begin
 receipt:=app.cv_analysis_receipt_v1(p_token,p);if receipt is not null then return receipt;end if;
 a:=app.cv_analysis_lock_v1((p->>'jobId')::uuid,(p->>'leaseToken')::uuid,p->>'sourceDigest');
 if a.stage is distinct from p->>'stage' then raise exception 'Stage changed' using errcode='40001';end if;
 digest:=sha256(convert_to(jsonb_build_object('stage',p->'stage','result',p->'result','metadata',p->'metadata')::text,'UTF8'));
 if a.stage='parse' then
 if app.cv_analysis_parse_valid_v1(p->'result',a) is not true then raise exception 'Invalid parsed document' using errcode='22023';end if;
 receipt:=jsonb_build_object('ok',true,'analysisId',a.id,'stage','parse','nextStage','facts');
 update app.cv_analyses set blocks=p#>'{result,blocks}',block_count=jsonb_array_length(p#>'{result,blocks}'),text_sha256=p#>>'{result,textSha256}',text_byte_length=(select octet_length(string_agg(value->>'text',E'\n\n' order by (value->>'ordinal')::integer)) from jsonb_array_elements(p#>'{result,blocks}')),parse_source_digest=source_digest,parse_digest=digest,parse_receipt=receipt,stage='facts',status='queued',attempts=0,available_at=now(),lease_token=null,lease_expires_at=null,version=version+1,updated_at=now() where id=a.id returning * into a;
 update app.cv_analyses set source_digest=sha256(convert_to(app.cv_analysis_source_v1(a)::text,'UTF8')) where id=a.id;
 else
 if app.cv_analysis_facts_valid_v1(p->'result',a.blocks) is not true or not((p->'metadata') ?& array['model','promptVersion','reportedModel']) or (p->'metadata')-array['model','promptVersion','reportedModel']<>'{}' or jsonb_typeof(p#>'{metadata,model}') is distinct from 'string' or p#>>'{metadata,model}' !~ '^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,119}$' or strpos(p#>>'{metadata,model}','://')>0 or p#>>'{metadata,promptVersion}' is distinct from a.prompt_version or jsonb_typeof(p->'metadata') is distinct from 'object' or octet_length((p->'metadata')::text)>2000 or (p#>'{metadata,reportedModel}'<>'null'::jsonb and (jsonb_typeof(p#>'{metadata,reportedModel}') is distinct from 'string' or p#>>'{metadata,reportedModel}' !~ '^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,119}$' or strpos(p#>>'{metadata,reportedModel}','://')>0)) then raise exception 'Invalid CV facts' using errcode='22023';end if;
 select * into strict d from app.telegram_drafts where id=a.draft_id;current_fields:=d.fields;
 for f in select value from jsonb_array_elements(p#>'{result,facts}') loop
 k:=f->>'field';v:=f->'value';s:='applied';
 if current_fields->k is not distinct from v then null;
 elsif not k=any(d.human_fields) and (current_fields->k is null or current_fields->k in('null'::jsonb,'""'::jsonb,'[]'::jsonb)) and not(k='primaryEmail' and coalesce(current_fields->'secondaryEmails','[]') @> jsonb_build_array(v)) and not(k='secondaryEmails' and v @> jsonb_build_array(current_fields->'primaryEmail')) then current_fields:=jsonb_set(current_fields,array[k],v,true);changed:=true;
 else s:='pending';pending:=pending+1;end if;
 insert into app.cv_analysis_proposals(organization_id,owner_user_id,analysis_id,draft_id,field,suggested_value,evidence,status) values(a.organization_id,a.owner_user_id,a.id,d.id,k,v,f->'evidence',s);
 end loop;
 if changed then update app.telegram_drafts set fields=current_fields,version=version+1,updated_at=now() where id=d.id returning * into d;end if;
 receipt:=jsonb_build_object('ok',true,'analysisId',a.id,'stage','facts','draftId',d.id,'draftVersion',d.version,'proposalCount',pending);
 update app.cv_analyses set status='completed',issues=p#>'{result,issues}',metadata=p->'metadata',facts_source_digest=source_digest,facts_digest=digest,facts_receipt=receipt,lease_expires_at=null,text_decision='include',version=version+1,updated_at=now() where id=a.id;
 end if;return receipt;
end $$;
create function app.cv_analysis_fail_v1(p_token text,p jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare a app.cv_analyses;digest bytea;code text:=p->>'code';begin
 perform app.cv_analysis_worker_v1(p_token);digest:=sha256(convert_to(p::text,'UTF8'));select * into a from app.cv_analyses where id=(p->>'jobId')::uuid;
 if a.fail_lease_token=(p->>'leaseToken')::uuid then if a.fail_digest<>digest then raise exception 'Failure changed' using errcode='40001';end if;return jsonb_build_object('ok',true);end if;
 a:=app.cv_analysis_lock_v1((p->>'jobId')::uuid,(p->>'leaseToken')::uuid,p->>'sourceDigest');
 if p->>'stage' is distinct from a.stage or code is null or code not in('STORAGE_UNAVAILABLE','PROVIDER_UNAVAILABLE','WORKER_ERROR','INVALID_DOCUMENT','ENCRYPTED_DOCUMENT','OCR_REQUIRED','DOCUMENT_LIMIT','TEXT_LIMIT','INVALID_RESULT','UNSUPPORTED_VERSION') or (p->>'retryAfterSeconds')::integer not between 1 and 3600 then raise exception 'Invalid failure' using errcode='22023';end if;
 update app.cv_analyses set status=case when code in('STORAGE_UNAVAILABLE','PROVIDER_UNAVAILABLE','WORKER_ERROR') and attempts<5 then 'waiting' else 'failed' end,error_code=case when code in('STORAGE_UNAVAILABLE','PROVIDER_UNAVAILABLE','WORKER_ERROR') and attempts>=5 then 'ATTEMPTS_EXHAUSTED' else code end,available_at=now()+make_interval(secs=>(p->>'retryAfterSeconds')::integer),lease_expires_at=null,fail_lease_token=lease_token,fail_digest=digest,version=version+1,updated_at=now() where id=a.id;
 return jsonb_build_object('ok',true);
end $$;
create function app.cv_bootstrap_status_v1(p_job uuid,p_message bigint,p_index integer) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare ex app.telegram_extraction_jobs;c app.telegram_connections;d app.telegram_drafts;rows jsonb;next_cursor text;begin
 perform app.cv_analysis_actor_v1();perform app.recruitment_actor_v1(array['documents.write'],null,null,false);
 select * into ex from app.telegram_extraction_jobs where id=p_job;if not found then raise exception 'Batch unavailable' using errcode='P0002';end if;
 select * into c from app.telegram_connections;d.status:='pending';
 with raw as(select m->>'messageId' mid,(x.n-1)::integer idx,x.value metadata from jsonb_array_elements(coalesce(ex.source->'messages','[]')) m cross join lateral jsonb_array_elements(m->'attachments') with ordinality x(value,n)),chosen as(select * from raw where p_message is null or (mid::bigint,idx)>(p_message,p_index) order by mid::bigint,idx limit 51),n as(select *,row_number() over(order by mid::bigint,idx) rn from chosen),q as(select n.*,
 (select coalesce(jsonb_agg(t.draft_id order by t.draft_id),'[]') from (select distinct draft_id from app.telegram_extraction_attachments where job_id=ex.id and message_id=n.mid and attachment_index=n.idx order by draft_id limit 12) t) ids,
 case when ex.status<>'completed' or ex.source is null then 'SOURCE_UNAVAILABLE' else app.telegram_cv_eligible_v1(metadata,d,ex.source#>>'{chat,accountUserId}',c) end reason from n)
 select coalesce(jsonb_agg(jsonb_build_object('messageId',mid,'attachmentIndex',idx,'filename',metadata->'filename','mimeType',metadata->'mimeType','sizeBytes',metadata->'sizeBytes','documentId',metadata->'id','eligible',reason is null and jsonb_array_length(ids)=0,'reason',case when jsonb_array_length(ids)>0 then 'ALREADY_LINKED' else reason end,'existingDraftIds',ids) order by mid::bigint,idx) filter(where rn<=50),'[]'),case when count(*)>50 then (array_agg(mid||':'||idx order by rn))[50] end into rows,next_cursor from q;
 return jsonb_build_object('extractionJobId',ex.id,'sourceVersion',ex.source_version,'sourceAvailable',ex.source is not null,'connectionIssue',case when c.status is distinct from 'connected' then 'CONNECTION_REQUIRED' when ex.source is not null and ex.source#>>'{chat,accountUserId}' is distinct from c.profile->>'telegramUserId' then 'ACCOUNT_MISMATCH' end,'attachments',rows,'nextAfter',next_cursor);
end $$;
alter function app.telegram_cv_action_v1(jsonb) rename to telegram_cv_action_before_analysis_v1;
revoke all on function app.telegram_cv_action_before_analysis_v1(jsonb) from app_staff;
create function app.telegram_cv_action_v1(p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare ex app.telegram_extraction_jobs;b app.cv_bootstraps;op app.cv_analysis_operations;d app.telegram_drafts;c app.telegram_connections;metadata jsonb;got jsonb;digest bytea;aid uuid;begin
 if p_input->>'action' is distinct from 'createDraft' then return app.telegram_cv_action_before_analysis_v1(p_input);end if;
 perform app.cv_analysis_actor_v1();perform app.recruitment_actor_v1(array['documents.write'],null,null,false);
 -- Match connector account-before-quota order; maintenance never takes account locks.
 select * into c from app.telegram_connections for share;
 perform 1 from app.telegram_history_accounts where connection_id=c.id and account_user_id=c.profile->>'telegramUserId' for update;
 perform app.telegram_extraction_lock_v1();digest:=sha256(convert_to(p_input::text,'UTF8'));
 select * into op from app.cv_analysis_operations where operation_id=(p_input->>'operationId')::uuid;
 if found and op.request_digest<>digest then raise exception 'Operation changed' using errcode='40001';end if;
 select * into b from app.cv_bootstraps where extraction_job_id=(p_input->>'extractionJobId')::uuid and message_id=p_input->>'messageId' and attachment_index=(p_input->>'attachmentIndex')::integer;
 if found then
 select * into strict d from app.telegram_drafts where id=b.draft_id;
 if op.operation_id is null then insert into app.cv_analysis_operations values(b.organization_id,b.owner_user_id,(p_input->>'operationId')::uuid,digest,b.draft_id,null);end if;
 select id into aid from app.cv_analyses where draft_id=d.id order by created_at desc,id desc limit 1;
 return jsonb_build_object('draftId',d.id,'cvJobId',b.cv_job_id,'analysisId',aid,'candidateId',d.approved_candidate_id,'replayed',true);
 end if;
 select * into ex from app.telegram_extraction_jobs where id=(p_input->>'extractionJobId')::uuid for no key update;
 if not found or ex.source is null or ex.status<>'completed' or ex.source_version is distinct from (p_input->>'expectedSourceVersion')::bigint then raise exception 'Source changed' using errcode='40001';end if;
 if exists(select 1 from app.telegram_extraction_attachments where job_id=ex.id and message_id=p_input->>'messageId' and attachment_index=(p_input->>'attachmentIndex')::integer) then raise exception 'Attachment already linked' using errcode='40001';end if;
 select m->'attachments'->((p_input->>'attachmentIndex')::integer) into metadata from jsonb_array_elements(ex.source->'messages') m where m->>'messageId'=p_input->>'messageId';
 d.status:='pending';if metadata is null or app.telegram_cv_eligible_v1(metadata,d,ex.source#>>'{chat,accountUserId}',c) is not null then raise exception 'Attachment unavailable' using errcode='23514';end if;
 d.id:=gen_random_uuid();perform app.telegram_create_draft_v1(d.id,jsonb_build_object('secondaryEmails','[]'::jsonb),left(metadata->>'filename',200));select * into d from app.telegram_drafts where id=d.id for update;
 insert into app.telegram_extraction_attachments(organization_id,owner_user_id,job_id,draft_id,message_id,attachment_index,metadata) values(ex.organization_id,ex.owner_user_id,ex.id,d.id,p_input->>'messageId',(p_input->>'attachmentIndex')::integer,metadata);
 got:=app.telegram_cv_action_before_analysis_v1(jsonb_build_object('action','retrieve','draftId',d.id,'expectedDocumentRevision',d.document_revision,'extractionJobId',ex.id,'messageId',p_input->'messageId','attachmentIndex',p_input->'attachmentIndex'));
 insert into app.cv_bootstraps values(ex.organization_id,ex.owner_user_id,ex.id,p_input->>'messageId',(p_input->>'attachmentIndex')::integer,d.id,(got#>>'{job,id}')::uuid);
 insert into app.cv_analysis_operations values(ex.organization_id,ex.owner_user_id,(p_input->>'operationId')::uuid,digest,d.id,null);
 return jsonb_build_object('draftId',d.id,'cvJobId',got#>'{job,id}','analysisId',null,'candidateId',null,'replayed',false);
end $$;
-- Existing summary fields remain intact; CV provenance is a separate panel.
alter function app.telegram_draft_json_v1(app.telegram_drafts) rename to telegram_draft_json_before_analysis_v1;
create function app.telegram_draft_json_v1(d app.telegram_drafts) returns jsonb language plpgsql stable set search_path=pg_catalog,app,pg_temp as $$ declare base jsonb;n integer;required boolean;begin
 base:=app.telegram_draft_json_before_analysis_v1(d);select count(*) into n from app.cv_analysis_proposals where draft_id=d.id and status='pending';required:=app.cv_analysis_required_v1(d);
 return base||jsonb_build_object('pendingCvProposalCount',n,'pendingProposalCount',coalesce((base->>'pendingProposalCount')::integer,0)+n,'analysisReviewRequired',required,'missingFields',case when required then (base->'missingFields')||'"cvAnalysis"'::jsonb else base->'missingFields' end,'ready',cardinality(app.telegram_missing_v1(d.fields,d.document))=0 and coalesce((base->>'pendingProposalCount')::integer,0)=0 and not required);
end $$;
create function app.cv_reviewed_text_v1(p_candidate uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare result jsonb;begin
 perform app.recruitment_actor_v1(array['candidates.read','documents.download'],null,null,false);
 select jsonb_build_object('candidateId',r.candidate_id,'documentId',r.document_id,'documentSha256',r.document_sha256,'parserVersion',r.parser_version,'textSha256',r.text_sha256,'blocks',r.blocks,'text',r.text_content) into result from app.candidate_reviewed_cv_text r join app.candidates c on c.id=r.candidate_id join app.documents d on d.id=r.document_id where c.id=p_candidate and c.lifecycle='active' and c.current_document_id=d.id and d.lifecycle='active';
 if result is null then raise exception 'Reviewed CV unavailable' using errcode='P0002';end if;return result;
end $$;
create function app.cv_analysis_text_visible_v1(a app.cv_analyses,d app.telegram_drafts) returns boolean language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select d.status<>'approved' or exists(select 1 from app.candidates c join app.documents doc on doc.id=a.approved_document_id where c.id=d.approved_candidate_id and c.lifecycle='active' and c.current_document_id=doc.id and doc.lifecycle='active')
$$;
create function app.cv_analysis_event_v1() returns trigger language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare old_org text:=current_setting('app.organization_id',true);old_actor text:=current_setting('app.actor_id',true);begin
 perform set_config('app.organization_id',new.organization_id::text,true);perform set_config('app.actor_id',new.owner_user_id::text,true);
 if tg_table_name='cv_analyses' then
 if new.cleanup_due_at is not null then perform app.telegram_maintenance_schedule_v1(new.cleanup_due_at);end if;
 else
 update app.cv_analyses set cleanup_due_at=now() where id=new.analysis_id and exists(select 1 from app.telegram_drafts where id=new.draft_id and status in('approved','discarded'));
 end if;
 perform set_config('app.organization_id',coalesce(old_org,''),true);perform set_config('app.actor_id',coalesce(old_actor,''),true);return new;
end $$;
create trigger cv_analysis_cleanup_event after update of cleanup_due_at on app.cv_analyses for each row execute function app.cv_analysis_event_v1();
create trigger cv_analysis_proposal_event after update of status on app.cv_analysis_proposals for each row execute function app.cv_analysis_event_v1();
create function app.cv_analysis_purge_v1(p_id uuid) returns boolean language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$ declare a app.cv_analyses;d app.telegram_drafts;begin
 select * into a from app.cv_analyses where id=p_id;if not found then return false;end if;
 select * into d from app.telegram_drafts where id=a.draft_id for update nowait;select * into a from app.cv_analyses where id=a.id for update nowait;
 if a.purged_at is not null or not(d.status in('approved','discarded') or d.document_revision<>a.document_revision) or a.status in('queued','leased','waiting') or exists(select 1 from app.cv_analysis_proposals where analysis_id=a.id and status='pending') then return false;end if;
 delete from app.cv_analysis_proposals where analysis_id=a.id;
 update app.cv_analyses set blocks=null,object_key='',purged_at=now(),cleanup_due_at=null where id=a.id;return true;
end $$;

create or replace function app.telegram_list_drafts_v1(p_view text,p_missing text,p_query text,p_page integer)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare rows_json jsonb; counts_json jsonb; more boolean;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    if p_view not in ('ready','needs_information','snoozed','duplicates','all') or p_page not between 1 and 10000 or char_length(p_query)>200
        or (p_missing is not null and p_missing not in ('firstName','lastName','primaryEmail','cv','cvAnalysis')) then
        raise exception 'Invalid inbox filter' using errcode='22023';
    end if;
    select jsonb_build_object('ready',count(*) filter(where status='pending' and cardinality(app.telegram_missing_v1(fields,document))=0 and not app.cv_analysis_required_v1(d) and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending')),
        'needs_information',count(*) filter(where status='pending' and ((cardinality(app.telegram_missing_v1(fields,document))>0 or app.cv_analysis_required_v1(d)) or exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending'))),
        'snoozed',count(*) filter(where status='snoozed'),'duplicates',count(*) filter(where status='duplicate'),
        'all',count(*) filter(where status in ('pending','snoozed','duplicate'))) into counts_json from app.telegram_drafts d;
    with filtered as (
        select d.* from app.telegram_drafts d where
            case p_view when 'ready' then status='pending' and cardinality(app.telegram_missing_v1(fields,document))=0 and not app.cv_analysis_required_v1(d) and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending')
            when 'needs_information' then status='pending' and ((cardinality(app.telegram_missing_v1(fields,document))>0 or app.cv_analysis_required_v1(d)) or exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending'))
            when 'snoozed' then status='snoozed' when 'duplicates' then status='duplicate' else status in ('pending','snoozed','duplicate') end
            and (p_missing is null or p_missing=any(app.telegram_missing_v1(fields,document)) or p_missing='cvAnalysis' and app.cv_analysis_required_v1(d))
            and (coalesce(p_query,'')='' or strpos(lower(concat_ws(' ',fields->>'firstName',fields->>'lastName',fields->>'primaryEmail',fields->>'telegramUsername',source_title)),lower(p_query))>0)
        order by updated_at desc,id limit 26 offset (p_page-1)*25
    ), numbered as (select f.*,row_number() over(order by updated_at desc,id) n from filtered f)
    select coalesce(jsonb_agg(app.telegram_draft_json_v1(d) order by n.n) filter(where n.n<=25),'[]'),count(*)>25 into rows_json,more
        from numbered n join app.telegram_drafts d on d.id=n.id;
    return jsonb_build_object('drafts',rows_json,'counts',counts_json,'page',p_page,'hasMore',more);
end $$;

create or replace function app.telegram_retention_purge_v1(p_id uuid) returns jsonb language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare j app.telegram_extraction_jobs; d record; holds jsonb; removed bigint; bytes bigint;
begin
 perform 1 from app.telegram_history_limits where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') for update nowait;
 select * into j from app.telegram_extraction_jobs where id=p_id for no key update nowait;
 if not found or j.status<>'completed' or j.source_release_requested_at is null or j.source_purged_at is not null then return jsonb_build_object('purged',false); end if;
 for d in select t.id from app.telegram_drafts t join app.telegram_retention_drafts_v1(j.id) r on r.id=t.id order by t.id for update of t nowait loop null; end loop;
 perform 1 from app.telegram_extraction_proposals where job_id=j.id order by id for update nowait;
 perform 1 from app.telegram_cv_jobs where extraction_job_id=j.id order by id for update nowait;
 perform 1 from app.cv_analyses where extraction_job_id=j.id order by id for update nowait;
 if exists(select 1 from app.cv_analyses a where a.extraction_job_id=j.id and (a.status in('queued','leased','waiting') or a.status='completed' and a.text_decision='pending' or exists(select 1 from app.cv_analysis_proposals where analysis_id=a.id and status='pending'))) then update app.telegram_extraction_jobs set cleanup_due_at=now()+interval '15 minutes' where id=j.id;return jsonb_build_object('purged',false);end if;
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

create or replace function app.telegram_maintenance_v1(p_limit integer default 10) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare owner record; j record; r jsonb; q jsonb; due timestamptz; progressed boolean; owners integer:=0; batches integer:=0; messages bigint:=0; bytes bigint:=0; expired integer:=0; deleted integer:=0; analyses integer:=0; old_org text:=current_setting('app.organization_id',true); old_actor text:=current_setting('app.actor_id',true);
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
 for j in select id from app.cv_analyses where cleanup_due_at<=now() and purged_at is null order by cleanup_due_at,id limit greatest(0,20-analyses) loop
 begin if app.cv_analysis_purge_v1(j.id) then analyses:=analyses+1;progressed:=true;end if;exception when lock_not_available then null;end;
 end loop;
 select min(t) into due from (
 select cleanup_due_at t from app.telegram_extraction_jobs where source_release_requested_at is not null and source_purged_at is null
 union all select case when result_cleanup_pending then now() else expires_at end from app.profile_search_queries where status<>'expired' or result_cleanup_pending
 union all select cleanup_due_at from app.cv_analyses where cleanup_due_at is not null and purged_at is null
 ) deadlines;
 if due is null then delete from app.telegram_maintenance_owners where organization_id=owner.organization_id and owner_user_id=owner.owner_user_id;
 else update app.telegram_maintenance_owners set due_at=greatest(case when progressed then clock_timestamp() else now()+interval '1 minute' end,due) where organization_id=owner.organization_id and owner_user_id=owner.owner_user_id; end if;
 -- Leave unvisited owners in place when this invocation exhausts its budget.
 exit when expired>=100 or deleted>=5000 or analyses>=20;
 end loop;
 perform set_config('app.organization_id',coalesce(old_org,''),true); perform set_config('app.actor_id',coalesce(old_actor,''),true);
 return jsonb_build_object('analysesPurged',analyses,'ownersProcessed',owners,'batchesPurged',batches,'messagesPurged',messages,'bytesFreed',bytes,'queriesExpired',expired,'queryResultRowsDeleted',deleted,'remainingWork',exists(select 1 from app.telegram_maintenance_owners where due_at<=now()+interval '1 minute'));
end $$;
create function app.cv_analysis_proposal_v1(p_analysis uuid,p_proposal uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ declare r jsonb;begin
 perform app.cv_analysis_actor_v1();select jsonb_build_object('field',p.field,'value',p.suggested_value,'fields',d.fields) into r from app.cv_analysis_proposals p join app.telegram_drafts d on d.id=p.draft_id where p.id=p_proposal and p.analysis_id=p_analysis;if r is null then raise exception 'Suggestion unavailable' using errcode='P0002';end if;return r;end $$;

-- Readiness compatibility only: CV text remains absent from search projections.
create or replace function app.profile_search_profile_v1(s app.profile_search_sources) returns jsonb language plpgsql stable set search_path=pg_catalog,app,pg_temp as $$
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
 missing:=app.telegram_missing_v1(d.fields,d.document); if app.cv_analysis_required_v1(d) then missing:=array_append(missing,'cvAnalysis');end if; if exists(select 1 from app.telegram_extraction_proposals where draft_id=d.id and status='pending') then missing:=array_append(missing,'proposals'); end if;
 return jsonb_build_object('fields',f,'displayName',coalesce(nullif(f->>'fullName',''),'Unnamed draft'),'headline',f->>'headline','location',f->>'location','hasCv',d.document is not null,'missingFields',to_jsonb(missing),'ready',cardinality(missing)=0);
end $$;
create or replace function app.profile_search_eligible_v1(p_scope text,p_ready boolean) returns setof app.profile_search_sources language sql stable as $$
 select s.* from app.profile_search_sources s where s.status<>'retired' and ((s.source_type='candidate' and p_scope<>'my_drafts') or (s.source_type='draft' and p_scope<>'approved' and exists(select 1 from app.telegram_drafts d where d.id=s.source_id and d.status in('pending','snoozed','duplicate') and (not p_ready or (cardinality(app.telegram_missing_v1(d.fields,d.document))=0 and not app.cv_analysis_required_v1(d) and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending'))))))
$$;
create or replace function app.profile_search_status_before_retention_v1(p_scope text,p_ready boolean,p_query uuid,p_after jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
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
 where r.query_id=q.id and (s.source_type='candidate' or exists(select 1 from app.telegram_drafts d where d.id=s.source_id and d.status in('pending','snoozed','duplicate') and (not q.ready_only or (cardinality(app.telegram_missing_v1(d.fields,d.document))=0 and not app.cv_analysis_required_v1(d) and not exists(select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending')))))
 and (p_after is null or r.score<(p_after->>'score')::double precision or (r.score=(p_after->>'score')::double precision and (r.source_type,r.public_source_id)>(p_after->>'sourceType',(p_after->>'sourceId')::uuid))) order by r.score desc,r.source_type,r.public_source_id limit 26
 ), profiles as materialized(select page.*,app.profile_search_profile_v1(page.source) profile from page)
 select coalesce(jsonb_agg(jsonb_build_object('sourceType',p.source_type,'sourceId',p.public_source_id,'sourceRevision',p.source_revision,'displayName',p.profile->>'displayName','headline',p.profile->>'headline','location',p.profile->>'location','hasCv',p.profile->'hasCv','missingFields',p.profile->'missingFields','score',p.score,'matchedText',left(convert_from(substring(convert_to((p.source).projection_text,'UTF8') from ch.start_byte+1 for ch.end_byte-ch.start_byte),'UTF8'),500),'href',case when p.source_type='candidate' then '/staff/candidates/'||p.public_source_id else '/staff/telegram-intake?draft='||p.public_source_id end) order by p.score desc,p.source_type,p.public_source_id),'[]'),count(*) into records,n
 from profiles p join app.profile_search_chunks ch on ch.source_id=p.source_id and ch.ordinal=p.ordinal where p.profile is not null;
 if n>25 then records:=records-25; cursor:=jsonb_build_object('queryId',q.id,'score',records->24->'score','sourceType',records->24->>'sourceType','sourceId',records->24->>'sourceId'); end if;
 end if;
 return jsonb_build_object('queryId',q.id,'query',q.query_text,'scope',q.scope,'readyOnly',q.ready_only,'status',q.status,'results',records,'nextAfter',cursor,'coverage',cv,'workerAvailable',available,'errorCode',q.error_code,'expiresAt',q.expires_at);
end $$;
create function app.cv_analysis_search_event_v1() returns trigger language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$ begin
 if tg_table_name='cv_analysis_proposals' or tg_op='INSERT' or (old.status in('queued','leased','waiting','failed')) is distinct from (new.status in('queued','leased','waiting','failed')) then
 perform app.profile_search_invalidate_v1(coalesce(new.organization_id,old.organization_id),coalesce(new.owner_user_id,old.owner_user_id),'draft',coalesce(new.draft_id,old.draft_id),false,false);
 end if;return coalesce(new,old);end $$;
create trigger cv_analysis_search_event after insert or update of status on app.cv_analyses for each row execute function app.cv_analysis_search_event_v1();
create trigger cv_proposal_search_event after insert or update of status or delete on app.cv_analysis_proposals for each row execute function app.cv_analysis_search_event_v1();
do $$ declare f record;begin
 for f in select oid::regprocedure sig from pg_proc where pronamespace='app'::regnamespace and (proname like 'cv_analysis_%' or proname like 'cv_bootstrap_%' or proname in('cv_reviewed_text_v1','telegram_cv_action_v1','telegram_draft_json_v1')) loop execute format('revoke all on function %s from public',f.sig);end loop;
end $$;
grant execute on function app.cv_analysis_status_v1(uuid,uuid,uuid,uuid,integer),app.cv_analysis_action_v1(jsonb),app.cv_bootstrap_status_v1(uuid,bigint,integer),app.telegram_cv_action_v1(jsonb),app.cv_reviewed_text_v1(uuid),app.cv_analysis_proposal_v1(uuid,uuid) to app_staff;
grant execute on function app.cv_analysis_claim_v1(text),app.cv_analysis_content_v1(text,uuid,uuid,text),app.cv_analysis_source_read_v1(text,uuid,uuid,text),app.cv_analysis_receipt_v1(text,jsonb),app.cv_analysis_complete_v1(text,jsonb),app.cv_analysis_fail_v1(text,jsonb) to app_telegram_worker;
reset role;set local role app_owner;
revoke create on schema app from app_executor;
revoke trigger on app.telegram_drafts,app.telegram_cv_jobs,app.cv_analyses,app.cv_analysis_proposals from app_executor;
commit;
