"""Bounded research reads retain frozen costs, comparison chains and live permissions."""
import json

import pytest

from api.postgres import transaction
from api.research import capture, packed
from api.research_history import linked_histories, save_backfill
from api.research_reads import history_page, history_record, ledger_page, versions_page
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, K
from tests.test_research_departments import departments, FOREIGN


def query(kind='products',**values):
    return dict(kind=kind,page=1,page_size=1,search='',owner='',department='',status='',draft='',movement='',yield_warning=False,sort='name',asc=True,**values)


def test_product_reads_equal_frozen_history_and_current_page(ready):
    _,client,_,store=ready
    with transaction(store.url) as db:
        old=linked_histories(db,[K],summary=True)[K]
        page=history_page(db,K,None,page_size=1)
        assert page['total']==len(old) and len(page['items'])==1
        by_event={row['event_id']:row for row in old}
        for row in history_page(db,K,None,page_size=200)['items']:
            previous=by_event[row['event_id']]
            for field in ('latest_cost','inventory_cost','change','comparison_basis','effective_date'):
                assert row[field]==previous[field]
            frozen=history_record(db,K,row['event_id'],None)['products'][0]
            assert frozen['latest_cost']==previous['latest_cost'] and frozen['formula']['id']==K
        page=ledger_page(db,None,query())
        assert len(page['items'])==1 and page['total']==len(store.listing()['products'])
        actual={row['id']:row for row in store.listing()['products']}[page['items'][0]['id']]
        for field in ('latest_cost','inventory_cost','change'):
            assert page['items'][0][field]==actual[field]
    compact=client.get('/api/workbenches/research/products/'+K,params={'history':'false'})
    assert compact.status_code==200,compact.text
    value=compact.json()
    assert value['history']==[] and value['history_total']==len(old) and value['options_loaded'] is False
    original=store.detail(K)
    assert value['latest']==original['latest'] and value['inventory']==original['inventory']
    assert client.get('/api/workbenches/research/products/'+K+'/edit-options').status_code==200


def test_history_growth_old_period_update_delete_and_rollback(ready):
    _,_,_,store=ready
    assert store.detail(K,include_history=False)['line_history'][0]['product_id']==K
    original=store.detail(K)['history'][0]
    with transaction(store.url,write=True) as db:
        # A single statement may affect many periods of the same product.
        rows=[]
        for version in range(1,131):
            row=dict(original,event_id=f'backfill:{version}',record_type='backfill',purchase_version=version,effective_date='2020-01-01',latest_cost=str(version),product_id=K)
            rows.append((version,K,'frozen-'+str(version),packed(row)))
        db.cursor().executemany('INSERT INTO research_backfill_records(purchase_version,product_id,signature,payload) VALUES(%s,%s,%s,%s)',rows)
    with transaction(store.url) as db:
        page=history_page(db,K,None,start='2020-01-01',end='2020-01-01',page_size=10)
        assert page['total']==130 and len(page['items'])==10
        revision=page['version']
        assert all(not set(row)&{'formula','graph','calculations','lines'} for row in page['items'])
        original_payload=db.execute('SELECT payload FROM research_backfill_records WHERE product_id=%s AND purchase_version=1',(K,)).fetchone()[0]
    with pytest.raises(RuntimeError,match='rollback'):
        with transaction(store.url,write=True) as db:
            db.execute('DELETE FROM research_backfill_records WHERE product_id=%s',(K,))
            raise RuntimeError('rollback')
    with transaction(store.url) as db:
        assert history_page(db,K,None)['version']==revision
    with transaction(store.url,write=True) as db:
        row=json.loads(original_payload);row['effective_date']='2019-12-01'
        db.execute('UPDATE research_backfill_records SET payload=%s WHERE product_id=%s AND purchase_version=1',(packed(row),K))
    with transaction(store.url) as db:
        assert history_page(db,K,None,start='2019-12-01',end='2019-12-01')['total']==1
        assert history_page(db,K,None)['version']!=revision
        old=linked_histories(db,[K],summary=True)[K]
        by_event={row['event_id']:row for row in old}
        for row in history_page(db,K,None,page_size=200)['items']:
            assert row['change']==by_event[row['event_id']]['change']
    with transaction(store.url,write=True) as db:
        db.execute('DELETE FROM research_backfill_records WHERE product_id=%s AND purchase_version<=2',(K,))
    with transaction(store.url) as db:
        assert history_page(db,K,None,start='2020-01-01',end='2020-01-01')['total']==128


def test_bounded_history_and_detail_respect_department_and_revocation(departments):
    _,client,_,store,user,other=departments
    prefix='/api/workbenches/research'
    for suffix in ('/history-page','/trend','/history-record/missing'):
        assert client.get(prefix+'/products/'+FOREIGN+suffix).status_code==404
    for route in ('/products/'+K+'?history=false','/products/'+K+'/history-page','/products/'+K+'/trend','/history-page'):
        response=client.get(prefix+route)
        assert response.status_code==200,response.text
        assert 'SECRET-' not in response.text and '777.123' not in response.text
    with transaction(store.url,write=True) as db:
        db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='research'",(user['id'],))
    assert client.get(prefix+'/products/'+K+'/history-page').status_code==403
    assert client.get(prefix+'/products/'+K+'?history=false').status_code==403

def test_sql_visibility_matches_department_precedence_and_legacy_fallback(departments):
    from api.research_access import ResearchAccess
    from api.research_reads import scope_sql
    _,_,_,store,user,other=departments
    variants=[
        {'department_id':user['primary_department_id'],'department':'研发二部'},
        {'department_id':other['primary_department_id'],'department':'研发一部'},
        {'department_id':'','department':'研发一部'},
        {'department':'研发一部'},
        {'department':'','source_kind':''},
        {'source_kind':'erp_bom'},
        {},
    ]
    with transaction(store.url,write=True) as db:
        for index,value in enumerate(variants):
            value.update(id=f'scope-{index}',kind='recipe',name=f'scope-{index}',lines=[])
            db.execute('INSERT INTO research_formulas(id,position,formula,revision) VALUES(%s,%s,%s,1)',(value['id'],10000+index,packed(value)))
        access=ResearchAccess(db,user)
        expected={json.loads(raw)['id'] for raw, in db.execute('SELECT formula FROM research_formulas') if access.allows(json.loads(raw))}
        assert access.visible_ids(db)==expected
        predicate,params=scope_sql(access,'formula::jsonb')
        assert {row[0] for row in db.execute('SELECT id FROM research_formulas WHERE '+predicate,params)}==expected

def test_paging_revision_and_trend_gap_evidence(ready):
    _,client,_,store=ready
    prefix='/api/workbenches/research'
    first=client.get(prefix+'/products/'+K+'/history-page').json()
    versions=client.get(prefix+'/history-page').json()
    original=store.detail(K)['history'][0]
    with transaction(store.url,write=True) as db:
        row=dict(original,event_id='backfill:999',record_type='backfill',purchase_version=999,effective_date='2020-01-01',latest_cost=None,missing_materials=['A'],reason='缺价断点验证')
        save_backfill(db,999,K,'gap-signature',row)
    assert client.get(prefix+'/products/'+K+'/history-page',params={'page':2,'version':first['version']}).status_code==409
    assert client.get(prefix+'/history-page',params={'page':2,'version':versions['version']}).status_code==409
    response=client.get(prefix+'/products/'+K+'/trend',params={'start':'2020-01-01','end':'2020-01-01'})
    assert response.status_code==200,response.text
    point=response.json()['versions'][0]['products'][0]
    assert point['latest_cost'] is None and point['missing_materials']==['A'] and point['reason']=='缺价断点验证'
    assert point['purchase_version']==999


def test_dashboard_aggregates_defaults_and_interval_boundaries(ready):
    from api.research_dashboard import overview,options,movers,gaps
    _,_,_,store=ready
    products=store.listing()['products']
    original=store.detail(K)['history'][0]
    with transaction(store.url,write=True) as db:
        for version,day,cost in [(701,'2020-01-01','1.0000000000000000001'),(702,'2020-01-31','2.0000000000000000002')]:
            row=dict(original,event_id=f'backfill:{version}',record_type='backfill',purchase_version=version,effective_date=day,latest_cost=cost)
            save_backfill(db,version,K,'test-'+str(version),row)
    with transaction(store.url) as db:
        metrics=overview(db,None)['dashboard']['metrics']
        assert metrics['products']==len(products)
        assert overview(db,None)['versions']==[]
        candidates=options(db,None,'','2000-01-01','2099-12-31',K,1)
        assert candidates['selected']['id']==K and candidates['default']['id']==K
        ranked=movers(db,None,'2020-01-01','2020-01-31','up')
        assert ranked['total']==1 and ranked['items'][0]['id']==K
        assert ranked['items'][0]['change']['percent']==100
        assert ranked['items'][0]['before']=='1.0000000000000000001'
        assert ranked['items'][0]['latest_cost']=='2.0000000000000000002'
        version=versions_page(db,None,event_id='backfill:702')
        assert version['products'][0]['period_change']['percent']==100
        assert version['products'][0]['period_change']['direction']=='up'
        actual=gaps(db,None,'all')['items']
        by_id={row['id']:row for row in products}
        for row in actual:
            assert row['latest_cost']==by_id[row['id']]['latest_cost']
            assert row['inventory_cost']==by_id[row['id']]['inventory_cost']


def test_dashboard_scopes_choices_and_missing_history_are_private(departments):
    from api.research_dashboard import overview,options,movers,gaps
    _,_,_,store,user,_=departments
    with transaction(store.url) as db:
        assert overview(db,user)['dashboard']['metrics']['products']==1
        selected=options(db,user,'','2000-01-01','2099-12-31',FOREIGN,1)
        assert selected['selected'] is None
        assert [row['id'] for row in selected['items']]==[K]
        for value in (selected,movers(db,user,'2000-01-01','2099-12-31','up'),gaps(db,user,'all')):
            assert 'SECRET-' not in json.dumps(value) and '777.123' not in json.dumps(value)


def test_event_input_repair_updates_projection_without_rewriting_cost(ready):
    _,_,_,store=ready
    with transaction(store.url,write=True) as db:
        event=db.execute('SELECT event_id,payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1',(K,)).fetchone()
        before=db.execute('SELECT revision FROM research_history_versions WHERE product_id=%s',(K,)).fetchone()[0]
        inputs=json.loads(db.execute('SELECT inputs FROM research_events WHERE id=%s',(event[0],)).fetchone()[0])
        inputs['purchase_period']={'id':'repair-test','version':900,'price_date':'2020-02-03'}
        db.execute("UPDATE research_events SET reason='采购正式价格更新',inputs=%s WHERE id=%s",(json.dumps(inputs),event[0]))
        result=db.execute('SELECT effective_date,payload FROM research_history_reads WHERE product_id=%s AND event_id=%s',(K,event[0])).fetchone()
        assert result[0]=='2020-02-03'
        assert db.execute('SELECT payload FROM research_cost_records WHERE product_id=%s AND event_id=%s',(K,event[0])).fetchone()[0]==event[1]
        assert db.execute('SELECT revision FROM research_history_versions WHERE product_id=%s',(K,)).fetchone()[0]>before
        revision=history_page(db,K,None)['version']
        db.execute('UPDATE research_events SET inputs=inputs WHERE id=%s',(event[0],))
        assert history_page(db,K,None)['version']==revision
        page=versions_page(db,None)
        listed=next(row for row in page['items'] if row['id']==event[0])
        assert versions_page(db,None,event_id=event[0])['cost_version']==listed['cost_version']


def test_summary_masks_hidden_reference_missing_codes(departments):
    from api.research_access import ResearchAccess
    from api.research_reads import project_summaries
    _,_,_,store,user,_=departments
    value={'missing_materials':['SECRET-MATERIAL'],'latest':{'lines':[{'kind':'recipe','ref':FOREIGN,'code':'公开引用产品','missing_materials':['SECRET-MATERIAL'],'price_review_pending':[]}],'missing_materials':['SECRET-MATERIAL']},'inventory':{'lines':[],'missing_materials':[]}}
    with transaction(store.url) as db:
        access=ResearchAccess(db,user)
        original=access.project(value,access.visible_ids(db))
        row={'id':K,'missing_materials':['SECRET-MATERIAL'],'_visibility':{'latest':value['latest'],'inventory':value['inventory']}}
        masked=project_summaries(db,access,[row])[0]
        assert masked['missing_materials']==original['missing_materials']==['公开引用产品']
        assert '_visibility' not in masked and 'SECRET-' not in json.dumps(masked)


def test_bounded_routes_mask_missing_upstream_material(departments):
    from api.research import enqueue
    _,client,_,store,_,_=departments
    with transaction(store.url,write=True) as db:
        foreign=json.loads(db.execute('SELECT formula FROM research_formulas WHERE id=%s',(FOREIGN,)).fetchone()[0])
        foreign['lines'][0].update(code='SECRET-MATERIAL',ref='SECRET-MATERIAL')
        db.execute('UPDATE research_formulas SET formula=%s WHERE id=%s',(packed(foreign),FOREIGN))
        enqueue(db,'核对增量读取上游缺价投影')
    store.process_events()
    with transaction(store.url,write=True) as db:
        raw=json.loads(db.execute('SELECT payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1',(K,)).fetchone()[0])
        row=dict(raw,event_id='backfill:9999',record_type='backfill',purchase_version=9999,effective_date='2099-01-01')
        save_backfill(db,9999,K,'visibility-test',row)
    prefix='/api/workbenches/research'
    listing=client.get(prefix+'/history-page')
    assert listing.status_code==200,listing.text
    event_id=listing.json()['items'][0]['id']
    routes=['/products/'+K+'/history-page','/products/'+K+'/trend','/history/'+event_id+'/products-page','/pages/products']
    for route in routes:
        response=client.get(prefix+route)
        assert response.status_code==200,response.text
        assert 'SECRET-' not in response.text and '_visibility' not in response.text
    page=client.get(prefix+'/products/'+K+'/history-page').json()
    assert page['items'][0]['missing_materials']==['OTHER-PRODUCT']


def test_incremental_projection_preserves_cached_evidence_and_rebuilds_old_comparisons(ready):
    _,_,_,store=ready
    with transaction(store.url,write=True) as db:
        sample=json.loads(db.execute('SELECT payload FROM research_cost_records WHERE product_id=%s ORDER BY sequence DESC LIMIT 1',(K,)).fetchone()[0])
        for number,cost in [(501,'1'),(502,'1'),(503,'2')]:
            value=dict(sample,event_id=f'backfill:{number}',record_type='backfill',purchase_version=number,effective_date=f'2020-01-{number-500:02d}',latest_cost=cost)
            save_backfill(db,number,K,'incremental-'+str(number),value)
        unchanged=db.execute("SELECT _order,xmin::text,line_prices,payload->'_visibility' FROM research_history_reads WHERE product_id=%s AND event_id='backfill:501'",(K,)).fetchone()
        value=dict(sample,event_id='backfill:504',record_type='backfill',purchase_version=504,effective_date='2020-01-04',latest_cost='2')
        save_backfill(db,504,K,'incremental-504',value)
        assert db.execute("SELECT _order,xmin::text,line_prices,payload->'_visibility' FROM research_history_reads WHERE product_id=%s AND event_id='backfill:501'",(K,)).fetchone()==unchanged
        raw=json.loads(db.execute('SELECT payload FROM research_backfill_records WHERE product_id=%s AND purchase_version=502',(K,)).fetchone()[0])
        raw['latest_cost']='3'
        raw['latest']['lines'][0]['unit_cost']='3.123456789'
        db.execute('UPDATE research_backfill_records SET payload=%s WHERE product_id=%s AND purchase_version=502',(packed(raw),K))
        cached=db.execute("SELECT line_prices FROM research_history_reads WHERE product_id=%s AND event_id='backfill:502'",(K,)).fetchone()[0]
        assert cached['latest']['lines'][0]['unit_cost']=='3.123456789'
        expected={row['event_id']:row for row in linked_histories(db,[K],summary=True)[K]}
        for row in history_page(db,K,None,page_size=200)['items']:
            assert row['change']==expected[row['event_id']]['change']
            assert row.get('comparison_basis')==expected[row['event_id']].get('comparison_basis')
        db.execute('DELETE FROM research_backfill_records WHERE product_id=%s AND purchase_version=502',(K,))
        expected={row['event_id']:row for row in linked_histories(db,[K],summary=True)[K]}
        actual=history_page(db,K,None,page_size=200)['items']
        assert 'backfill:502' not in {row['event_id'] for row in actual}
        for row in actual:
            assert row['change']==expected[row['event_id']]['change']


def test_material_by_code_is_compact_and_research_scoped(departments):
    _,client,_,store,user,_=departments
    prefix='/api/workbenches/research/material-prices'
    result=client.get(prefix+'/by-code/A')
    assert result.status_code==200,result.text
    detail=result.json()
    assert detail['material']['code']=='A'
    assert detail['history_read']['base'].startswith(prefix+'/')
    assert len(detail['official_history'])<=2 and detail['sources']==[]
    assert client.get(prefix+'/by-code/NOT-A-MATERIAL').status_code==404
    with transaction(store.url,write=True) as db:
        db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='research'",(user['id'],))
    assert client.get(prefix+'/by-code/A').status_code==403
