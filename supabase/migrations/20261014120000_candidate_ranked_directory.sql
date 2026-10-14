begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
set local role app_owner;
grant create on schema app to app_executor;
reset role;
set local role app_executor;
create function app.candidate_ranked_directory_rows_v1(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,app,pg_temp as $$
declare org uuid:=app.context_uuid_v1('app.organization_id');
begin
 perform app.recruitment_actor_v1(array['candidates.read'],null,null,false);
 if cardinality(p_ids)>25 then raise exception 'Too many candidate rows' using errcode='22023'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object(
  'candidateId',c.id,'fullName',c.full_name,'email',app.candidate_contact_v1(c,'email'),
  'headline',c.headline,'location',c.location,'ownerName',u.display_name,
  'applicationCount',(select count(*) from app.applications a where a.organization_id=org and a.candidate_id=c.id),
  'hasCv',c.current_document_id is not null,'createdAt',c.created_at) order by ids.ordinal),'[]'::jsonb)
  from unnest(p_ids) with ordinality ids(id,ordinal)
  join app.candidates c on c.id=ids.id and c.organization_id=org and c.lifecycle='active'
  left join app.organization_memberships m on m.id=c.owner_membership_id and m.organization_id=org
  left join app.users u on u.id=m.user_id);
end $$;
revoke all on function app.candidate_ranked_directory_rows_v1(uuid[]) from public;
grant execute on function app.candidate_ranked_directory_rows_v1(uuid[]) to app_staff;
reset role;
set local role app_owner;
revoke create on schema app from app_executor;
commit;
