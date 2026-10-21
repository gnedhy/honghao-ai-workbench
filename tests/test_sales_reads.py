"""Bounded sales reads retain precision, ownership and frozen evidence."""
from copy import deepcopy

import pytest

from api.postgres import transaction
from api.research import packed
from api.sales_reads import catalog, overview, page, record, selected_products, series
from tests.test_sales import sales, prepared, adopt


def test_sales_pages_keep_history_exact_and_reset_after_update(sales):
    settings, _, store, actor = sales
    batch=adopt(sales,prepared(sales))
    original=store.history(actor,True)['records'][0]
    with transaction(settings.database_url,write=True) as db:
        for index in range(1,31):
            value=deepcopy(original)
            value.update(id=f'history-{index}',version=index+1,created_at=f'2026-09-{index:02d}T10:00:00Z')
            db.execute("INSERT INTO sales_records(id,batch_id,product_id,version,status,actor_id,created_at,payload) VALUES(%s,%s,%s,%s,'superseded',%s,%s,%s)",(value['id'],batch['id'],value['product_id'],value['version'],actor['id'],value['created_at'],packed(value)))
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT count(*),sum(adopted) FROM sales_activity WHERE batch_id=%s',(batch['id'],)).fetchone()==(1,31)
    first=page(store,actor,'records',page_size=10,product=original['product_id'])
    assert len(first['items'])==10 and first['total']==31
    assert 'parameters' not in first['items'][0]['item']
    second=page(store,actor,'records',page=2,page_size=10,product=original['product_id'],token=first['version'])
    assert not {r['id'] for r in first['items']} & {r['id'] for r in second['items']}
    assert record(store,actor,'records',original['id'])['item']==original['item']
    assert len(series(store,actor,original['product_id'],'2026-09-01','2026-09-05',original['mode'])['records'])==5
    listed=page(store,actor,'batches',page_size=10)
    assert listed['items'][0]['list_status']=='adopted'
    assert listed['items'][0]['active_count']==1
    stats=overview(store,actor,'2026-09-01','2026-09-30',original['mode'])
    assert stats['active']==1 and stats['counts']['adopted']==1
    assert stats['eligible']==[original['product_id']]
    assert stats['hot'][0]['batches']==1
    combined=page(store,actor,'timeline',batch=batch['id'],page_size=10)
    assert combined['total']==32 and len(combined['items'])==10
    assert [r['created_at'] for r in combined['items']]==sorted([r['created_at'] for r in combined['items']],reverse=True)
    store.customer_code(batch['id'],dict(revision=batch['revision'],customer_code='NEW'),actor)
    changed=page(store,actor,'records',page=2,page_size=10,product=original['product_id'],token=first['version'])
    assert changed['reset'] and changed['page']==1
    assert all(r['current_customer_code']=='NEW' for r in changed['items'])
    outsider=dict(actor,id='other',is_system_admin=False,scope_levels={'sales':2})
    assert page(store,outsider,'records')['total']==0
    assert overview(store,outsider)['active']==0
    with pytest.raises(KeyError): record(store,outsider,'records',original['id'])
    with pytest.raises(PermissionError): page(store,outsider,'timeline',batch=batch['id'])
    with pytest.raises(PermissionError): page(store,dict(outsider,scope_levels={}), 'records')
    with pytest.raises(ValueError): page(store,actor,'records',page_size=201)


def test_sales_catalog_only_loads_selected_products(sales,monkeypatch):
    _, _, store, actor=sales
    calls=[]
    original=store._catalog
    def checked(db,product_ids=None):
        assert product_ids is not None and len(product_ids)<=2
        calls.append(product_ids)
        return original(db,product_ids)
    monkeypatch.setattr(store,'_catalog',checked)
    result=catalog(store,actor,page_size=1,source='research')
    assert result['total']==2 and len(result['products'])==1
    key=result['products'][0]['id']
    assert selected_products(store,actor,[key])['products']==result['products']
    assert catalog(store,actor,page_size=1,source='research',exclude=key)['total']==1
    assert calls


def test_calculator_history_is_bounded_and_details_are_owner_only(sales):
    from api.sales_calculator import CalculatorStore, SavedInput
    _, _, store, actor=sales
    calculator=CalculatorStore(store)
    saved=[calculator.save(SavedInput(kind='template',name=f'模板{i}',payload={'mode':'domestic_direct','steps':[]}),actor) for i in range(12)]
    first=calculator.saved_page(actor,page_size=5,kind='template')
    assert first['total']==12 and len(first['saved'])==5
    assert all('steps' not in row['payload'] for row in first['saved'])
    assert calculator.saved_detail(actor,saved[0]['id'])==saved[0]
    other=dict(actor,id='other')
    assert calculator.saved_page(other,kind='template')['total']==0
    with pytest.raises(KeyError): calculator.saved_detail(other,saved[0]['id'])
    calculator.delete(saved[0]['id'],actor)
    changed=calculator.saved_page(actor,page=2,page_size=5,kind='template',token=first['version'])
    assert changed['page']==1 and changed['version']!=first['version']
