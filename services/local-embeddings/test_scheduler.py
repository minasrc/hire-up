import threading
import unittest
from fastapi import HTTPException
from scheduler import PriorityScheduler

class SchedulerTests(unittest.TestCase):
    def test_cancelled_queued_inputs_never_run_and_admission_recovers(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        class Encoder:
            def encode(self, inputs, kind):
                calls.append(inputs)
                entered.set()
                release.wait(3)
                return inputs, 1
        scheduler = PriorityScheduler(Encoder(), max_requests=2)
        first = scheduler.submit(["first"])
        self.assertTrue(entered.wait(1))
        pending = scheduler.submit(["must not run"], "query")
        with self.assertRaises(HTTPException) as error: scheduler.submit(["overflow"])
        self.assertEqual(error.exception.status_code, 429)
        pending.cancel()
        release.set()
        self.assertEqual(first.result(2), (["first"], 1))
        scheduler.close()
        scheduler.thread.join(2)
        self.assertEqual(calls, [["first"]])
        self.assertEqual(scheduler.requests, 0)

    def test_active_cancel_holds_slot_until_inference_really_finishes(self):
        entered, release = threading.Event(), threading.Event()
        class Encoder:
            def encode(self, inputs, kind):
                entered.set()
                release.wait(3)
                return inputs, 1
        scheduler = PriorityScheduler(Encoder(), max_requests=1)
        pending = scheduler.submit(["active"])
        self.assertTrue(entered.wait(1))
        pending.cancel()
        with self.assertRaises(HTTPException): scheduler.submit(["replacement"])
        release.set()
        scheduler.close()
        scheduler.thread.join(2)
        self.assertEqual(scheduler.requests, 0)

if __name__ == "__main__": unittest.main()
