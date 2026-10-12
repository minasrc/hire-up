// One provider operation per tick; control heartbeats renew between requests.
export function createConnectedWork({ history, cv, updates }) {
  const workers = updates ? [cv, history, updates] : [cv, history];
  let turn = 0;
  return async context => {
    const index = turn++ % workers.length;
    const result = await workers[index].tick(context);
    if (context.plan && result?.status === 'idle') context.plan[['cv', 'history', 'source'][index]] = false;
    return result;
  };
}
