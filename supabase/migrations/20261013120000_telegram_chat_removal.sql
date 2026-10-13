-- Explicit private history removal is independent of extraction availability.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
alter table app.telegram_history_chats add column removal_state text not null default 'none' check(removal_state in('none','pending','device_pending','completed'));
create table app.telegram_chat_removals(
    id uuid primary key default gen_random_uuid(),
    organization_id uuid not null,
    owner_user_id uuid not null,
    chat_id uuid not null,
    operation_id uuid not null,
    expected_version bigint not null,
    requested_at timestamptz not null default clock_timestamp(),
    completed_at timestamptz,
    server_purged_at timestamptz,
    device_cleanup_at timestamptz,
    cleanup_worker_id uuid references app.telegram_workers(id),
    cleanup_token uuid,
    cleanup_cursor uuid,
    reimport_operation_id uuid,
    reimport_expected_version bigint,
    reimport_receipt jsonb,
    unique(organization_id,owner_user_id,reimport_operation_id),
    total_messages bigint not null,
    total_bytes bigint not null,
    removed_messages bigint not null default 0,
    removed_bytes bigint not null default 0,
    unique(organization_id,owner_user_id,operation_id),
    foreign key(organization_id,owner_user_id,chat_id) references app.telegram_history_chats(organization_id,owner_user_id,id)
);
create table app.telegram_chat_removal_objects(
    organization_id uuid not null,
    owner_user_id uuid not null,
    removal_id uuid not null references app.telegram_chat_removals(id),
    object_key text not null,
    primary key(removal_id,object_key)
);
alter table app.telegram_chat_removal_objects enable row level security;
alter table app.telegram_chat_removal_objects force row level security;
grant select,insert,delete on app.telegram_chat_removal_objects to app_executor;
create policy telegram_chat_removal_objects_owner on app.telegram_chat_removal_objects to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')) with check(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
create table app.telegram_chat_removal_cleanup_pages(
    organization_id uuid not null,
    owner_user_id uuid not null,
    removal_id uuid not null references app.telegram_chat_removals(id),
    token uuid primary key,
    cv_job_ids jsonb not null check(jsonb_typeof(cv_job_ids)='array' and jsonb_array_length(cv_job_ids)<=50),
    last_job_id uuid,
    final_page boolean not null,
    acknowledged_at timestamptz
);
alter table app.telegram_chat_removal_cleanup_pages enable row level security;
alter table app.telegram_chat_removal_cleanup_pages force row level security;
grant select,insert,update on app.telegram_chat_removal_cleanup_pages to app_executor;
create policy telegram_chat_removal_cleanup_owner on app.telegram_chat_removal_cleanup_pages to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')) with check(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
create unique index telegram_chat_removal_active_idx on app.telegram_chat_removals(chat_id) where completed_at is null;
create index telegram_chat_removal_history_idx on app.telegram_chat_removals(chat_id,requested_at desc,id desc);
create index telegram_chat_removal_queue_idx on app.telegram_chat_removals(requested_at,id) where completed_at is null;
alter table app.telegram_chat_removals enable row level security;
alter table app.telegram_chat_removals force row level security;
grant select,insert,update on app.telegram_chat_removals to app_executor;
create policy telegram_chat_removal_owner on app.telegram_chat_removals to app_executor using(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id')) with check(organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id'));
-- Only the execution-only global maintenance function uses this queue policy.
create policy telegram_chat_removal_queue on app.telegram_chat_removals for select to app_executor using(completed_at is null);
grant trigger on app.telegram_history_chats,app.telegram_history_jobs,app.telegram_history_messages,app.telegram_extraction_jobs,app.telegram_cv_jobs,app.cv_analyses,app.telegram_drafts,app.telegram_upload_cleanup to app_executor;
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create function app.telegram_chat_removal_json_v1(r app.telegram_chat_removals) returns jsonb language sql stable set search_path=pg_catalog,app,pg_temp as $$
select jsonb_build_object('id',r.id,'chatId',r.chat_id,'state',case when r.completed_at is not null then
'completed' when r.server_purged_at is not null then
'device_pending' else
'pending' end,'requestedAt',r.requested_at,'completedAt',r.completed_at,'totalMessages',r.total_messages,'totalBytes',r.total_bytes,'removedMessages',r.removed_messages,'removedBytes',r.removed_bytes,'serverPurged',r.server_purged_at is not null,'deviceCleanupPending',r.device_cleanup_at is null,'storageCleanupPending',exists(select 1 from app.telegram_chat_removal_objects o join app.telegram_upload_cleanup c on c.object_key=o.object_key where o.removal_id=r.id),'approvedCandidatesPreserved',true) $$;
create function app.telegram_chat_removal_status_v1(p_chat uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    ch app.telegram_history_chats;
    r app.telegram_chat_removals;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    select * into ch from app.telegram_history_chats where id=p_chat;
    if not found then
        raise exception 'Chat unavailable' using errcode='P0002';
    end if;
    select * into r from app.telegram_chat_removals where chat_id=ch.id and organization_id=ch.organization_id and owner_user_id=ch.owner_user_id order by requested_at desc,id desc limit 1;
    return jsonb_build_object('chatId',ch.id,'version',ch.version,'state',ch.removal_state,'removal',case when r.id is null then
    null else
    app.telegram_chat_removal_json_v1(r) end);
end $$;
create function app.telegram_chat_removal_preview_v1(p_chat uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    ch app.telegram_history_chats;
    n bigint;
    b bigint;
    open_drafts bigint;
    approved bigint;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    select * into ch from app.telegram_history_chats where id=p_chat;
    if not found then
        raise exception 'Chat unavailable' using errcode='P0002';
    end if;
    select count(*),coalesce(sum(stored_bytes),0) into n,b from app.telegram_history_messages where chat_id=ch.id;
    select count(distinct d.id) filter(where d.status in('pending','snoozed','duplicate')),count(distinct d.approved_candidate_id) filter(where d.status='approved') into open_drafts,approved from app.telegram_extraction_jobs j cross join lateral app.telegram_retention_drafts_v1(j.id) refs join app.telegram_drafts d on d.id=refs.id where j.chat_id=ch.id;
    return jsonb_build_object('chatId',ch.id,'title',ch.title,'version',ch.version,'state',ch.removal_state,'messages',n,'bytes',b,'unapprovedDrafts',open_drafts,'approvedCandidates',approved,'confirmation','remove_imported_history','scope','Remove this chat''s imported messages, private source copies and affected unapproved drafts. Approved candidate profiles and documents remain separately managed. Telegram messages are not deleted.');
end $$;
create function app.telegram_chat_removal_guard_v1() returns trigger language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    chat uuid;
    state text;
begin
    if tg_table_name='telegram_history_chats' then
        if new.removal_state<>'none' and (new.selected or new.extraction_enabled) then
            raise exception 'Chat removal must finish before reimport' using errcode='40001';
        end if;
        return new;
    elsif tg_table_name='telegram_drafts' then
        if new.status='approved' and old.status<>'approved' and exists(select 1 from app.telegram_extraction_jobs j cross join lateral app.telegram_retention_drafts_v1(j.id) refs join app.telegram_history_chats c on c.id=j.chat_id where refs.id=new.id and c.removal_state in('pending','device_pending')) then
            raise exception 'Draft source is being removed' using errcode='40001';
        end if;
        return new;
    end if;
    if tg_table_name='cv_analyses' then
        if new.status in('queued','leased','waiting') and exists(select 1 from app.telegram_extraction_jobs j cross join lateral app.telegram_retention_drafts_v1(j.id) refs join app.telegram_history_chats c on c.id=j.chat_id where refs.id=new.draft_id and c.removal_state<>'none') then
            raise exception 'Draft source is being removed' using errcode='40001';
        end if;
        return new;
    end if;
    if tg_table_name='telegram_cv_jobs' then
        select chat_id into chat from app.telegram_extraction_jobs where id=new.extraction_job_id;
    else
        chat:=new.chat_id;
    end if;
    select removal_state into state from app.telegram_history_chats where id=chat;
    if state is distinct from 'none' and state is not null then
        if tg_table_name='telegram_history_messages' then
            raise exception 'Chat source is being removed' using errcode='40001';
        elsif new.status in('queued','leased','waiting') then
            raise exception 'Chat source is being removed' using errcode='40001';
        end if;
    end if;
    return new;
end $$;
create trigger telegram_chat_removal_selection before insert or update on app.telegram_history_chats for each row execute function app.telegram_chat_removal_guard_v1();
create trigger telegram_chat_removal_import before insert or update on app.telegram_history_jobs for each row execute function app.telegram_chat_removal_guard_v1();
create trigger telegram_chat_removal_message before insert or update on app.telegram_history_messages for each row execute function app.telegram_chat_removal_guard_v1();
create trigger telegram_chat_removal_extraction before insert or update on app.telegram_extraction_jobs for each row execute function app.telegram_chat_removal_guard_v1();
create trigger telegram_chat_removal_cv before insert or update on app.telegram_cv_jobs for each row execute function app.telegram_chat_removal_guard_v1();
create trigger telegram_chat_removal_analysis before insert or update on app.cv_analyses for each row execute function app.telegram_chat_removal_guard_v1();
create trigger telegram_chat_removal_approval before update of status on app.telegram_drafts for each row execute function app.telegram_chat_removal_guard_v1();
create function app.telegram_chat_removal_reservation_guard_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare affected record;
begin
    if new.available_at <= clock_timestamp()+interval '30 minutes' then return new; end if;
    -- The request holds this same chat row FOR UPDATE before its reservation
    -- snapshot. Earlier reserves finish first; later reserves wait and reject.
    for affected in
        select chat.id, chat.removal_state from app.telegram_history_chats chat
        where exists(select 1 from app.telegram_drafts draft
            join app.telegram_extraction_jobs job on job.chat_id=chat.id
                and job.organization_id=draft.organization_id and job.owner_user_id=draft.owner_user_id
            cross join lateral app.telegram_retention_drafts_v1(job.id) refs
            where refs.id=draft.id and draft.status<>'approved'
                and new.organization_id=draft.organization_id and new.owner_user_id=draft.owner_user_id
                and new.object_key like 'staff/'||draft.organization_id||'/'||draft.candidate_target_id||'/%')
        order by chat.id for share of chat
    loop
        if affected.removal_state<>'none' then
            raise exception 'Draft source is being removed' using errcode='40001';
        end if;
    end loop;
    return new;
end $$;
revoke all on function app.telegram_chat_removal_reservation_guard_v1() from public;
create trigger telegram_chat_removal_reservation before insert on app.telegram_upload_cleanup
    for each row execute function app.telegram_chat_removal_reservation_guard_v1();
create function app.telegram_chat_removal_request_v1(p_chat uuid,p_version bigint,p_operation uuid,p_confirmation text) returns jsonb language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    ch app.telegram_history_chats;
    r app.telegram_chat_removals;
    n bigint;
    b bigint;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    if p_operation is null or p_version is null or p_version<1 or p_confirmation is distinct from 'remove_imported_history' then
        raise exception 'Explicit confirmation required' using errcode='22023';
    end if;
    perform app.telegram_extraction_lock_v1();
    if exists(select 1 from app.telegram_chat_removals where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and reimport_operation_id=p_operation) then
        raise exception 'Operation changed' using errcode='40001';
    end if;
    select * into r from app.telegram_chat_removals where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and operation_id=p_operation;
    if found then
        if r.chat_id<>p_chat or r.expected_version<>p_version then
            raise exception 'Operation changed' using errcode='40001';
        end if;
        return app.telegram_chat_removal_status_v1(p_chat);
    end if;
    select * into ch from app.telegram_history_chats where id=p_chat for update;
    if not found then
        raise exception 'Chat unavailable' using errcode='P0002';
    end if;
    if ch.version<>p_version or ch.removal_state<>'none' then
        raise exception 'Chat changed' using errcode='40001';
    end if;
    select count(*),coalesce(sum(stored_bytes),0) into n,b from app.telegram_history_messages where chat_id=ch.id;
    insert into app.telegram_chat_removals(organization_id,owner_user_id,chat_id,operation_id,expected_version,total_messages,total_bytes,cleanup_worker_id) values(ch.organization_id,ch.owner_user_id,ch.id,p_operation,p_version,n,b,(select worker_id from app.telegram_connections where id=(select connection_id from app.telegram_history_accounts where id=ch.account_id)));
    -- Reservations may already have an in-flight private upload. Retain the
    -- original one-hour available_at fence and wait for storage disposition.
    insert into app.telegram_chat_removal_objects(organization_id,owner_user_id,removal_id,object_key)
    select distinct cleanup.organization_id,cleanup.owner_user_id,removal.id,cleanup.object_key
    from app.telegram_chat_removals removal
    join app.telegram_extraction_jobs job on job.chat_id=removal.chat_id
    cross join lateral app.telegram_retention_drafts_v1(job.id) refs
    join app.telegram_drafts draft on draft.id=refs.id and draft.status<>'approved'
    join app.telegram_upload_cleanup cleanup on cleanup.organization_id=draft.organization_id
        and cleanup.owner_user_id=draft.owner_user_id
        and cleanup.object_key like 'staff/'||draft.organization_id||'/'||draft.candidate_target_id||'/%'
    where removal.chat_id=ch.id and removal.completed_at is null
    on conflict do nothing;
    update app.telegram_history_chats set selected=false,extraction_enabled=false,extraction_pending=false,removal_state='pending',version=version+1,next_sync_at=null where id=ch.id;
    update app.telegram_history_jobs set status='cancelled',lease_token=null,lease_expires_at=null,error_code='CHAT_REMOVAL' where chat_id=ch.id;
    -- Close all current leases atomically; the bounded worker removes their content.
    update app.telegram_extraction_jobs set status='completed',lease_token=null,lease_expires_at=null,result_digest=null,error_code='CHAT_REMOVAL',source_release_requested_at=coalesce(source_release_requested_at,clock_timestamp()),cleanup_due_at=clock_timestamp() where chat_id=ch.id and source_purged_at is null;
    update app.telegram_cv_jobs cv set status='cancelled',lease_token=null,lease_expires_at=null,upload_lease_token=null,error_code='CHAT_REMOVAL' from app.telegram_extraction_jobs j where cv.extraction_job_id=j.id and j.chat_id=ch.id and cv.status in('queued','leased','waiting');
    update app.cv_analyses a0 set status='cancelled',lease_token=null,lease_expires_at=null,error_code='SOURCE_CHANGED' from app.telegram_extraction_jobs j where j.chat_id=ch.id and (a0.extraction_job_id=j.id or a0.draft_id in(select id from app.telegram_retention_drafts_v1(j.id))) and a0.status in('queued','leased','waiting');
    update app.telegram_source_sweeps s set lease_token=null,lease_expires_at=null,ids=null from app.telegram_history_chats c where c.id=s.chat_id and c.account_id=ch.account_id;
    update app.telegram_native_accounts set lease_token=null,lease_expires_at=null,scope_digest=null where account_id=ch.account_id;
    update app.telegram_native_channels set lease_token=null,lease_expires_at=null,scope_digest=null where account_id=ch.account_id;
    -- Mixed native/source account pages are fenced; other history/CV leases and
    -- their private pending pages remain intact for the unaffected chats.
    perform app.telegram_maintenance_schedule_v1(clock_timestamp());
    return app.telegram_chat_removal_status_v1(ch.id);
end $$;
-- Ordinary reviewed-source cleanup must not bypass removal progress receipts.
alter function app.telegram_retention_purge_v1(uuid) rename to telegram_retention_purge_before_chat_removal_v1;
revoke all on function app.telegram_retention_purge_before_chat_removal_v1(uuid) from public;
create function app.telegram_retention_purge_v1(p_id uuid) returns jsonb language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
begin
    if current_setting('app.chat_removal_purge',true) is distinct from '1' and exists(select 1 from app.telegram_extraction_jobs j join app.telegram_history_chats c on c.id=j.chat_id where j.id=p_id and c.removal_state in('pending','device_pending')) then
        return jsonb_build_object('purged',false);
    end if;
    return app.telegram_retention_purge_before_chat_removal_v1(p_id);
end $$;
revoke all on function app.telegram_retention_purge_v1(uuid) from public;
create function app.telegram_chat_removal_step_v1(p_chat uuid) returns jsonb language plpgsql volatile set search_path=pg_catalog,app,pg_temp as $$
declare
    r app.telegram_chat_removals;
    j record;
    d app.telegram_drafts;
    a app.cv_analyses;
    purge jsonb;
    removed bigint:=0;
    bytes bigint:=0;
    n bigint;
    b bigint;
    progressed boolean:=false;
    done boolean:=false;
    prior_purge text:=current_setting('app.chat_removal_purge',true);
begin
    perform 1 from app.telegram_history_limits where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') for update nowait;
    select * into r from app.telegram_chat_removals where chat_id=p_chat and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and completed_at is null for update nowait;
    if not found then
        return jsonb_build_object('progressed',false,'messagesPurged',0,'bytesFreed',0,'completed',true);
    end if;
    if r.server_purged_at is not null then
        if r.device_cleanup_at is null or exists(select 1 from app.telegram_chat_removal_objects o join app.telegram_upload_cleanup c on c.object_key=o.object_key where o.removal_id=r.id) then
            return jsonb_build_object('progressed',false,'messagesPurged',0,'bytesFreed',0,'completed',false);
        end if;
        update app.telegram_chat_removals set completed_at=clock_timestamp() where id=r.id;
        update app.telegram_history_chats set removal_state='completed',version=version+1 where id=p_chat;
        return jsonb_build_object('progressed',true,'messagesPurged',0,'bytesFreed',0,'completed',true);
    end if;
    -- Each extraction batch is bounded to forty subjects/messages. Consumer locks
    -- use NOWAIT, so a busy draft postpones this batch without starving raw cleanup.
    for j in select parent.id from app.telegram_extraction_jobs parent where parent.chat_id=p_chat and parent.source_purged_at is null and not exists(select 1 from app.telegram_extraction_context_dependencies dep join app.telegram_extraction_jobs child on child.id=dep.job_id where dep.origin_job_id=parent.id and child.id<>parent.id and child.source is not null and child.source_purged_at is null) order by parent.id limit 5 loop
        begin
            for d in select t.* from app.telegram_drafts t join app.telegram_retention_drafts_v1(j.id) refs on refs.id=t.id order by t.id for update of t nowait loop
                update app.telegram_drafts set source_title='Removed Telegram history' where id=d.id and source_title<>'Removed Telegram history';
                if d.status<>'approved' then
                    if d.document->>'objectKey' is not null then
                        insert into app.telegram_chat_removal_objects values(d.organization_id,d.owner_user_id,r.id,d.document->>'objectKey') on conflict do nothing;
                        insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key) values(d.organization_id,d.owner_user_id,d.document->>'objectKey') on conflict do nothing;
                    end if;
                    update app.telegram_drafts set status='discarded',fields='{}',document=null,human_fields='{}',source_title='Removed Telegram history',version=version+1,reviewed_at=clock_timestamp(),updated_at=clock_timestamp() where id=d.id;
                    delete from app.telegram_draft_embeddings where draft_id=d.id;
                    update app.telegram_jobs set status='cancelled',payload='{}',result_sha256=null,lease_token=null,lease_expires_at=null,finished_at=clock_timestamp() where draft_id=d.id;
                    delete from app.telegram_extraction_subjects where draft_id=d.id;
                    for a in select * from app.cv_analyses where draft_id=d.id and (purged_at is null or filename<>'') order by id limit 50 for update nowait loop
                        if a.object_key<>'' then
                            insert into app.telegram_chat_removal_objects values(d.organization_id,d.owner_user_id,r.id,a.object_key) on conflict do nothing;
                            insert into app.telegram_upload_cleanup(organization_id,owner_user_id,object_key) values(d.organization_id,d.owner_user_id,a.object_key) on conflict do nothing;
                        end if;
                        delete from app.cv_analysis_proposals where analysis_id=a.id;
                        update app.cv_analyses set status='cancelled',blocks=null,issues='[]',metadata=null,filename='',object_key='',parse_receipt=null,facts_receipt=null,lease_token=null,lease_expires_at=null,text_decision='exclude',purged_at=clock_timestamp(),cleanup_due_at=null,version=version+1 where id=a.id;
                        end loop
                        ;
                        with unlinked as(delete from app.telegram_draft_evidence where draft_id=d.id returning evidence_id) delete from app.telegram_evidence e where e.id in(select evidence_id from unlinked) and not exists(select 1 from app.telegram_draft_evidence x where x.evidence_id=e.id and x.draft_id<>d.id);
                    end if;
                    end loop
                    ;
                    update app.telegram_extraction_proposals set status='dismissed',suggested_value='null',evidence='[]' where job_id=j.id;
                    -- Source-derived CV analysis copies are private; reviewed candidate document
                    -- and reviewed CV-text projections are separate and remain intact.
                    for a in select * from app.cv_analyses where extraction_job_id=j.id and (purged_at is null or filename<>'') order by id limit 50 for update nowait loop
                        delete from app.cv_analysis_proposals where analysis_id=a.id;
                        update app.cv_analyses set status=case when status in('queued','leased','waiting') then
                        'cancelled' else
                        status end,blocks=null,issues='[]',metadata=null,filename='',object_key='',parse_receipt=null,facts_receipt=null,lease_token=null,lease_expires_at=null,text_decision='exclude',purged_at=clock_timestamp(),cleanup_due_at=null,version=version+1 where id=a.id;
                        end loop
                        ;
                        if exists(select 1 from app.cv_analyses a0 join app.telegram_drafts d0 on d0.id=a0.draft_id where (a0.extraction_job_id=j.id or d0.status<>'approved' and d0.id in(select id from app.telegram_retention_drafts_v1(j.id))) and (a0.purged_at is null or a0.filename<>'')) then
                            continue;
                        end if;
                        perform set_config('app.chat_removal_purge','1',true);
                        purge:=app.telegram_retention_purge_v1(j.id);
                        perform set_config('app.chat_removal_purge',coalesce(prior_purge,''),true);
                        if (purge->>'purged')::boolean then
                            removed:=removed+(purge->>'messages')::bigint;
                            bytes:=bytes+(purge->>'bytes')::bigint;
                            progressed:=true;
                        end if;
                    exception when lock_not_available then
                        perform set_config('app.chat_removal_purge',coalesce(prior_purge,''),true);
                        end;
                        end loop
                        ;
                        with gone as(delete from app.telegram_history_messages where (chat_id,message_id) in(select chat_id,message_id from app.telegram_history_messages raw where raw.chat_id=p_chat and not exists(select 1 from app.telegram_extraction_jobs primary_source where primary_source.id=raw.extraction_job_id and primary_source.source is not null and primary_source.source_purged_at is null) and not exists(select 1 from app.telegram_extraction_context_dependencies dep join app.telegram_extraction_jobs copied_source on copied_source.id=dep.job_id where dep.chat_id=raw.chat_id and dep.message_id=raw.message_id and copied_source.source is not null and copied_source.source_purged_at is null) order by message_id limit 1000) returning stored_bytes) select count(*),coalesce(sum(stored_bytes),0) into n,b from gone;
                        if n>0 then
                            update app.telegram_history_limits set stored_messages=stored_messages-n,stored_bytes=stored_bytes-b where organization_id=r.organization_id and owner_user_id=r.owner_user_id;
                            removed:=removed+n;
                            bytes:=bytes+b;
                            progressed:=true;
                        end if;
                        -- Remove identity-only context refs before allowing the same Telegram message
                        -- IDs to be imported again. Old approved provenance can never resolve new text.
                        if not exists(select 1 from app.telegram_history_messages where chat_id=p_chat) and not exists(select 1 from app.telegram_extraction_jobs where chat_id=p_chat and source_purged_at is null) then
                            with gone as(delete from app.telegram_candidate_context_refs where id in(select id from app.telegram_candidate_context_refs where chat_id=p_chat order by id limit 1000) returning 1) select count(*) into n from gone;
                            progressed:=progressed or n>0;
                            with gone as(delete from app.telegram_extraction_context_dependencies where (job_id,message_id) in(select job_id,message_id from app.telegram_extraction_context_dependencies where chat_id=p_chat order by job_id,message_id limit 1000) returning 1) select count(*) into n from gone;
                            progressed:=progressed or n>0;
                            with gone as(delete from app.telegram_extraction_sources where (chat_id,message_id) in(select chat_id,message_id from app.telegram_extraction_sources where chat_id=p_chat order by message_id limit 1000) returning 1) select count(*) into n from gone;
                            progressed:=progressed or n>0;
                            done:=not exists(select 1 from app.telegram_candidate_context_refs where chat_id=p_chat) and not exists(select 1 from app.telegram_extraction_context_dependencies where chat_id=p_chat) and not exists(select 1 from app.telegram_extraction_sources where chat_id=p_chat);
                        end if;
                        update app.telegram_chat_removals set removed_messages=removed_messages+removed,removed_bytes=removed_bytes+bytes,server_purged_at=case when done then
                        coalesce(server_purged_at,clock_timestamp()) else
                        server_purged_at end where id=r.id;
                        if done then
                            done:=r.device_cleanup_at is not null and not exists(select 1 from app.telegram_chat_removal_objects o join app.telegram_upload_cleanup c on c.object_key=o.object_key where o.removal_id=r.id);
                            update app.telegram_chat_removals set completed_at=case when done then
                            clock_timestamp() else
                            null end where id=r.id;
                            update app.telegram_history_chats set removal_state=case when done then
                            'completed' else
                            'device_pending' end,extraction_pending=false,source_needs_reextraction=false,history_completed=false,sync_checkpoint=0,last_sync_at=null,next_sync_at=null,version=version+1 where id=p_chat;
                        end if;
                        return jsonb_build_object('progressed',progressed,'messagesPurged',removed,'bytesFreed',bytes,'completed',done);
end $$;
create function app.telegram_chat_removal_maintenance_v1(p_limit integer default 5) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    r record;
    s jsonb;
    messages bigint:=0;
    bytes bigint:=0;
    completed integer:=0;
    prior_org text:=current_setting('app.organization_id',true);
    prior_actor text:=current_setting('app.actor_id',true);
begin
    if p_limit is null or p_limit not between 1 and 5 then
        raise exception 'Invalid removal bound' using errcode='22023';
    end if;
    for r in select organization_id,owner_user_id,chat_id from app.telegram_chat_removals where completed_at is null and (server_purged_at is null or device_cleanup_at is not null) order by (server_purged_at is not null),requested_at,id limit p_limit loop
        perform set_config('app.organization_id',r.organization_id::text,true);
        perform set_config('app.actor_id',r.owner_user_id::text,true);
        begin
            s:=app.telegram_chat_removal_step_v1(r.chat_id);
            messages:=messages+(s->>'messagesPurged')::bigint;
            bytes:=bytes+(s->>'bytesFreed')::bigint;
            if (s->>'completed')::boolean then
                completed:=completed+1;
            end if;
        exception when lock_not_available then
            null;
            end;
            end loop
            ;
            perform set_config('app.organization_id',coalesce(prior_org,''),true);
            perform set_config('app.actor_id',coalesce(prior_actor,''),true);
            return jsonb_build_object('messagesPurged',messages,'bytesFreed',bytes,'removalsCompleted',completed,'remainingWork',exists(select 1 from app.telegram_chat_removals where completed_at is null));
        exception when others then
            perform set_config('app.organization_id',coalesce(prior_org,''),true);
            perform set_config('app.actor_id',coalesce(prior_actor,''),true);
            raise;
end $$;
create function app.telegram_chat_removal_cleanup_claim_v1(p_token text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    w uuid;
    r app.telegram_chat_removals;
    a app.telegram_history_accounts;
    p app.telegram_chat_removal_cleanup_pages;
    ids jsonb;
    last_id uuid;
    has_more boolean;
begin
    w:=app.telegram_worker_context_v1(p_token);
    select r0.* into r from app.telegram_chat_removals r0 where r0.organization_id=app.context_uuid_v1('app.organization_id') and r0.owner_user_id=app.context_uuid_v1('app.actor_id') and r0.cleanup_worker_id=w and r0.server_purged_at is not null and r0.device_cleanup_at is null order by r0.requested_at,r0.id limit 1 for update;
    if not found then
        return jsonb_build_object('cleanup',null);
    end if;
    select a0.* into strict a from app.telegram_history_accounts a0 join app.telegram_history_chats c on c.account_id=a0.id where c.id=r.chat_id;
    -- Fence leases issued while asynchronous server cleanup was in progress.
    update app.telegram_source_sweeps s set lease_token=null,lease_expires_at=null,ids=null from app.telegram_history_chats c where c.id=s.chat_id and c.account_id=a.id;
    update app.telegram_native_accounts set lease_token=null,lease_expires_at=null,scope_digest=null where account_id=a.id;
    update app.telegram_native_channels set lease_token=null,lease_expires_at=null,scope_digest=null where account_id=a.id;
    if r.cleanup_token is null then
        with chosen as(select cv.id from app.telegram_cv_jobs cv join app.telegram_extraction_jobs j on j.id=cv.extraction_job_id where j.chat_id=r.chat_id and (r.cleanup_cursor is null or cv.id>r.cleanup_cursor) order by cv.id limit 51),shown as(select id from chosen order by id limit 50) select coalesce((select jsonb_agg(id order by id) from shown),'[]'),(select id from shown order by id desc limit 1),(select count(*)>50 from chosen) into ids,last_id,has_more;
        update app.telegram_chat_removals set cleanup_token=gen_random_uuid() where id=r.id returning * into r;
        insert into app.telegram_chat_removal_cleanup_pages values(r.organization_id,r.owner_user_id,r.id,r.cleanup_token,ids,last_id,not has_more,null);
    end if;
    select * into strict p from app.telegram_chat_removal_cleanup_pages where token=r.cleanup_token;
    return jsonb_build_object('cleanup',jsonb_build_object('removalId',r.id,'chatId',r.chat_id,'connectionId',a.connection_id,'accountUserId',a.account_user_id,'historyJobId',(select id from app.telegram_history_jobs where chat_id=r.chat_id),'peer',(select jsonb_build_object('kind',peer_kind,'id',peer_id) from app.telegram_history_chats where id=r.chat_id),'cvJobIds',p.cv_job_ids,'cleanupToken',r.cleanup_token));
end $$;
create function app.telegram_chat_removal_cleanup_ack_v1(p_token text,p_removal uuid,p_proof uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    w uuid;
    r app.telegram_chat_removals;
    p app.telegram_chat_removal_cleanup_pages;
begin
    w:=app.telegram_worker_context_v1(p_token);
    select * into r from app.telegram_chat_removals where id=p_removal and organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and cleanup_worker_id=w for update;
    if not found or p_proof is null or r.server_purged_at is null then
        raise exception 'Cleanup changed' using errcode='40001';
    end if;
    select * into p from app.telegram_chat_removal_cleanup_pages where removal_id=r.id and token=p_proof;
    if not found then
        raise exception 'Cleanup changed' using errcode='40001';
    end if;
    if p.acknowledged_at is not null then
        return jsonb_build_object('ok',true);
    end if;
    if r.cleanup_token is distinct from p_proof then
        raise exception 'Cleanup page changed' using errcode='40001';
    end if;
    update app.telegram_chat_removal_cleanup_pages set acknowledged_at=clock_timestamp() where token=p_proof;
    update app.telegram_chat_removals set cleanup_cursor=p.last_job_id,cleanup_token=null,device_cleanup_at=case when p.final_page then
    clock_timestamp() else
    null end where id=r.id;
    perform app.telegram_chat_removal_step_v1(r.chat_id);
    return jsonb_build_object('ok',true);
end $$;
create function app.telegram_chat_removal_reimport_v1(p_chat uuid,p_version bigint,p_operation uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    ch app.telegram_history_chats;
    r app.telegram_chat_removals;
    c app.telegram_connections;
    receipt jsonb;
begin
    perform app.recruitment_actor_v1(array['candidates.read','candidates.write'],null,null,false);
    if p_operation is null or p_version is null or p_version<1 then
        raise exception 'Invalid reimport' using errcode='22023';
    end if;
    perform app.telegram_extraction_lock_v1();
    if exists(select 1 from app.telegram_chat_removals where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and operation_id=p_operation) then
        raise exception 'Operation changed' using errcode='40001';
    end if;
    select * into r from app.telegram_chat_removals where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and reimport_operation_id=p_operation;
    if found then
        if r.chat_id<>p_chat or r.reimport_expected_version<>p_version then
            raise exception 'Operation changed' using errcode='40001';
        end if;
        return r.reimport_receipt;
    end if;
    select * into ch from app.telegram_history_chats where id=p_chat for update;
    if not found then
        raise exception 'Chat unavailable' using errcode='P0002';
    end if;
    if ch.version<>p_version or ch.removal_state<>'completed' then
        raise exception 'Removal is not complete' using errcode='40001';
    end if;
    c:=app.telegram_history_connected_v1();
    if not exists(select 1 from app.telegram_history_accounts where id=ch.account_id and connection_id=c.id and account_user_id=c.profile->>'telegramUserId') then
        raise exception 'Reconnect the same account' using errcode='40001';
    end if;
    select * into strict r from app.telegram_chat_removals where chat_id=p_chat and organization_id=ch.organization_id and owner_user_id=ch.owner_user_id order by requested_at desc,id desc limit 1 for update;
    update app.telegram_history_chats set removal_state='none',selected=true,extraction_enabled=false,extraction_pending=false,version=version+1,oldest_imported_at=null,newest_imported_at=null where id=p_chat returning * into ch;
    -- Fresh run identity and lease ensure old receipts can never become writes.
    insert into app.telegram_history_jobs(organization_id,owner_user_id,account_id,chat_id,kind,connection_generation,status,cursor) values(ch.organization_id,ch.owner_user_id,ch.account_id,ch.id,'history',c.generation,'queued',jsonb_build_object('beforeMessageId',null,'upperMessageId',null)) on conflict(chat_id) where kind='history' do update set status='queued',connection_generation=excluded.connection_generation,run_id=gen_random_uuid(),cursor=excluded.cursor,page_number=0,imported_messages=0,imported_bytes=0,attempts=0,lease_token=null,lease_expires_at=null,retry_at=null,error_code=null,last_progress_at=null;
    receipt:=jsonb_build_object('chatId',ch.id,'version',ch.version,'state','reimport_requested');
    update app.telegram_chat_removals set reimport_operation_id=p_operation,reimport_expected_version=p_version,reimport_receipt=receipt where id=r.id;
    return receipt;
end $$;
-- Efficient polls carry an owner-only cleanup plan rather than issuing an
-- additional empty request. Scheduling hints grant no deletion authority.
alter function app.telegram_work_plan_v1(uuid) rename to telegram_work_plan_before_removal_v1;
revoke all on function app.telegram_work_plan_before_removal_v1(uuid) from public;
create function app.telegram_work_plan_v1(p_worker uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    plan jsonb;
begin
    plan:=app.telegram_work_plan_before_removal_v1(p_worker);
    if exists(select 1 from app.telegram_chat_removals where organization_id=app.context_uuid_v1('app.organization_id') and owner_user_id=app.context_uuid_v1('app.actor_id') and cleanup_worker_id=p_worker and server_purged_at is not null and device_cleanup_at is null) then
        plan:=jsonb_set(plan,'{source}','true');
    end if;
    return plan;
end $$;
revoke all on function app.telegram_work_plan_v1(uuid) from public;
alter function app.telegram_connection_poll_v1(text,text) rename to telegram_connection_poll_before_removal_v1;
revoke all on function app.telegram_connection_poll_before_removal_v1(text,text) from public,app_telegram_worker;
create function app.telegram_connection_poll_v1(p_token text,p_key text) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    result jsonb;
    cleanup jsonb;
begin
    result:=app.telegram_connection_poll_before_removal_v1(p_token,p_key);
    cleanup:=app.telegram_chat_removal_cleanup_claim_v1(p_token);
    return result||cleanup;
end $$;
revoke all on function app.telegram_connection_poll_v1(text,text) from public;
grant execute on function app.telegram_connection_poll_v1(text,text) to app_telegram_worker;
-- Add removal to the bounded existing history DTO without duplicating its query.
alter function app.telegram_history_status_v1(text,text,uuid) rename to telegram_history_status_before_removal_v1;
revoke all on function app.telegram_history_status_before_removal_v1(text,text,uuid) from public,app_staff;
create function app.telegram_history_status_v1(p_view text,p_q text,p_after uuid) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    result jsonb;
    rows jsonb;
begin
    result:=app.telegram_history_status_before_removal_v1(p_view,p_q,p_after);
    select coalesce(jsonb_agg(ch.value||jsonb_build_object('removalState',c.removal_state,'removal',case when r.id is null then
    null else
    app.telegram_chat_removal_json_v1(r) end) order by ch.ordinality),'[]') into rows from jsonb_array_elements(result->'chats') with ordinality ch(value,ordinality) join app.telegram_history_chats c on c.id=(ch.value->>'id')::uuid left join lateral(select r0.* from app.telegram_chat_removals r0 where r0.chat_id=c.id and r0.organization_id=c.organization_id and r0.owner_user_id=c.owner_user_id order by r0.requested_at desc,r0.id desc limit 1) r on true;
    return jsonb_set(result,'{chats}',rows);
end $$;
alter function app.telegram_maintenance_v1(integer) rename to telegram_maintenance_before_removal_v1;
revoke all on function app.telegram_maintenance_before_removal_v1(integer) from public,app_telegram_maintenance;
create function app.telegram_maintenance_v1(p_limit integer default 10) returns jsonb language plpgsql volatile security definer set search_path=pg_catalog,app,pg_temp as $$
declare
    result jsonb;
    removed jsonb;
begin
    if p_limit is null or p_limit not between 1 and 10 then
        raise exception 'Invalid maintenance bound' using errcode='22023';
    end if;
    -- Removal closes holds before ordinary retention chooses eligible batches.
    removed:=app.telegram_chat_removal_maintenance_v1(least(5,p_limit));
    result:=app.telegram_maintenance_before_removal_v1(p_limit);
    return result||jsonb_build_object('messagesPurged',(result->>'messagesPurged')::bigint+(removed->>'messagesPurged')::bigint,'bytesFreed',(result->>'bytesFreed')::bigint+(removed->>'bytesFreed')::bigint,'removalsCompleted',removed->'removalsCompleted','remainingWork',(result->>'remainingWork')::boolean or (removed->>'remainingWork')::boolean);
end $$;
do $$
declare
    f record;
begin
    for f in select oid::regprocedure signature from pg_proc where pronamespace='app'::regnamespace and proname like 'telegram_chat_removal_%' loop
        execute format('revoke all on function %s from public',f.signature);
        end loop
        ;
end $$;
revoke all on function app.telegram_history_status_v1(text,text,uuid),app.telegram_maintenance_v1(integer) from public;
grant execute on function app.telegram_chat_removal_preview_v1(uuid),app.telegram_chat_removal_status_v1(uuid),app.telegram_chat_removal_request_v1(uuid,bigint,uuid,text),app.telegram_chat_removal_reimport_v1(uuid,bigint,uuid),app.telegram_history_status_v1(text,text,uuid) to app_staff;
grant execute on function app.telegram_chat_removal_cleanup_claim_v1(text),app.telegram_chat_removal_cleanup_ack_v1(text,uuid,uuid) to app_telegram_worker;
grant execute on function app.telegram_maintenance_v1(integer) to app_telegram_maintenance;
reset role;
set local role app_owner;
revoke trigger on app.telegram_history_chats,app.telegram_history_jobs,app.telegram_history_messages,app.telegram_extraction_jobs,app.telegram_cv_jobs,app.cv_analyses,app.telegram_drafts,app.telegram_upload_cleanup from app_executor;
revoke create on schema app from app_executor;
commit;
