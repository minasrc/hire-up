// One source provider read per connected tick. A native idle/ACK-only tick may
// use its unused provider budget for retained-message repair.
export function createSourceWork({native,reconcile}){
 let nativeTurn=true;
 return{async tick(context){
  if(!nativeTurn){nativeTurn=true;return reconcile.tick(context);}
  nativeTurn=false;
  const result=await native.tick(context);
  if(!result.providerRead&&['idle','native_checked','repair_required','stale'].includes(result.status))return reconcile.tick(context);
  return result;
 }};
}
