-- Durable private provenance contains identity references only, never source material.
begin;
set local lock_timeout='2s'; set local statement_timeout='30s';
set local role app_owner;
create table app.telegram_candidate_origins (
 organization_id uuid not null, owner_user_id uuid not null, draft_id uuid primary key, candidate_source_id uuid not null,
 unique(organization_id,owner_user_id,draft_id),
 foreign key(organization_id,owner_user_id,draft_id) references app.telegram_drafts(organization_id,owner_user_id,id) on delete cascade,
 foreign key(organization_id,candidate_source_id) references app.candidate_sources(organization_id,id) on delete cascade
);
create table app.telegram_candidate_context_refs (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null, owner_user_id uuid not null,
 draft_id uuid not null, candidate_source_id uuid not null, chat_id uuid not null, message_id bigint not null check(message_id between 1 and 2147483647), extraction_job_id uuid not null,
 unique(candidate_source_id,chat_id,message_id),
 foreign key(organization_id,owner_user_id,draft_id) references app.telegram_candidate_origins(organization_id,owner_user_id,draft_id) on delete cascade,
 foreign key(organization_id,candidate_source_id) references app.candidate_sources(organization_id,id) on delete cascade,
 foreign key(organization_id,owner_user_id,chat_id) references app.telegram_history_chats(organization_id,owner_user_id,id) on delete cascade,
 foreign key(organization_id,owner_user_id,extraction_job_id) references app.telegram_extraction_jobs(organization_id,owner_user_id,id) on delete cascade
);
create index telegram_candidate_context_merged_parent_idx on app.candidates(organization_id,merged_into_id,id) where merged_into_id is not null;
create index telegram_candidate_context_draft_idx on app.telegram_drafts(organization_id,owner_user_id,approved_candidate_id,id) where status='approved';
create index telegram_candidate_context_source_idx on app.telegram_candidate_context_refs(organization_id,owner_user_id,candidate_source_id,id);
do $$ declare t text; begin
 foreach t in array array['telegram_candidate_origins','telegram_candidate_context_refs'] loop
 execute format('alter table app.%I enable row level security',t); execute format('alter table app.%I force row level security',t);
 execute format('grant select,insert,delete on app.%I to app_executor',t);
 -- Only the terminal-lifecycle trigger performs cross-owner deletion. Runtime
 -- roles still have no table privileges or callable deletion helper.
 execute format('create policy telegram_candidate_context_erasure on app.%I for delete to app_executor using(organization_id=app.context_uuid_v1(''app.organization_id''))',t);
 execute format('create policy telegram_candidate_context_owner on app.%I for all to app_executor using(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id'')) with check(organization_id=app.context_uuid_v1(''app.organization_id'') and owner_user_id=app.context_uuid_v1(''app.actor_id''))',t);
 end loop;
end $$;
grant trigger on app.candidates,app.telegram_drafts,app.telegram_extraction_proposals,app.telegram_extraction_attachments to app_executor;
grant create on schema app to app_executor;
reset role; set local role app_executor;
create function app.telegram_candidate_origin_v1(p_draft uuid) returns uuid language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare d app.telegram_drafts; sid uuid;
begin
 select o.candidate_source_id into sid from app.telegram_candidate_origins o join app.candidate_sources s on s.id=o.candidate_source_id join app.candidates c on c.id=s.candidate_id where o.draft_id=p_draft and c.lifecycle in('active','restricted');
 if found then return sid; end if;
 select * into d from app.telegram_drafts where id=p_draft and status='approved';
 if not found then return null; end if;
 -- New approval has one initial source. Backfill only an unambiguous surviving
 -- original source, never guess an association after a historical merge.
 select (array_agg(s.id))[1] into sid from app.candidate_sources s join app.candidates c on c.id=s.candidate_id and c.lifecycle in('active','restricted') join app.organization_memberships m on m.organization_id=s.organization_id and m.id=s.created_by_membership_id
 where s.organization_id=d.organization_id and s.candidate_id=d.candidate_target_id and m.user_id=d.owner_user_id and s.context_summary='Added by staff' and s.received_at<=d.reviewed_at having count(*)=1;
 if sid is null then return null; end if;
 insert into app.telegram_candidate_origins values(d.organization_id,d.owner_user_id,d.id,sid) on conflict(draft_id) do nothing;
 return sid;
end $$;
create function app.telegram_candidate_refs_v1(p_draft uuid,p_job uuid,p_ids jsonb) returns void language plpgsql set search_path=pg_catalog,app,pg_temp as $$
declare sid uuid; d app.telegram_drafts; j app.telegram_extraction_jobs;
begin
 sid:=app.telegram_candidate_origin_v1(p_draft); if sid is null then return; end if;
 select * into strict d from app.telegram_drafts where id=p_draft;
 select * into strict j from app.telegram_extraction_jobs where id=p_job;
 insert into app.telegram_candidate_context_refs(organization_id,owner_user_id,draft_id,candidate_source_id,chat_id,message_id,extraction_job_id)
 select d.organization_id,d.owner_user_id,d.id,sid,j.chat_id,(x#>>'{}')::bigint,j.id from jsonb_array_elements(p_ids) x
 where (x#>>'{}') ~ '^[1-9][0-9]{0,9}$' and (x#>>'{}')::bigint<=2147483647
 -- Exact subject references must also be members of the retained source ledger.
 and exists(select 1 from app.telegram_extraction_sources t where t.job_id=j.id and t.chat_id=j.chat_id and t.message_id=(x#>>'{}')::bigint)
 on conflict(candidate_source_id,chat_id,message_id) do nothing;
end $$;
create function app.telegram_candidate_capture_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare r record; ids jsonb;
begin
 if tg_table_name='telegram_drafts' then
  if new.status<>'approved' or old.status='approved' then return new; end if;
  perform app.telegram_candidate_origin_v1(new.id);
  for r in select job_id,jsonb_agg(message_id) ids from (
   select p.job_id,e->>'messageId' message_id from app.telegram_extraction_proposals p cross join lateral jsonb_array_elements(p.evidence)e where p.draft_id=new.id
   union select a.job_id,a.message_id from app.telegram_extraction_attachments a where a.draft_id=new.id
  ) q group by job_id loop perform app.telegram_candidate_refs_v1(new.id,r.job_id,r.ids); end loop;
 elsif tg_table_name='telegram_extraction_proposals' then
  select coalesce(jsonb_agg(e->>'messageId'),'[]'::jsonb) into ids from jsonb_array_elements(new.evidence)e;
  perform app.telegram_candidate_refs_v1(new.draft_id,new.job_id,ids);
 else perform app.telegram_candidate_refs_v1(new.draft_id,new.job_id,jsonb_build_array(new.message_id));
 end if;
 return new;
end $$;
create function app.telegram_candidate_context_v1(p_candidate uuid,p_after uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare result jsonb; cid uuid; missing boolean;
begin
 perform app.recruitment_actor_v1(array['candidates.read'],null,null,false);
 perform 1 from app.candidates where id=p_candidate and lifecycle not in('deleting','deleted');
 if not found then raise exception 'Candidate not found' using errcode='P0002'; end if;
 cid:=coalesce(app.resolve_candidate_redirect_v1(p_candidate),p_candidate);
 -- Return nothing about a different owner's private source, including its existence.
 with recursive ancestors as (
  select c.id,array[c.id] seen from app.candidates c where c.id=cid
  union all select c.id,a.seen||c.id from ancestors a join app.candidates c on c.merged_into_id=a.id where c.lifecycle='merged' and not c.id=any(a.seen) and cardinality(a.seen)<16
 ) select exists(select 1 from ancestors a join app.telegram_drafts d on d.approved_candidate_id=a.id where d.status='approved' and not exists(select 1 from app.telegram_candidate_origins o join app.telegram_candidate_context_refs r on r.draft_id=o.draft_id where o.draft_id=d.id)) into missing;
 if p_after is not null and not exists(select 1 from app.telegram_candidate_context_refs r join app.candidate_sources s on s.id=r.candidate_source_id where r.id=p_after and s.candidate_id=cid) then raise exception 'Invalid context cursor' using errcode='22023'; end if;
 with page as materialized (
  select r.*,(to_jsonb(j)->>'source_invalidated_at') is not null as source_changed,exists(select 1 from app.telegram_history_messages m where m.chat_id=r.chat_id and m.message_id=r.message_id and m.body->>'kind'<>'unavailable') available
  from app.telegram_candidate_context_refs r join app.telegram_extraction_jobs j on j.id=r.extraction_job_id join app.candidate_sources s on s.id=r.candidate_source_id where s.candidate_id=cid and (p_after is null or r.id>p_after) order by r.id limit 51
 ), shown as (select * from page order by id limit 50)
 select jsonb_build_object('sources',coalesce((select jsonb_agg(jsonb_build_object('id',id,'chatId',chat_id,'messageId',message_id::text,'extractionJobId',extraction_job_id,'available',available,'sourceChanged',source_changed) order by id) from shown),'[]'::jsonb),
 'nextAfter',case when (select count(*) from page)>50 then (select id from shown order by id desc limit 1) else null end,
 'provenanceUnavailable',missing or exists(select 1 from shown where not available)) into result;
 return result;
end $$;
create function app.telegram_candidate_erase_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare prior_org text:=current_setting('app.organization_id',true);
begin
 if new.lifecycle in('deleting','deleted') and old.lifecycle is distinct from new.lifecycle then
  perform set_config('app.organization_id',new.organization_id::text,true);
  delete from app.telegram_candidate_context_refs r using app.candidate_sources s where r.candidate_source_id=s.id and s.candidate_id=new.id;
  delete from app.telegram_candidate_origins o using app.candidate_sources s where o.candidate_source_id=s.id and s.candidate_id=new.id;
  perform set_config('app.organization_id',coalesce(prior_org,''),true);
 end if; return new;
end $$;
create trigger telegram_candidate_erasure after update of lifecycle on app.candidates for each row execute function app.telegram_candidate_erase_v1();
create trigger telegram_candidate_approval after update of status on app.telegram_drafts for each row execute function app.telegram_candidate_capture_v1();
create trigger telegram_candidate_late_proposal after insert on app.telegram_extraction_proposals for each row execute function app.telegram_candidate_capture_v1();
create trigger telegram_candidate_late_attachment after insert on app.telegram_extraction_attachments for each row execute function app.telegram_candidate_capture_v1();
revoke all on function app.telegram_candidate_erase_v1(),app.telegram_candidate_origin_v1(uuid),app.telegram_candidate_refs_v1(uuid,uuid,jsonb),app.telegram_candidate_capture_v1(),app.telegram_candidate_context_v1(uuid,uuid) from public;
grant execute on function app.telegram_candidate_context_v1(uuid,uuid) to app_staff;
reset role; set local role app_owner;
revoke trigger on app.candidates,app.telegram_drafts,app.telegram_extraction_proposals,app.telegram_extraction_attachments from app_executor;
revoke create on schema app from app_executor;
reset role;
set local row_security=off;
-- The migration operator bypasses FORCE RLS, including inactive former owners.
-- Only unique original candidate sources and surviving exact subject references
-- are backfilled. Already purged/ambiguous references remain honestly unknown.
insert into app.telegram_candidate_origins(organization_id,owner_user_id,draft_id,candidate_source_id)
select d.organization_id,d.owner_user_id,d.id,(array_agg(s.id))[1]
from app.telegram_drafts d join app.candidate_sources s on s.organization_id=d.organization_id and s.candidate_id=d.candidate_target_id
join app.candidates c on c.organization_id=s.organization_id and c.id=s.candidate_id and c.lifecycle in('active','restricted')
join app.organization_memberships m on m.organization_id=s.organization_id and m.id=s.created_by_membership_id and m.user_id=d.owner_user_id
where d.status='approved' and s.context_summary='Added by staff' and s.received_at<=d.reviewed_at
group by d.organization_id,d.owner_user_id,d.id having count(*)=1 on conflict(draft_id) do nothing;
insert into app.telegram_candidate_context_refs(organization_id,owner_user_id,draft_id,candidate_source_id,chat_id,message_id,extraction_job_id)
select distinct o.organization_id,o.owner_user_id,o.draft_id,o.candidate_source_id,j.chat_id,q.message_id::bigint,j.id
from (
 select p.organization_id,p.owner_user_id,p.draft_id,p.job_id,e->>'messageId' message_id from app.telegram_extraction_proposals p cross join lateral jsonb_array_elements(p.evidence)e
 union select a.organization_id,a.owner_user_id,a.draft_id,a.job_id,a.message_id from app.telegram_extraction_attachments a
) q join app.telegram_candidate_origins o on o.organization_id=q.organization_id and o.owner_user_id=q.owner_user_id and o.draft_id=q.draft_id
join app.telegram_extraction_jobs j on j.organization_id=q.organization_id and j.owner_user_id=q.owner_user_id and j.id=q.job_id
join app.telegram_extraction_sources t on t.organization_id=q.organization_id and t.owner_user_id=q.owner_user_id and t.job_id=j.id and t.chat_id=j.chat_id and t.message_id=q.message_id::bigint
where q.message_id ~ '^[1-9][0-9]{0,9}$' and q.message_id::bigint<=2147483647
on conflict(candidate_source_id,chat_id,message_id) do nothing;
set local row_security=on;
commit;
