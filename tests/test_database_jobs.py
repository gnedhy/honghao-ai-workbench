import asyncio
from threading import Event

import pytest

from api.main import _run_database_job


def test_cancelled_database_job_waits_for_its_thread_before_shutdown():
    async def scenario():
        entered = Event()
        release = Event()
        finished = Event()
        def work():
            entered.set()
            assert release.wait(10)
            finished.set()
        job = asyncio.create_task(_run_database_job(work))
        try:
            assert await asyncio.to_thread(entered.wait, 5)
            job.cancel()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert not job.done()
            assert not finished.is_set()
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await job
        assert finished.is_set()
    asyncio.run(scenario())


def test_database_job_failure_reaches_scheduler():
    def work():
        raise RuntimeError('database unavailable')
    with pytest.raises(RuntimeError, match='database unavailable'):
        asyncio.run(_run_database_job(work))
