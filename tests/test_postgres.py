"""Connection establishment recovery must never replay a transaction."""
import os
from types import SimpleNamespace

import psycopg
import pytest

from api import postgres


@pytest.mark.parametrize('platform,error,persistent,attempts', [
    pytest.param('nt', psycopg.OperationalError('No buffer space available (0x00002747/10055)'), False, 2, id='windows-recovers'),
    pytest.param('nt', psycopg.OperationalError('No buffer space available (0x00002747/10055)'), True, 2, id='windows-still-fails'),
    pytest.param('posix', psycopg.OperationalError('No buffer space available (0x00002747/10055)'), True, 1, id='other-platform'),
    pytest.param('nt', psycopg.OperationalError('connection refused (0x0000274D/10061)'), True, 1, id='other-network-error'),
    pytest.param('nt', psycopg.OperationalError('port 10055: connection refused'), True, 1, id='port-number-is-not-error'),
    pytest.param('nt', psycopg.errors.InvalidPassword('(0x00002747/10055)'), True, 1, id='database-rejection'),
])
def test_connect_recovers_only_windows_buffer_exhaustion(monkeypatch, platform, error, persistent, attempts):
    calls, delays = [], []
    result = object()

    def connect(*args, **kwargs):
        calls.append((args, kwargs))
        if len(calls)==1 or persistent:
            raise error
        return result

    monkeypatch.setattr(postgres, 'os', SimpleNamespace(name=platform, environ=os.environ))
    monkeypatch.setattr(postgres, 'time', SimpleNamespace(sleep=delays.append), raising=False)
    monkeypatch.setattr(postgres.psycopg, 'connect', connect)
    if attempts==2 and not persistent:
        assert postgres.connect(os.environ['HONGHAO_TEST_DATABASE_URL']) is result
    else:
        with pytest.raises(type(error)):
            postgres.connect(os.environ['HONGHAO_TEST_DATABASE_URL'])
    assert len(calls)==attempts
    assert len(delays)==attempts-1 and all(0 < delay <= .1 for delay in delays)
    assert all(call==calls[0] for call in calls)
    assert calls[0][1]['connect_timeout']==5
