begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_drafts add column review_archived boolean not null default false,
 add column review_archive_origin_id uuid references app.telegram_drafts(id);
create index telegram_review_archive_idx on app.telegram_drafts(organization_id,owner_user_id,updated_at desc,id) where review_archived;
grant create on schema app to app_executor;
reset role;
set local role app_executor;
-- Keep an independent snapshot: future extraction may reuse the original subject.
alter function app.telegram_review_decide_v1(uuid,bigint,text,uuid) rename to telegram_review_decide_before_archive_v1;
create function app.telegram_review_decide_v1(p_id uuid,p_version bigint,p_action text,p_operation uuid) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; snapshot jsonb; archive_id uuid;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 select * into d from app.telegram_drafts where id=p_id for update;
 if not found then raise exception 'Proposal unavailable' using errcode='P0002'; end if;
 if p_action='reopen' and d.review_archived then
  if d.version<>p_version then raise exception 'Proposal changed' using errcode='40001'; end if;
  perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],p_operation,gen_random_uuid(),true);
  update app.telegram_drafts set status='pending',review_archived=false,version=version+1,updated_at=clock_timestamp(),reviewed_at=null where id=p_id;
  update app.telegram_extraction_subjects set draft_id=p_id where draft_id=d.review_archive_origin_id
   and exists(select 1 from app.telegram_drafts original where original.id=d.review_archive_origin_id and original.status='discarded');
  if d.review_candidate_id is not null then
   return app.telegram_review_refresh_v1(p_id,p_version+1);
  end if;
  return app.telegram_review_draft_v1(p_id);
 end if;
 if p_action='discard' and d.status not in('approved','discarded') and d.version=p_version then
  snapshot:=app.telegram_review_draft_v1(p_id);
  select * into d from app.telegram_drafts where id=p_id;
  archive_id:=gen_random_uuid();
  insert into app.telegram_drafts(id,organization_id,owner_user_id,candidate_target_id,status,fields,document,document_revision,
    source_title,review_candidate_id,review_candidate_version,review_candidate_fields,review_archived,reviewed_at,review_archive_origin_id)
  values(archive_id,d.organization_id,d.owner_user_id,d.candidate_target_id,'discarded',snapshot->'proposedFields',d.document,d.document_revision,
    d.source_title,d.review_candidate_id,d.review_candidate_version,d.review_candidate_fields,true,now(),d.id);
 end if;
 return app.telegram_review_decide_before_archive_v1(p_id,p_version,p_action,p_operation);
end $$;
-- Reuse all existing active-inbox filters and permission/owner scoping.
alter function app.telegram_review_list_v1(text,text,text,integer) rename to telegram_review_list_before_archive_v1;
create function app.telegram_review_list_v1(p_view text,p_missing text,p_query text,p_page integer) returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare r jsonb; rows_json jsonb; more boolean; n bigint;
begin
 perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
 if p_view='archived' then
  if p_page not between 1 and 10000 or char_length(p_query)>200 or p_missing is not null then raise exception 'Invalid archive filter' using errcode='22023'; end if;
  r:=app.telegram_review_list_before_archive_v1('all',null,'',1);
  with filtered as (select id,updated_at from app.telegram_drafts where review_archived and
   (coalesce(p_query,'')='' or strpos(lower(concat_ws(' ',fields->>'firstName',fields->>'lastName',fields->>'primaryEmail',source_title)),lower(p_query))>0)
   order by updated_at desc,id limit 26 offset (p_page-1)*25), numbered as(select *,row_number() over(order by updated_at desc,id) rn from filtered)
  select coalesce(jsonb_agg(app.telegram_review_draft_v1(id)-array['evidence','proposedFields'] order by rn) filter(where rn<=25),'[]'),count(*)>25 into rows_json,more from numbered;
  r:=r||jsonb_build_object('drafts',rows_json,'page',p_page,'hasMore',more);
 else
  r:=app.telegram_review_list_before_archive_v1(p_view,p_missing,p_query,p_page);
 end if;
 select count(*) into n from app.telegram_drafts where review_archived;
 return jsonb_set(r,'{counts}',(r->'counts')||jsonb_build_object('archived',n));
end $$;
revoke execute on function app.telegram_review_decide_before_archive_v1(uuid,bigint,text,uuid),app.telegram_review_list_before_archive_v1(text,text,text,integer) from app_staff;
revoke all on function app.telegram_review_decide_v1(uuid,bigint,text,uuid),app.telegram_review_list_v1(text,text,text,integer) from public;
grant execute on function app.telegram_review_decide_v1(uuid,bigint,text,uuid),app.telegram_review_list_v1(text,text,text,integer) to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
