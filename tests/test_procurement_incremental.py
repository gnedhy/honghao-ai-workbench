"""Procurement read bounds and frozen evidence parity."""
from datetime import date, timedelta
import pytest
from api.postgres import transaction
from api.procurement import ProcurementStore
from api.procurement_reads import official_history, series, eligible
from tests.test_procurement_collaboration import real_data, PREFIX, PASSWORD


def test_scoped_procurement_history_matches_frozen_prices_and_attribution(real_data):
    settings, client, _ = real_data
    store=ProcurementStore(settings.database_url)
    with transaction(settings.database_url,write=True) as db:
        db.execute("INSERT INTO procurement_batch_revisions(batch_id,note,actor,recorded_at) SELECT id,'库存口径已修订','test','2026-10-21' FROM procurement_price_batches ORDER BY version DESC LIMIT 1")
    full_overview=store.overview()
    assert full_overview['batches'][0]['revision_note']=='库存口径已修订'
    compact_overview=client.get(PREFIX+'/overview?compact=true').json()
    assert compact_overview['materials']==full_overview['materials']
    assert compact_overview['metrics']==full_overview['metrics']
    assert compact_overview['batches']==full_overview['batches'][:2]
    batches=client.get(PREFIX+'/batches/page?page_size=7').json()
    assert batches['scope_total']==20 and len(batches['items'])==7
    assert batches['items']==full_overview['batches'][:7]
    material=next(item for item in full_overview['materials'] if item['code']=='CF001L')
    mid=material['id']
    original=store.material_detail(mid)
    compact=client.get(f'{PREFIX}/materials/{mid}?compact=true')
    assert compact.status_code==200,compact.text
    assert len(compact.json()['official_history'])==2
    assert compact.json()['comparison']==original['comparison']
    expected={row['id']:row for row in original['official_history']}
    found={}
    first=official_history(settings.database_url,mid,page_size=7)
    for page in range(1,4):
        result=official_history(settings.database_url,mid,page_size=7,page=page,version=first['version'])
        assert len(result['items'])<=7
        for row in result['items']:
            assert 'sheet' not in row and 'cell' not in row
            detail=client.get(f"{PREFIX}/materials/{mid}/official-history/{row['id']}")
            assert detail.status_code==200
            found[row['id']]=detail.json()
    assert found==expected
    assert official_history(settings.database_url,mid,search='来源采购员')['total']==len(expected)
    bounded=series(settings.database_url,material_id=mid,start='2026-08-01',end='2026-09-08')
    old=store.price_series()
    wanted=[{**batch,'items':[item for item in batch['items'] if item['material_id']==mid], 'snapshot_sources':{key:value for key,value in batch['snapshot_sources'].items() if key==mid}} for batch in old['batches'] if '2026-08-01'<=batch['price_date']<='2026-09-08']
    assert bounded['batches']==wanted
    assert mid in eligible(settings.database_url,'2026-08-01','2026-09-08')


def test_procurement_period_growth_keeps_range_bounded_and_invalidates_page(real_data):
    settings,client,_=real_data
    store=ProcurementStore(settings.database_url)
    mid=next(item['id'] for item in store.overview()['materials'] if item['code']=='CF001L')
    before=official_history(settings.database_url,mid)
    fixed=series(settings.database_url,material_id=mid,start='2026-08-01',end='2026-09-08')
    with transaction(settings.database_url,write=True) as db:
        template=db.execute('SELECT id FROM procurement_price_batches ORDER BY version DESC LIMIT 1').fetchone()[0]
        for version in range(21,521):
            ident=f'growth-{version}'
            day=(date(2027,1,1)+timedelta(days=version)).isoformat()
            db.execute("INSERT INTO procurement_price_batches(id,version,published_by,published_at,item_count,price_date) SELECT %s,%s,published_by,%s,1,%s FROM procurement_price_batches WHERE id=%s",(ident,version,day,day,template))
            db.execute("INSERT INTO procurement_price_batch_items(batch_id,material_id,code,name,unit,latest_price,inventory_price,in_transit_price) SELECT %s,material_id,code,name,unit,latest_price,inventory_price,in_transit_price FROM procurement_price_batch_items WHERE batch_id=%s AND material_id=%s",(ident,template,mid))
    assert series(settings.database_url,material_id=mid,start='2026-08-01',end='2026-09-08')==fixed
    response=client.get(f'{PREFIX}/materials/{mid}/official-history',params={'page':2,'version':before['version']})
    assert response.status_code==409
    reread=client.get(f'{PREFIX}/materials/{mid}/official-history').json()
    assert len(reread['items'])==10 and reread['total']==520
    assert reread['items'][0]['id']=='growth-520'
    boundaries=series(settings.database_url,start='2026-08-01',end='2029-01-01',boundaries=True)
    assert sum(len(batch['items']) for batch in boundaries['batches'])<=2*len(store.overview()['materials'])
    # Projection and original publication move together, and both roll back together.
    with pytest.raises(RuntimeError,match='rollback probe'):
        with transaction(settings.database_url,write=True) as db:
            db.execute("UPDATE procurement_price_batch_items SET latest_price='123.4567890123456789' WHERE batch_id='growth-520' AND material_id=%s",(mid,))
            assert db.execute("SELECT latest_price FROM procurement_price_read_points WHERE batch_id='growth-520' AND material_id=%s",(mid,)).fetchone()[0]=='123.4567890123456789'
            raise RuntimeError('rollback probe')
    assert official_history(settings.database_url,mid)['version']==reread['version']
    assert series(settings.database_url,material_id=mid,start='2026-08-01',end='2026-09-08')==fixed



def test_procurement_incremental_reads_keep_live_permissions(real_data):
    settings,client,users=real_data
    mid=next(item['id'] for item in ProcurementStore(settings.database_url).overview()['materials'] if item['code']=='CF001L')
    client.post('/api/logout')
    assert client.post('/api/login',json={'username':'buyer0','password':PASSWORD}).status_code==200
    assert client.get(f'{PREFIX}/materials/{mid}/official-history').status_code==200
    with transaction(settings.database_url,write=True) as db:
        db.execute("DELETE FROM identity_user_scopes WHERE user_id=%s AND scope_id='procurement'",(users[0]['id'],))
    assert client.get(f'{PREFIX}/materials/{mid}/official-history').status_code==403
    assert client.get(f'{PREFIX}/materials/{mid}/trend',params={'start':'2026-01-01','end':'2026-12-31'}).status_code==403
    assert client.get(f'{PREFIX}/price-series/scoped',params={'material_id':mid,'start':'2026-01-01','end':'2026-12-31'}).status_code==403
