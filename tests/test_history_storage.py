"""Lossless replay storage, immutable shared inputs and transactional recovery."""
import json

import psycopg
import pytest

from api import postgres
from api.research import packed
from api.research_history import BACKFILL_DETAIL, linked_histories, save_backfill


def sample(version):
    return {'id': 'P', 'kind': 'recipe', 'purchase_version': version,
            'latest_cost': '0.12345678901234567890123456789', 'inventory_cost': None,
            'formula': {'id': 'P', 'yield': '99.123456789', 'lines': [{'ref': 'Q'}]},
            'graph': [{'id': 'P'}, {'id': 'Q', 'owner': 'restricted'}],
            'source_hashes': {'erp': 'frozen-source'}, 'replay_context': {'basis': 'frozen'},
            'latest': {'cost': '0.12345678901234567890123456789'},
            'inventory': {'cost': None}, 'calculations': {'latest': {'P': {'cost': '0.12345678901234567890123456789'}}},
            'lines': [{'ref': 'Q'}]}


def test_migration_losslessly_shares_inputs_and_preserves_period_signatures(pg_targets):
    _, migration = pg_targets
    files = postgres._migration_files()
    with postgres.transaction(migration, write=True) as db:
        db.execute('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
        for _, _, _, content in files[1:6]:
            db.execute(content)
        for version in (1, 2):
            db.execute('INSERT INTO research_backfill_records VALUES (%s,%s,%s,%s)',
                       (version, 'P', f'sig-{version}', packed(sample(version))))
        before = db.execute('SELECT purchase_version,product_id,signature,payload,_order FROM research_backfill_records ORDER BY _order').fetchall()
        db.execute(files[6][3])
        after = db.execute(f'SELECT purchase_version,product_id,signature,{BACKFILL_DETAIL},_order FROM research_backfill_records ORDER BY _order').fetchall()
        assert [(v,k,s,json.loads(p),o) for v,k,s,p,o in before] == [(v,k,s,json.loads(p),o) for v,k,s,p,o in after]
        assert db.execute('SELECT count(*) FROM research_backfill_frozen').fetchone()[0] == 1
        summaries = [json.loads(row[0]) for row in db.execute('SELECT summary_payload FROM research_backfill_records')]
        assert all(not set(row) & {'formula','graph','source_hashes','calculations','latest','inventory','lines'} for row in summaries)
        assert all(row['latest_cost'] == sample(1)['latest_cost'] and row['inventory_cost'] is None for row in summaries)


def test_new_records_share_only_identical_inputs_and_rollback_atomically(pg_targets):
    app, _ = pg_targets
    with postgres.transaction(app, write=True) as db:
        for version in (1, 2):
            save_backfill(db,version,'P',f'sig-{version}',sample(version))
        changed=sample(3); changed['formula']['yield']='98.5'
        save_backfill(db,3,'P','sig-3',changed)
        assert db.execute('SELECT count(*) FROM research_backfill_frozen').fetchone()[0] == 2
        assert json.loads(db.execute(f'SELECT {BACKFILL_DETAIL} FROM research_backfill_records WHERE purchase_version=3').fetchone()[0]) == changed
    with pytest.raises(RuntimeError, match='rollback'):
        with postgres.transaction(app, write=True) as db:
            changed['formula']['yield']='97'
            save_backfill(db,4,'P','sig-4',changed)
            raise RuntimeError('rollback')
    with postgres.transaction(app) as db:
        assert db.execute('SELECT count(*) FROM research_backfill_records').fetchone()[0] == 3
        assert db.execute('SELECT count(*) FROM research_backfill_frozen').fetchone()[0] == 2
    with pytest.raises(psycopg.errors.CheckViolation):
        with postgres.transaction(app, write=True) as db:
            db.execute("UPDATE research_backfill_frozen SET payload='{}'")
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        with postgres.transaction(app, write=True) as db:
            db.execute('DELETE FROM research_backfill_frozen')
    with pytest.raises(psycopg.errors.GeneratedAlways):
        with postgres.transaction(app, write=True) as db:
            db.execute("UPDATE research_backfill_records SET summary_payload='{}'")


def test_shared_details_load_once_and_do_not_share_mutable_objects(pg_targets, monkeypatch):
    app, _ = pg_targets
    with postgres.transaction(app, write=True) as db:
        for version in range(1, 27):
            save_backfill(db,version,'P',f'sig-{version}',sample(version))
    execute=psycopg.Connection.execute
    reads=[]
    def counted(self, query, *args, **kwargs):
        if isinstance(query,str) and query.startswith('SELECT id,payload FROM research_backfill_frozen'):
            reads.append(args)
        return execute(self,query,*args,**kwargs)
    monkeypatch.setattr(psycopg.Connection,'execute',counted)
    with postgres.transaction(app) as db:
        rows=linked_histories(db,['P'],periods={})['P']
    assert len(reads)==1 and len(reads[0][0][0])==1
    assert len(rows)==26
    rows[0]['graph'][1]['owner']='changed'
    assert rows[1]['graph'][1]['owner']=='restricted'
    with postgres.transaction(app) as db:
        assert linked_histories(db,['P'],periods={})['P'][0]['graph'][1]['owner']=='restricted'
