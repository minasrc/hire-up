begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_drafts add column review_candidate_id uuid,
 add column review_candidate_version bigint, add column review_candidate_fields jsonb,
 add column review_edited_fields text[] not null default '{}';
alter table app.telegram_drafts add constraint telegram_review_candidate_fk
 foreign key(organization_id,review_candidate_id) references app.candidates(organization_id,id);
-- The existing cleanup worker retains unresolved evidence and active attachments.
alter table app.telegram_extraction_jobs alter column source_release_requested_at set default now();
alter table app.telegram_extraction_jobs alter column cleanup_due_at set default now();
grant create on schema app to app_executor;
grant trigger on app.telegram_extraction_jobs to app_executor;
reset role;
set local role app_executor;


create function app.telegram_candidate_cleanup_event_v1() returns trigger
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare old_org text:=current_setting('app.organization_id',true);old_actor text:=current_setting('app.actor_id',true);
begin
 if new.status='completed' and new.source_release_requested_at is not null and new.source_purged_at is null then
 perform set_config('app.organization_id',new.organization_id::text,true);
 perform set_config('app.actor_id',new.owner_user_id::text,true);
 perform app.telegram_maintenance_schedule_v1(now());
 perform set_config('app.organization_id',coalesce(old_org,''),true);
 perform set_config('app.actor_id',coalesce(old_actor,''),true);
 end if;
 return new;
end $$;
create trigger telegram_candidate_cleanup_event after insert or update of status on app.telegram_extraction_jobs
for each row execute function app.telegram_candidate_cleanup_event_v1();
revoke all on function app.telegram_candidate_cleanup_event_v1() from public;

create function app.telegram_candidate_start_v1(p_input jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r jsonb; ids jsonb;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 perform app.telegram_extraction_lock_v1();
 -- Both actions commit together: a failed selection never leaves extraction enabled.
 r:=app.telegram_history_action_v1(p_input||jsonb_build_object('action','selectMany','selected',true));
 select jsonb_agg(value->'chatId') into ids from jsonb_array_elements(p_input->'chats');
 perform app.telegram_extraction_action_v1(jsonb_build_object('action','enqueue','chatIds',ids));
 return r;
end $$;

create function app.telegram_candidate_fields_v1(c app.candidates) returns jsonb
language sql stable set search_path=pg_catalog,app,pg_temp as $$
 select jsonb_build_object('firstName',coalesce(c.first_name,split_part(c.full_name,' ',1)),
 'lastName',coalesce(c.last_name,nullif(substr(c.full_name,length(split_part(c.full_name,' ',1))+2),''),''),
 'primaryEmail',coalesce(app.candidate_contact_v1(c,'email'),''),'secondaryEmails',to_jsonb(coalesce(c.secondary_emails,'{}'::text[])),
 'headline',c.headline,'location',c.location,'professionalUrl',app.candidate_contact_v1(c,'professional_url'),
 'professionalSummary',c.professional_summary,'compensationPreference',c.compensation_preference,
 'ownerMembershipId',c.owner_membership_id);
$$;

create function app.telegram_review_prepare_v1(p_id uuid) returns void
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; c app.candidates; matches uuid[]; base jsonb; incoming jsonb;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into d from app.telegram_drafts where id=p_id for update;
 if not found then raise exception 'Draft unavailable' using errcode='P0002'; end if;
 -- Existing imports adopt the same reviewed-source cleanup policy.
 update app.telegram_extraction_jobs set source_release_requested_at=coalesce(source_release_requested_at,now()),cleanup_due_at=now()
 where source_purged_at is null and source_release_requested_at is null and id in
 (select job_id from app.telegram_extraction_proposals where draft_id=d.id union
 select job_id from app.telegram_extraction_attachments where draft_id=d.id);
 if d.status='discarded' then return; end if;
 if d.status='approved' and not exists(select 1 from app.telegram_extraction_proposals where draft_id=d.id and status='pending') then return; end if;
 if d.review_candidate_id is not null and d.status<>'approved' then return; end if;
 if d.status='approved' then matches:=array[d.approved_candidate_id];
 else
 -- Exact identifiers only. Names and handles are never sufficient to merge people.
 select array_agg(distinct i.candidate_id) into matches from app.candidate_identifiers i
 join app.candidates matched on matched.organization_id=i.organization_id and matched.id=i.candidate_id
 where i.organization_id=d.organization_id and matched.lifecycle='active' and
 ((i.kind='email' and i.normalized_value=any(array[lower(d.fields->>'primaryEmail')]||array(select lower(value) from jsonb_array_elements_text(coalesce(d.fields->'secondaryEmails','[]')))))
 or (i.kind='provider_subject' and i.normalized_value='telegram:user:'||(d.fields->>'telegramUserId')));
 end if;
 if cardinality(matches)<>1 or matches is null then return; end if;
 select * into c from app.candidates where id=matches[1] and organization_id=d.organization_id and lifecycle='active' for share;
 if not found then return; end if;
 base:=app.telegram_candidate_fields_v1(c);
 select coalesce(jsonb_object_agg(key,value),'{}') into incoming from jsonb_each(d.fields)
 where value not in('null'::jsonb,'""'::jsonb,'[]'::jsonb) or key=any(d.human_fields);
 update app.telegram_drafts set review_candidate_id=c.id,review_candidate_version=c.version,review_candidate_fields=base,
 fields=case when d.status='approved' then base else base||incoming end,
 status=case when d.status in('approved','duplicate') then 'pending' else status end,
 human_fields=case when d.status='approved' then '{}'::text[] else human_fields end,
 review_edited_fields=case when d.status='approved' then '{}'::text[] else review_edited_fields end,
 version=version+1,updated_at=clock_timestamp() where id=d.id;
end $$;

create function app.telegram_review_draft_v1(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; r jsonb; proposed jsonb;
begin
 perform app.telegram_review_prepare_v1(p_id);
 r:=app.telegram_get_draft_v1(p_id);
 select * into strict d from app.telegram_drafts where id=p_id;
 proposed:=d.fields;
 -- Latest proposal for a field wins; edited fields always win over extraction.
 for r in select jsonb_build_object('field',field,'value',suggested_value) from app.telegram_extraction_proposals
 where draft_id=p_id and status='pending' and not(field=any(d.review_edited_fields)) order by created_at,id loop
 proposed:=jsonb_set(proposed,array[r->>'field'],r->'value',true);
 end loop;
 r:=app.telegram_get_draft_v1(p_id);
 return r||jsonb_build_object('proposedFields',proposed,'existingCandidate',case when d.review_candidate_id is null then null else
 jsonb_build_object('id',d.review_candidate_id,'version',d.review_candidate_version::text,'fields',d.review_candidate_fields) end);
end $$;

create function app.telegram_review_list_v1(p_view text,p_missing text,p_query text,p_page integer) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare row record; r jsonb; rows jsonb:='[]'; item jsonb;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 -- Reopen reviewed subjects when new information arrives, including old subjects
 -- outside the current inbox page. Each call is bounded and idempotent.
 for row in select id from app.telegram_drafts d where status='approved' and exists
 (select 1 from app.telegram_extraction_proposals p where p.draft_id=d.id and p.status='pending') order by updated_at desc limit 100 loop
 perform app.telegram_review_prepare_v1(row.id);
 end loop;
 r:=app.telegram_list_drafts_v1(p_view,p_missing,p_query,p_page);
 for item in select value from jsonb_array_elements(r->'drafts') loop
 item:=app.telegram_review_draft_v1((item->>'id')::uuid)-array['evidence','proposedFields'];
 rows:=rows||jsonb_build_array(item);
 end loop;
 return r||jsonb_build_object('drafts',rows);
end $$;

create function app.telegram_review_decide_v1(p_id uuid,p_version bigint,p_action text,p_operation uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; c app.candidates; p record; fields jsonb; profile jsonb; r jsonb; src uuid;
 email text; blob uuid; doc uuid; candidate uuid; member uuid; edited text[];
begin
 member:=app.recruitment_actor_v1(array['candidates.read','candidates.write'],p_operation,gen_random_uuid(),true);
 select * into d from app.telegram_drafts where id=p_id for update;
 if not found then raise exception 'Draft unavailable' using errcode='P0002'; end if;
 if d.status='approved' and p_action='approve' then return jsonb_build_object('status','approved','candidateId',d.approved_candidate_id,'replayed',true); end if;
 if d.version<>p_version or d.status in('approved','discarded') then raise exception 'Proposal changed; refresh before saving' using errcode='40001'; end if;
 if p_action<>'approve' then
 r:=app.telegram_decide_draft_v1(p_id,p_version,p_action,p_operation);
 -- Reject this proposed update, while allowing future information for the person.
 if p_action='discard' and d.review_candidate_id is not null and exists(select 1 from app.telegram_extraction_subjects where draft_id=d.id) then
 select * into c from app.candidates where id=d.review_candidate_id and organization_id=d.organization_id and lifecycle='active';
 if found then
 update app.telegram_drafts set fields=app.telegram_candidate_fields_v1(c) where id=d.id;
 update app.telegram_drafts set status='approved',approved_candidate_id=c.id,fields='{}',reviewed_at=now() where id=d.id;
 end if;
 end if;
 return r;
 end if;
 if d.review_candidate_id is not null then
 select * into c from app.candidates where id=d.review_candidate_id and organization_id=d.organization_id and lifecycle='active' for update;
 if not found or c.version<>d.review_candidate_version then raise exception 'Candidate changed; refresh the proposal before saving' using errcode='40001'; end if;
 end if;
 edited:=d.review_edited_fields;
 for p in select id,field from app.telegram_extraction_proposals where draft_id=d.id and status='pending' order by created_at,id loop
 perform app.telegram_extraction_action_v1(jsonb_build_object('action','resolve','proposalId',p.id,
 'decision',case when p.field=any(edited) then 'dismiss' else 'apply' end,'expectedDraftVersion',d.version));
 select * into strict d from app.telegram_drafts where id=p_id;
 end loop;
 fields:=d.fields;
 if nullif(btrim(concat_ws(' ',fields->>'firstName',fields->>'lastName')),'') is null then raise exception 'Add a candidate name' using errcode='23514'; end if;
 if app.cv_analysis_required_v1(d) then raise exception 'Finish or skip CV review before approval' using errcode='23514'; end if;
 -- The existing upload path already handles complete CV-backed new candidates.
 if d.review_candidate_id is null and cardinality(app.telegram_missing_v1(fields,d.document))=0 then
 return app.telegram_decide_draft_v1(p_id,d.version,'approve',p_operation);
 end if;
 candidate:=coalesce(d.review_candidate_id,d.candidate_target_id);
 profile:=jsonb_build_object('fullName',btrim(concat_ws(' ',fields->>'firstName',fields->>'lastName')),
 'email',nullif(fields->>'primaryEmail',''),'headline',fields->'headline','location',fields->'location',
 'professionalUrl',fields->'professionalUrl','professionalSummary',fields->'professionalSummary',
 'ownerMembershipId',coalesce(fields->'ownerMembershipId',to_jsonb(c.owner_membership_id)));
 -- Secondary identities must not bypass the canonical duplicate check.
 for email in select value from jsonb_array_elements_text(coalesce(fields->'secondaryEmails','[]')) loop
 if exists(select 1 from app.candidate_identifiers i where i.organization_id=d.organization_id and i.kind='email' and i.normalized_value=lower(email) and i.candidate_id<>candidate) then
 raise exception 'An email belongs to another candidate' using errcode='23505'; end if;
 end loop;
 r:=app.save_candidate_profile_v1(candidate,d.review_candidate_version,profile,p_operation,gen_random_uuid());
 if r->>'status'='duplicate' then return r; end if;
 update app.candidates set first_name=nullif(fields->>'firstName',''),last_name=nullif(fields->>'lastName',''),
 secondary_emails=array(select value from jsonb_array_elements_text(coalesce(fields->'secondaryEmails','[]'))),
 compensation_preference=nullif(fields->>'compensationPreference','') where id=candidate and organization_id=d.organization_id;
 select id into strict src from app.candidate_sources where candidate_id=candidate and organization_id=d.organization_id order by received_at desc,id desc limit 1;
 for email in select value from jsonb_array_elements_text(coalesce(fields->'secondaryEmails','[]')) loop
 insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,source_id,received_at)
 values(gen_random_uuid(),d.organization_id,candidate,'email',email,lower(email),1,'unverified',src,now());
 end loop;
 if nullif(fields->>'telegramUserId','') is not null then
 insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,source_id,received_at)
 values(gen_random_uuid(),d.organization_id,candidate,'provider_subject','telegram:user:'||(fields->>'telegramUserId'),'telegram:user:'||(fields->>'telegramUserId'),1,'unverified',src,now());
 end if;
 if nullif(fields->>'telegramUsername','') is not null then
 insert into app.candidate_identifiers(id,organization_id,candidate_id,kind,raw_value,normalized_value,normalization_version,verification,source_id,received_at)
 values(gen_random_uuid(),d.organization_id,candidate,'professional_url','https://t.me/'||(fields->>'telegramUsername'),'https://t.me/'||lower(fields->>'telegramUsername'),1,'unverified',src,now());
 end if;
 if d.document is not null then
 perform app.recruitment_actor_v1(array['documents.write'],null,null,false);
 blob:=gen_random_uuid();doc:=gen_random_uuid();
 insert into app.file_blobs(id,organization_id,candidate_id,sha256,size_bytes,mime_type,extension,lifecycle,scan_state)
 values(blob,d.organization_id,candidate,decode(d.document->>'sha256','hex'),(d.document->>'sizeBytes')::bigint,d.document->>'mimeType',d.document->>'extension','live','unscanned');
 insert into app.blob_locations(id,organization_id,blob_id,backend_key,bucket,object_key,state,is_primary,verified_sha256,verified_size_bytes,verified_at)
 values(gen_random_uuid(),d.organization_id,blob,'supabase_storage','cv-submissions',d.document->>'objectKey','available',true,decode(d.document->>'sha256','hex'),(d.document->>'sizeBytes')::bigint,now());
 insert into app.documents(id,organization_id,candidate_id,blob_id,purpose,original_filename,source_id,received_at,lifecycle)
 values(doc,d.organization_id,candidate,blob,'cv',d.document->>'filename',src,now(),'active');
 update app.candidates set current_document_id=doc where id=candidate and organization_id=d.organization_id;
 end if;
 update app.telegram_drafts set status='approved',approved_candidate_id=candidate,fields='{}',document=null,
 reviewed_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=d.id;
 delete from app.telegram_draft_evidence where draft_id=d.id;
 delete from app.telegram_draft_embeddings where draft_id=d.id;
 return jsonb_build_object('status','approved','candidateId',candidate);
end $$;

-- A refreshed proposal rebases its existing values only when the reviewer asks.
create function app.telegram_review_refresh_v1(p_id uuid,p_version bigint) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; c app.candidates; base jsonb; delta jsonb;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into d from app.telegram_drafts where id=p_id for update;
 if not found or d.version<>p_version or d.status not in('pending','snoozed','duplicate') then raise exception 'Proposal changed' using errcode='40001'; end if;
 if d.review_candidate_id is null then return app.telegram_review_draft_v1(p_id); end if;
 select * into c from app.candidates where id=d.review_candidate_id and organization_id=d.organization_id and lifecycle='active' for share;
 if not found then raise exception 'Candidate unavailable' using errcode='P0002'; end if;
 base:=app.telegram_candidate_fields_v1(c);
 select coalesce(jsonb_object_agg(key,value),'{}') into delta from jsonb_each(d.fields) where value is distinct from d.review_candidate_fields->key;
 update app.telegram_drafts set fields=base||delta,review_candidate_fields=base,review_candidate_version=c.version,version=version+1 where id=d.id;
 return app.telegram_review_draft_v1(p_id);
end $$;



create function app.telegram_review_edit_v1(p_id uuid,p_version bigint,p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare current jsonb; edits text[];
begin
 current:=app.telegram_review_draft_v1(p_id);
 if (current->>'version')::bigint<>p_version then raise exception 'Proposal changed' using errcode='40001'; end if;
 select coalesce(array_agg(key),'{}') into edits from jsonb_each(p_fields) where value is distinct from current#>array['proposedFields',key];
 perform app.telegram_update_draft_v1(p_id,p_version,p_fields);
 update app.telegram_drafts set review_edited_fields=array(select distinct unnest(review_edited_fields||edits)) where id=p_id;
 return app.telegram_review_draft_v1(p_id);
end $$;
create function app.telegram_review_field_decision_v1(p_id uuid,p_field text) returns void
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 update app.telegram_drafts set review_edited_fields=array(select distinct unnest(review_edited_fields||array[p_field])) where id=p_id;
end $$;
revoke all on function app.telegram_review_edit_v1(uuid,bigint,jsonb),app.telegram_review_field_decision_v1(uuid,text) from public;
grant execute on function app.telegram_review_edit_v1(uuid,bigint,jsonb),app.telegram_review_field_decision_v1(uuid,text) to app_staff;

create function app.telegram_review_matches_v1(p_id uuid,p_query text) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if not exists(select 1 from app.telegram_drafts where id=p_id) then raise exception 'Proposal unavailable' using errcode='P0002'; end if;
 if char_length(p_query)>100 then raise exception 'Search is too long' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'email',email)),'[]') from
 (select c.id,c.full_name,app.candidate_contact_v1(c,'email') email from app.candidates c where c.lifecycle='active' and c.organization_id=app.context_uuid_v1('app.organization_id')
 and nullif(btrim(p_query),'') is not null and strpos(lower(concat_ws(' ',c.full_name,app.candidate_contact_v1(c,'email'))),lower(p_query))>0 order by full_name,id limit 10) q);
end $$;
create function app.telegram_review_match_v1(p_id uuid,p_version bigint,p_candidate uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts;c app.candidates; delta jsonb;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into d from app.telegram_drafts where id=p_id for update;
 if not found or d.version<>p_version or d.status not in('pending','snoozed','duplicate') then raise exception 'Proposal changed' using errcode='40001'; end if;
 select * into c from app.candidates where id=p_candidate and organization_id=d.organization_id and lifecycle='active' for share;
 if not found then raise exception 'Candidate unavailable' using errcode='P0002'; end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into delta from jsonb_each(d.fields)
 where (d.review_candidate_fields is null and (value not in('null'::jsonb,'""'::jsonb,'[]'::jsonb) or key=any(d.human_fields)))
 or (d.review_candidate_fields is not null and value is distinct from d.review_candidate_fields->key);
 update app.telegram_drafts set review_candidate_id=c.id,review_candidate_version=c.version,review_candidate_fields=app.telegram_candidate_fields_v1(c),
 fields=app.telegram_candidate_fields_v1(c)||delta,status='pending',version=version+1,updated_at=clock_timestamp() where id=d.id;
 return app.telegram_review_draft_v1(p_id);
end $$;
revoke all on function app.telegram_review_matches_v1(uuid,text),app.telegram_review_match_v1(uuid,bigint,uuid) from public;
grant execute on function app.telegram_review_matches_v1(uuid,text),app.telegram_review_match_v1(uuid,bigint,uuid) to app_staff;

revoke all on function app.telegram_candidate_start_v1(jsonb),app.telegram_candidate_fields_v1(app.candidates),app.telegram_review_prepare_v1(uuid),app.telegram_review_draft_v1(uuid),app.telegram_review_list_v1(text,text,text,integer),app.telegram_review_decide_v1(uuid,bigint,text,uuid),app.telegram_review_refresh_v1(uuid,bigint) from public;
grant execute on function app.telegram_candidate_start_v1(jsonb),app.telegram_review_draft_v1(uuid),app.telegram_review_list_v1(text,text,text,integer),app.telegram_review_decide_v1(uuid,bigint,text,uuid),app.telegram_review_refresh_v1(uuid,bigint) to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
revoke trigger on app.telegram_extraction_jobs from app_executor;
commit;
