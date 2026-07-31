"""Tests for the background-init readiness gate (await_agent_service).

On a cold Cloud Run container, /api/v2/query used to fall straight through
to the generic "please rephrase" fallback while the background service init
thread was still running.  await_agent_service closes that window by waiting
for init to finish before giving up on the agent service.
"""

import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

from src.platform_services.api_gateway import await_agent_service


def _fake_app(agent_service=None, ready=None, reinit=None):
    app = SimpleNamespace()
    app.agent_service = agent_service
    if ready is not None:
        app.services_ready = ready
    if reinit is not None:
        app.maybe_reinit_services = reinit
    return app


class TestAwaitAgentService:
    """Tests for await_agent_service."""

    def test_returns_service_immediately_when_ready(self):
        """A warm app returns its agent service with no waiting."""
        svc = object()
        app = _fake_app(agent_service=svc, ready=threading.Event())

        start = time.monotonic()
        assert await_agent_service(app, timeout_seconds=5) is svc
        assert time.monotonic() - start < 0.5

    def test_returns_none_for_apps_without_readiness_event(self):
        """Apps not built via app_v2.create_app degrade gracefully."""
        app = SimpleNamespace(agent_service=None)

        assert await_agent_service(app, timeout_seconds=5) is None

    def test_waits_for_background_init_to_finish(self):
        """A query arriving mid-init waits and then gets the real service."""
        ready = threading.Event()
        app = _fake_app(agent_service=None, ready=ready)
        svc = object()

        def finish_init():
            time.sleep(0.2)
            app.agent_service = svc
            ready.set()

        worker = threading.Thread(target=finish_init)
        worker.start()
        try:
            assert await_agent_service(app, timeout_seconds=5) is svc
        finally:
            worker.join()

    def test_gives_up_after_timeout(self):
        """A hung init does not block the request forever."""
        ready = threading.Event()  # never set
        app = _fake_app(agent_service=None, ready=ready)

        start = time.monotonic()
        assert await_agent_service(app, timeout_seconds=0.2) is None
        assert time.monotonic() - start < 2

    def test_schedules_retry_when_init_failed(self):
        """A finished-but-failed init triggers the rate-limited re-init hook."""
        ready = threading.Event()
        ready.set()  # init finished without producing a service
        reinit = MagicMock()
        app = _fake_app(agent_service=None, ready=ready, reinit=reinit)

        assert await_agent_service(app, timeout_seconds=0.2) is None
        reinit.assert_called_once()

    def test_waiter_slots_are_capped(self):
        """Only a bounded number of threads park on init; the rest degrade fast."""
        ready = threading.Event()  # init in flight for the whole test
        app = _fake_app(agent_service=None, ready=ready)

        results = []
        parked = [
            threading.Thread(target=lambda: results.append(await_agent_service(app, 3)))
            for _ in range(3)
        ]
        for t in parked:
            t.start()
        time.sleep(0.3)  # let the three waiters occupy every slot

        try:
            start = time.monotonic()
            assert await_agent_service(app, timeout_seconds=3) is None
            assert time.monotonic() - start < 0.5  # degraded fast, did not park
        finally:
            ready.set()
            for t in parked:
                t.join()

    def test_waits_on_retry_started_by_reinit(self):
        """When the re-init hook restarts init, the caller waits for it."""
        ready = threading.Event()
        ready.set()
        svc = object()
        app = _fake_app(agent_service=None, ready=ready)
        workers = []

        def reinit():
            ready.clear()

            def worker():
                time.sleep(0.2)
                app.agent_service = svc
                ready.set()

            t = threading.Thread(target=worker)
            workers.append(t)
            t.start()

        app.maybe_reinit_services = reinit
        try:
            assert await_agent_service(app, timeout_seconds=5) is svc
        finally:
            for t in workers:
                t.join()
