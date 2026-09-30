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

alter function app.submit_public_application_v1(
    uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
    text, text, text, text, text, text, bytea, bigint, text, text, text, text, text
) rename to submit_public_application_core_v1;
revoke all on function app.submit_public_application_core_v1(
    uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
    text, text, text, text, text, text, bytea, bigint, text, text, text, text, text
) from public, app_intake;

create function app.submit_public_application_v1(
    p_candidate_id uuid, p_source_id uuid, p_email_identifier_id uuid,
    p_url_identifier_id uuid, p_application_id uuid, p_history_id uuid,
    p_audit_id uuid, p_correlation_id uuid, p_blob_id uuid, p_location_id uuid,
    p_document_id uuid, p_job_slug text, p_public_reference text, p_full_name text,
    p_email text, p_professional_url text, p_achievement text, p_blob_sha256 bytea,
    p_blob_size_bytes bigint, p_mime_type text, p_extension text, p_bucket text,
    p_object_key text, p_filename text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, app, pg_temp
as $$
declare
    v_org uuid := app.context_uuid_v1('app.organization_id');
begin
    if v_org is null or app.context_uuid_v1('app.actor_id') is not null then
        raise exception 'Public intake context is required' using errcode = '42501';
    end if;
    perform o.id from app.organizations o where o.id = v_org for update;
    if not found then raise exception 'Organization not found' using errcode = 'P0002'; end if;
    if exists (select 1 from app.candidate_identifiers i join app.candidates c
        on c.organization_id = i.organization_id and c.id = i.candidate_id
        where i.organization_id = v_org and i.kind = 'email'
            and i.normalized_value = lower(btrim(p_email)) and c.lifecycle <> 'active') then
        raise exception 'Application cannot be accepted' using errcode = '42501';
    end if;
    return app.submit_public_application_core_v1(p_candidate_id, p_source_id,
        p_email_identifier_id, p_url_identifier_id, p_application_id, p_history_id,
        p_audit_id, p_correlation_id, p_blob_id, p_location_id, p_document_id,
        p_job_slug, p_public_reference, p_full_name, p_email, p_professional_url,
        p_achievement, p_blob_sha256, p_blob_size_bytes, p_mime_type, p_extension,
        p_bucket, p_object_key, p_filename);
end
$$;

revoke all on function app.submit_public_application_v1(
    uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
    text, text, text, text, text, text, bytea, bigint, text, text, text, text, text
) from public;
grant execute on function app.submit_public_application_v1(
    uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid,
    text, text, text, text, text, text, bytea, bigint, text, text, text, text, text
) to app_intake;

reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
