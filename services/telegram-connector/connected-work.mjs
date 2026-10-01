// One provider operation per connected tick. Alternation prevents a large CV
// queue from starving history and keeps heartbeat/lease renewal between reads.
export function createConnectedWork({ history, cv }) {
  let cvTurn = true;
  return async context => {
    const worker = cvTurn ? cv : history;
    cvTurn = !cvTurn;
    return worker.tick(context);
  };
}
