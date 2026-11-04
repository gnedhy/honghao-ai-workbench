import copy
import hashlib
import json
from uuid import uuid4

import pytest

from api.postgres import transaction
from api.research import packed
from api.research_reads import history_record
from scripts.reconcile_market_prices import apply
from tests.test_research_workbench import ready, data, trial_data, K


def candidate(db):
    seq,key,sig,raw=db.execute('SELECT sequence,product_id,signature,payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1',(K,)).fetchone()
    plan={'id':str(uuid4()),'source_sha256':'a'*64,'source':'核对.xlsx','prices':[]}
    value=json.loads(raw);value['latest_cost']='123.45'
    value['reconciliation']={'id':plan['id']}
    return plan,[['formal',seq,key,sig,hashlib.sha256(raw.encode()).hexdigest(),'b'*64,packed(value)]],raw


def test_correction_keeps_original_and_future_costs(ready):
    _,_,actor,store=ready
    with transaction(store.url,write=True) as db:
        plan,costs,raw=candidate(db)
        assert apply(db,plan,costs,actor)['formal_costs']==1
        assert apply(db,plan,costs,actor)=={'status':'unchanged'}
        seq=costs[0][1];eid=json.loads(raw)['event_id']
        assert db.execute('SELECT payload FROM research_cost_records WHERE sequence=%s',(seq,)).fetchone()==(raw,)
        assert history_record(db,K,eid,None)['products'][0]['latest_cost']=='123.45'
        assert db.execute('SELECT current_payload::jsonb->>\'latest_cost\' FROM research_effective_costs WHERE sequence=%s',(seq,)).fetchone()==('123.45',)
        new=json.loads(raw);new.update(event_id=str(uuid4()),latest_cost='456.78')
        db.execute("INSERT INTO research_events(id,recorded_at,reason,inputs,status,attempts) VALUES(%s,%s,'later','{}','done',0)",(new['event_id'],new['recorded_at']))
        db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)',(new['event_id'],K,'later',packed(new)))
        assert db.execute('SELECT current_payload::jsonb->>\'latest_cost\' FROM research_effective_costs WHERE product_id=%s ORDER BY sequence DESC LIMIT 1',(K,)).fetchone()==('456.78',)


def test_changed_baseline_rolls_back_without_partial_correction(ready):
    _,_,actor,store=ready
    with transaction(store.url,write=True) as db:
        plan,costs,raw=candidate(db)
        costs[0][4]='changed'
        with pytest.raises(ValueError,match='已变化'):
            apply(db,plan,costs,actor)
        assert db.execute('SELECT count(*) FROM procurement_reconciliations').fetchone()==(0,)


def test_late_old_event_supplement_keeps_current_cost(ready):
    from api.research_history import linked_histories
    from api.sales import SalesStore
    _,_,actor,store=ready
    with transaction(store.url,write=True) as db:
        plan,costs,raw=candidate(db)
        old=json.loads(raw)
        old['event_id']=str(uuid4())
        db.execute("INSERT INTO research_events(id,recorded_at,reason,inputs,status,attempts) VALUES(%s,%s,'old','{}','done',0)",(old['event_id'],old['recorded_at']))
        later=copy.deepcopy(old);later.update(event_id=str(uuid4()),latest_cost='456.78')
        db.execute("INSERT INTO research_events(id,recorded_at,reason,inputs,status,attempts) VALUES(%s,%s,'later','{}','done',0)",(later['event_id'],later['recorded_at']))
        db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)',(later['event_id'],K,'later',packed(later)))
        db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)',(old['event_id'],K,'late-old',packed(old)))
        assert store.detail(K,actor=actor)['product']['latest_cost']=='456.78'
        histories=linked_histories(db,[K],series=True)[K]
        assert histories[0]['event_id']==later['event_id']
        assert 'lines' in histories[0]['latest']
        products,_=SalesStore(store.url)._catalog(db)
        assert products['research:'+K]['latest_cost']=='456.78'


def test_price_overlay_updates_history_and_keeps_inventory(ready):
    _,_,actor,store=ready
    with transaction(store.url,write=True) as db:
        b,mid,code,before,stock=db.execute('SELECT batch_id,material_id,code,latest_price,inventory_price FROM procurement_price_batch_items WHERE latest_price IS NOT NULL LIMIT 1').fetchone()
        plan={'id':str(uuid4()),'source_sha256':'a'*64,'source':'核对.xlsx','prices':[dict(batch_id=b,material_id=mid,code=code,version=1,before=before,after='11.1',price_date='2026-09-01',sheet='行情',cell='E2',original_value='11.1')]}
        apply(db,plan,[],actor)
        assert db.execute('SELECT latest_price,inventory_price FROM procurement_price_batch_items WHERE batch_id=%s AND material_id=%s',(b,mid)).fetchone()==(before,stock)
        assert db.execute('SELECT latest_price,inventory_price FROM procurement_effective_prices WHERE batch_id=%s AND material_id=%s',(b,mid)).fetchone()==('11.1',stock)
        assert db.execute('SELECT latest_price,price_kind FROM procurement_price_read_points WHERE batch_id=%s AND material_id=%s',(b,mid)).fetchone()==('11.1','number')


def test_snapshot_restores_corrections_and_projections(ready,tmp_path,second_pg):
    from api.operations import _table_evidence,create_snapshot,restore_snapshot
    from api.settings import Settings
    settings,_,actor,store=ready
    with transaction(store.url,write=True) as db:
        plan,costs,raw=candidate(db)
        b,mid,code,before=db.execute('SELECT batch_id,material_id,code,latest_price FROM procurement_price_batch_items LIMIT 1').fetchone()
        plan['prices']=[dict(batch_id=b,material_id=mid,code=code,version=1,before=before,after='11.1',price_date='2026-09-01',sheet='行情',cell='E2',original_value='11.1')]
        apply(db,plan,costs,actor)
    with transaction(store.url) as db:original=_table_evidence(db)
    snapshot=create_snapshot(settings,tmp_path/'snapshots')
    target=Settings.from_data_dir(tmp_path/'restored',database_url=second_pg['migration_url'])
    restore_snapshot(target,snapshot)
    with transaction(second_pg['url']) as db:
        sources=json.loads((snapshot/'manifest.json').read_text(encoding='utf-8'))['source_paths']
        relocated={str(target.data_dir/s['path']):s['stored_path'] for s in sources}
        assert _table_evidence(db,relocated)==original
        assert db.execute('SELECT latest_price FROM procurement_effective_prices WHERE batch_id=%s AND material_id=%s',(b,mid)).fetchone()==('11.1',)
        assert db.execute('SELECT current_payload::jsonb->>\'latest_cost\' FROM research_effective_costs WHERE sequence=%s',(costs[0][1],)).fetchone()==('123.45',)
