-- Preserve fresh document authorization while permitting private in-memory
-- preview reuse. The opaque version tracks the blob, document and verified
-- location. Retired/restricted documents and inactive candidates are refused.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
begin
    if current_setting('server_version_num')::integer / 10000 <> 17 then
        raise exception 'Foundation requires PostgreSQL 17';
    end if;
    if not (select rolsuper from pg_catalog.pg_roles where rolname = session_user) then
        execute format('grant app_owner to %I with inherit true, set true', session_user);
        execute format('grant app_executor to %I with set true, inherit false', session_user);
    end if;
end
$$;
set local role app_owner;
grant create on schema app to app_executor;
reset role;
set local role app_executor;

create or replace function app.get_document_download_v1(p_document_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
    v_actor uuid := app.context_uuid_v1('app.actor_id');
    v_member uuid;
    v_row record;
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    if v_actor is null or v_org is null then
        raise exception 'staff actor and organization context are required'
            using errcode = '42501';
    end if;
    if p_document_id is null then
        raise exception 'get_document_download_v1 requires a document id' using errcode = '22023';
    end if;
    if not app.has_permission_v1('documents.download') then
        raise exception 'documents.download permission is required' using errcode = '42501';
    end if;
    select m.id into v_member
    from app.organization_memberships m
    where m.organization_id = v_org and m.user_id = v_actor and m.status = 'active';
    if v_member is null then
        raise exception 'Active membership required' using errcode = '42501';
    end if;
    select d.id as document_id, d.candidate_id, d.original_filename,
        b.scan_state, b.lifecycle as blob_lifecycle, b.mime_type,
        l.bucket, l.object_key,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(d.id, d.version,
            b.id, b.version, b.scan_generation, b.lifecycle_generation,
            pg_catalog.encode(b.sha256, 'hex'), l.id, l.version,
            pg_catalog.encode(l.verified_sha256, 'hex'), l.verified_size_bytes,
            l.bucket, l.object_key, d.original_filename, b.mime_type)::text, 'UTF8')), 'hex') as preview_version
    into v_row
    from app.documents d
    join app.candidates c on c.organization_id = d.organization_id
        and c.id = d.candidate_id and c.lifecycle = 'active'
    join app.file_blobs b
        on b.organization_id = d.organization_id
        and b.candidate_id = d.candidate_id and b.id = d.blob_id
    join app.blob_locations l
        on l.organization_id = d.organization_id and l.blob_id = b.id
    where d.organization_id = v_org and d.id = p_document_id
        and d.lifecycle = 'active'
        and l.is_primary and l.state = 'available';
    if not found then
        raise exception 'Document not found' using errcode = 'P0002';
    end if;
    if v_row.blob_lifecycle <> 'live' or v_row.scan_state = 'infected' then
        raise exception 'Document is not downloadable' using errcode = '42501';
    end if;
    insert into app.audit_events (
        id, organization_id, actor_kind, actor_user_id, actor_membership_id,
        action, target_type, target_id, correlation_id, occurred_at, details
    ) values (
        pg_catalog.gen_random_uuid(), v_org, 'staff', v_actor, v_member,
        'document.downloaded', 'document', v_row.document_id,
        pg_catalog.gen_random_uuid(), v_now,
        pg_catalog.jsonb_build_object('candidate_id', v_row.candidate_id)
    );
    return pg_catalog.jsonb_build_object(
        'bucket', v_row.bucket,
        'objectKey', v_row.object_key,
        'filename', v_row.original_filename,
        'mimeType', v_row.mime_type,
        'previewVersion', v_row.preview_version
    );
end
$$;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
