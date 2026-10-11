// One provider operation per tick; control heartbeats renew between requests.
export function createConnectedWork({ history, cv, updates }) {
  const workers = updates ? [cv, history, updates] : [cv, history];
  let turn = 0;
  return context => workers[turn++ % workers.length].tick(context);
}
