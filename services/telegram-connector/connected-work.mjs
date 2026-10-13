// One provider operation per tick; control heartbeats renew between requests.
export function createConnectedWork({ history, cv, updates }) {
  const workers = updates ? [cv, history, updates] : [cv, history];
  let turn = 0;
  return async context => {
    // Empty lanes share the unused tick, but an actual provider read or any
    // uncertain result ends it. Round-robin ownership advances before each call,
    // so busy history cannot starve CV/source, even after failures and wakes.
    let result;
    for (let visited = 0; visited < workers.length; visited++) {
      const index = turn++ % workers.length;
      result = await workers[index].tick(context);
      if (context.plan && result?.status === 'idle' && result.idleReason === 'empty') context.plan[['cv', 'history', 'source'][index]] = false;
      if (result?.status !== 'idle' || result.providerRead !== false) return result;
    }
    return result;
  };
}
