"""One model thread, bounded admission, urgent queries between passage batches."""
from collections import deque
from concurrent.futures import Future, InvalidStateError
from threading import Condition, Thread

from fastapi import HTTPException


class PriorityScheduler:
    def __init__(self, encoder, max_requests=16, max_inputs=128):
        self.encoder = encoder
        self.condition = Condition()
        self.queries, self.passages = deque(), deque()
        self.max_requests, self.max_inputs = max_requests, max_inputs
        self.requests = self.inputs = 0
        self.closed = False
        self.thread = Thread(target=self._run, name="local-embedding-model", daemon=True)
        self.thread.start()

    def submit(self, inputs=None, input_type="passage", plan_text=None, chunker_version=None):
        count = len(inputs) if inputs is not None else 1
        with self.condition:
            if self.closed:
                raise HTTPException(503, "Embedding unavailable.")
            if self.requests >= self.max_requests or self.inputs + count > self.max_inputs:
                raise HTTPException(429, "Embedding queue full; retry later.", headers={"Retry-After": "1"})
            future = Future()
            item = {"future": future, "inputs": inputs, "kind": input_type, "plan": plan_text,
                    "chunker_version": chunker_version, "offset": 0, "vectors": [], "tokens": 0, "count": count}
            self.requests += 1
            self.inputs += count
            (self.queries if input_type == "query" else self.passages).append(item)
            self.condition.notify()
            return future

    def close(self):
        with self.condition:
            self.closed = True
            for item in [*self.queries, *self.passages]:
                item["future"].cancel()
            self.condition.notify_all()

    def _run(self):
        urgent_burst = 0
        while True:
            with self.condition:
                while not self.queries and not self.passages:
                    if self.closed:
                        return
                    self.condition.wait()
                # Bound query bursts so indexing also progresses under sustained load.
                urgent = bool(self.queries) and (urgent_burst < 8 or not self.passages)
                item = (self.queries if urgent else self.passages).popleft()
                urgent_burst = urgent_burst + 1 if urgent else 0
            future = item["future"]
            try:
                if not future.cancelled():
                    if item["plan"] is not None:
                        result = self.encoder.plan(item["plan"], item["chunker_version"]) if item["chunker_version"] is not None else self.encoder.plan(item["plan"])
                        done = True
                    else:
                        batch = item["inputs"][item["offset"]:item["offset"] + 8]
                        vectors, count = self.encoder.encode(batch, item["kind"])
                        item["vectors"].extend(vectors)
                        item["tokens"] += count
                        item["offset"] += len(batch)
                        done = item["offset"] == len(item["inputs"])
                        result = (item["vectors"], item["tokens"])
                    with self.condition:
                        if not done and not future.cancelled():
                            (self.queries if item["kind"] == "query" else self.passages).append(item)
                            continue
                        if not future.cancelled():
                            try:
                                future.set_result(result)
                            except InvalidStateError:
                                pass
            except Exception as error:
                if not future.cancelled():
                    try:
                        future.set_exception(error)
                    except InvalidStateError:
                        pass
            with self.condition:
                self.requests -= 1
                self.inputs -= item["count"]
