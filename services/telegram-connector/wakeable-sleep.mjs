// Wake notifications interrupt scheduler sleep without bypassing work/lease checks.
export function createWakeableSleep(signal, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let pending = false, finish;
  return {
    wake() { pending = true; finish?.(); },
    sleep(ms) {
      if (finish) throw new Error('CONCURRENT_SLEEP');
      if (signal.aborted || pending) { pending = false; return Promise.resolve(); }
      return new Promise(resolve => {
        let timer;
        const done = () => {
          cancel(timer); signal.removeEventListener('abort', done);
          pending = false; finish = undefined; resolve();
        };
        finish = done; signal.addEventListener('abort', done, { once: true });
        timer = schedule(done, ms);
        if (signal.aborted) done();
      });
    },
  };
}
