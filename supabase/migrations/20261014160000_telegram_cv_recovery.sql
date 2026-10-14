begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
grant create on schema app to app_executor;
reset role;
set local role app_executor;

-- A failed chat-text result must not make its retained CV unavailable.
create or replace function app.cv_bootstrap_status_v1(p_job uuid,p_message bigint,p_index integer) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare ex app.telegram_extraction_jobs;c app.telegram_connections;d app.telegram_drafts;rows jsonb;next_cursor text;begin
 perform app.cv_analysis_actor_v1();perform app.recruitment_actor_v1(array['documents.write'],null,null,false);
 select * into ex from app.telegram_extraction_jobs where id=p_job;if not found then raise exception 'Batch unavailable' using errcode='P0002';end if;
 select * into c from app.telegram_connections;d.status:='pending';
 with raw as(select m->>'messageId' mid,(x.n-1)::integer idx,x.value metadata from jsonb_array_elements(coalesce(ex.source->'messages','[]')) m cross join lateral jsonb_array_elements(m->'attachments') with ordinality x(value,n)),chosen as(select * from raw where p_message is null or (mid::bigint,idx)>(p_message,p_index) order by mid::bigint,idx limit 51),n as(select *,row_number() over(order by mid::bigint,idx) rn from chosen),q as(select n.*,
 (select coalesce(jsonb_agg(t.draft_id order by t.draft_id),'[]') from (select distinct draft_id from app.telegram_extraction_attachments where job_id=ex.id and message_id=n.mid and attachment_index=n.idx order by draft_id limit 12) t) ids,
 case when ex.status not in('completed','failed') or ex.source is null then 'SOURCE_UNAVAILABLE' else app.telegram_cv_eligible_v1(metadata,d,ex.source#>>'{chat,accountUserId}',c) end reason from n)
 select coalesce(jsonb_agg(jsonb_build_object('messageId',mid,'attachmentIndex',idx,'filename',metadata->'filename','mimeType',metadata->'mimeType','sizeBytes',metadata->'sizeBytes','documentId',metadata->'id','eligible',reason is null and jsonb_array_length(ids)=0,'reason',case when jsonb_array_length(ids)>0 then 'ALREADY_LINKED' else reason end,'existingDraftIds',ids) order by mid::bigint,idx) filter(where rn<=50),'[]'),case when count(*)>50 then (array_agg(mid||':'||idx order by rn))[50] end into rows,next_cursor from q;
 return jsonb_build_object('extractionJobId',ex.id,'sourceVersion',ex.source_version,'sourceAvailable',ex.source is not null,'connectionIssue',case when c.status is distinct from 'connected' then 'CONNECTION_REQUIRED' when ex.source is not null and ex.source#>>'{chat,accountUserId}' is distinct from c.profile->>'telegramUserId' then 'ACCOUNT_MISMATCH' end,'attachments',rows,'nextAfter',next_cursor);
end $$;
create or replace function app.telegram_cv_action_v1(p_input jsonb) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
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
 if not found or ex.source is null or ex.status not in('completed','failed') or ex.source_version is distinct from (p_input->>'expectedSourceVersion')::bigint then raise exception 'Source changed' using errcode='40001';end if;
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

-- Discover clearly labelled CVs separately from candidate text extraction.
-- Existing attachment links are reused; reviewed profiles are never modified.
create function app.telegram_cv_auto_bootstrap_v1(p_token text) returns integer
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare item record; d app.telegram_drafts; c app.telegram_connections; started integer:=0;
begin
 perform app.cv_analysis_worker_v1(p_token);
 begin
 perform app.recruitment_actor_v1(array['documents.write'],null,null,false);
 exception when insufficient_privilege then return 0; end;
 select * into c from app.telegram_connections where status='connected' for share;
 if not found then return 0; end if;
 -- Account-before-owner lock order matches Telegram retrieval and imports.
 perform 1 from app.telegram_history_accounts where connection_id=c.id and account_user_id=c.profile->>'telegramUserId' for update;
 perform app.telegram_extraction_lock_v1();
 for item in
 select j.id job_id,j.source_version,m->>'messageId' message_id,(a.n-1)::integer attachment_index,a.value metadata
 from app.telegram_extraction_jobs j
 join app.telegram_history_chats h on h.id=j.chat_id and h.extraction_enabled
 cross join lateral jsonb_array_elements(j.source->'messages') m
 cross join lateral jsonb_array_elements(m->'attachments') with ordinality a(value,n)
 where j.source is not null and j.status in('completed','failed')
 and j.source#>>'{chat,accountUserId}'=c.profile->>'telegramUserId'
 and a.value->>'kind'='document' and a.value->>'filename' ~* '\.(pdf|docx)$'
 and (a.value->>'filename' ~* '(^|[^a-z])(cv|resume|résumé|curriculum)([^a-z]|$)' or m->>'text' ~* '(^|[^a-z])(cv|resume|résumé|curriculum vitae)([^a-z]|$)')
 and not exists(select 1 from app.telegram_cv_jobs v where v.extraction_job_id=j.id and v.source->>'messageId'=m->>'messageId' and (v.source->>'attachmentIndex')::integer=a.n-1)
 order by j.created_at,j.id,(m->>'messageId')::bigint,a.n limit 5
 loop
 begin
 select draft.* into d from app.telegram_extraction_attachments link join app.telegram_drafts draft on draft.id=link.draft_id
 where link.job_id=item.job_id and link.message_id=item.message_id and link.attachment_index=item.attachment_index
 order by draft.created_at,draft.id limit 1;
 if found then
 if app.telegram_cv_eligible_v1(item.metadata,d,c.profile->>'telegramUserId',c) is not null then continue;end if;
 perform app.telegram_cv_action_v1(jsonb_build_object('action','retrieve','draftId',d.id,'expectedDocumentRevision',d.document_revision,
 'extractionJobId',item.job_id,'messageId',item.message_id,'attachmentIndex',item.attachment_index));
 else
 d.status:='pending';d.document:=null;
 if app.telegram_cv_eligible_v1(item.metadata,d,c.profile->>'telegramUserId',c) is not null then continue;end if;
 perform app.telegram_cv_action_v1(jsonb_build_object('action','createDraft','extractionJobId',item.job_id,
 'messageId',item.message_id,'attachmentIndex',item.attachment_index,'expectedSourceVersion',item.source_version,'operationId',gen_random_uuid()));
 end if;
 started:=started+1;
 exception when check_violation or serialization_failure or insufficient_privilege then continue;
 end;
 end loop;
 return started;
end $$;
revoke all on function app.telegram_cv_auto_bootstrap_v1(text) from public;

alter function app.cv_analysis_claim_v1(text) rename to cv_analysis_claim_before_auto_cv_v1;
revoke all on function app.cv_analysis_claim_before_auto_cv_v1(text) from app_telegram_worker;
create function app.cv_analysis_claim_v1(p_token text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 perform app.telegram_cv_auto_bootstrap_v1(p_token);
 return app.cv_analysis_claim_before_auto_cv_v1(p_token);
end $$;
revoke all on function app.cv_analysis_claim_v1(text) from public;
grant execute on function app.cv_analysis_claim_v1(text) to app_telegram_worker;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
