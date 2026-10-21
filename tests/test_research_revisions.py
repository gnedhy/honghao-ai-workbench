import json
from uuid import uuid4
import pytest
from api.postgres import transaction
from api.research_reads import history_record
from api.research_history import linked_history
from scripts.revise_october_cost_period import revise
from tests.test_research_workbench import ready, data, trial_data, K


def test_revision_projection_retains_final_frozen_source_and_survives_future_records(ready):
    _,_,admin,store=ready
    with transaction(store.url,write=True) as db:
        original=json.loads(db.execute('SELECT payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1',(K,)).fetchone()[0])
        events=[]
        for index in range(4):
            eid=str(uuid4());events.append(eid)
            value={**original,'event_id':eid,'recorded_at':f'2026-10-{20+index}T00:00:00+00:00','latest_cost':str(10+index),'reason':'fixture'}
            db.execute("INSERT INTO research_events(id,recorded_at,reason,inputs,status,attempts) VALUES(%s,%s,%s,%s,'done',0)",(eid,value['recorded_at'],'采购正式价格更新',json.dumps({'purchase_period':{'version':27,'price_date':'2026-10-20'}})))
            if index<3:
                db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)',(eid,K,eid,json.dumps(value)))
            else:future=value
        before=db.execute('SELECT event_id,payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence',(K,)).fetchall()
        for eid in events[1:3]:db.execute('INSERT INTO research_event_revisions(event_id,root_event_id,actor,recorded_at) VALUES(%s,%s,%s,%s)',(eid,events[0],admin,'2026-10-23'))
        db.execute('SELECT research_refresh_history(%s)',(K,))
        def projected():return db.execute('SELECT event_id,payload FROM research_history_reads WHERE product_id=%s ORDER BY ordinal',(K,)).fetchall()
        first=projected();merged=dict(first)[events[0]]
        assert merged['source_event_id']==events[2] and merged['latest_cost']=='12'
        assert len(merged['revision_events'])==3
        assert not set(events[1:3])&set(dict(first))
        assert before==db.execute('SELECT event_id,payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence',(K,)).fetchall()
        db.execute('SELECT research_refresh_history(%s)',(K,));assert first==projected()
        db.execute('INSERT INTO research_cost_records(event_id,product_id,signature,payload) VALUES(%s,%s,%s,%s)',(events[3],K,events[3],json.dumps(future)))
        assert dict(projected())[events[0]]==merged
        detail=history_record(db,K,events[0],None)['products'][0]
        assert detail['latest_cost']=='12' and detail['source_event_id']==events[2]
        assert [r for r in linked_history(db,K) if r['event_id']==events[0]][0]['latest_cost']=='12'
    with pytest.raises(PermissionError):revise(store.url,'not-an-admin')
