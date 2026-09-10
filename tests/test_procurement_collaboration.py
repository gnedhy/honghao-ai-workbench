import io
import json
import sqlite3
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path
from openpyxl import Workbook

import pytest
from fastapi.testclient import TestClient

from api.authorization import AuthorizationStore
from api.identity import IdentityStore
from api.main import create_app
from api.procurement import ProcurementStore
from api.procurement_collaboration import capabilities, set_grant
from api.procurement_excel import history_preview, import_history, read_workbook, selected_prices, price_value
from tests.helpers import authenticated_client, TEST_ADMIN_PASSWORD
from tests.test_procurement_workbench import procurement_settings

SOURCE_NAME = '采购迁入测试.xlsx'
PREFIX = '/api/workbenches/procurement'
PASSWORD = 'Independent-Test-Password-2026'


def test_capabilities_follow_scope_without_implying_activation_or_catalog_access(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings):
        pass
    AuthorizationStore(settings.database_path).set_field_policy('procurement.material_unit_price', 4, 4, [], [])
    for scope in ('procurement', 'research', 'sales', 'management', 'knowledge'):
        for level in (0, 2, 3, 4):
            user = {'id': 'ungranted', 'is_active': True, 'is_system_admin': False, 'scope_levels': {scope: level}}
            result = capabilities(settings.database_path, user)
            assert result['can_edit'] == (scope == 'procurement' and level >= 3)
            assert result['can_activate'] == (scope == 'procurement' and level >= 4)
            assert result['can_manage_catalog'] == (scope == 'procurement' and level >= 4)
            assert not any(result[key] for key in ('can_manage_grants', 'can_cancel_round'))
    user = {'id': 'admin', 'is_active': True, 'is_system_admin': True, 'scope_levels': {}}
    assert all(capabilities(settings.database_path, user).values())
    user['is_active'] = False
    assert not capabilities(settings.database_path, user)['can_edit']
    assert not capabilities(settings.database_path, user)['can_activate']


@pytest.fixture
def real_data(tmp_path):
    source = tmp_path / SOURCE_NAME
    workbook = Workbook(); total = workbook.active; total.title='原料行情总表'
    dates=['2026-04-28','2026-05-07','2026-05-12','2026-05-19','2026-05-26','2026-06-01','2026-06-09','2026-06-16','2026-06-23','2026-06-30','2026-07-07','2026-07-14','2026-07-21','2026-07-28','2026-08-04','2026-08-11','2026-08-18','2026-08-25','2026-09-01','2026-09-08']
    header=['采购员','品名','库存数量',*dates]; total.append(header)
    codes=['CF001L','CF001M','CF002','CF021B',*[f'CF{i:04}' for i in range(134)]]
    unpriced=[f'UN{i:04}' for i in range(322)]
    for i,code in enumerate(codes):
        values=[13.5 if i==0 else 10] * 19
        if i==3: values[1]='4..5'
        if 4<=i<=13: values[1]='10-11'
        total.append(['来源采购员',code,None,*values,(11 if i<=19 else 10) if 1<=i<=30 else None])
    offset=0
    for name,priced,missing in [('研发一部',88,94),('研发二部',20,2),('研发三部',72,196),('研发四部',16,11),('研发五部',50,50),('宏昊生物',9,0)]:
        sheet=workbook.create_sheet(name);sheet.append(header)
        for code in codes[:priced]+[unpriced[(offset+j)%322] for j in range(missing)]:sheet.append(['来源采购员',code])
        offset+=missing
    workbook.save(source)
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        admin = client.get('/api/me').json()
        result = history_preview(source.read_bytes())
        import_history(settings.database_path, source, admin['id'], expected_sha256=result['sha256'])
        for field in ['procurement.material_unit_price','procurement.supplier_quote']:
            AuthorizationStore(settings.database_path).set_field_policy(field,2,3,['procurement'],['procurement'])
        identities = IdentityStore(settings.database_path)
        users = [identities.create_user(username=f'buyer{i}', display_name=name, department='采购部',password=PASSWORD,scope_levels={'procurement':3}) for i,name in enumerate(['黎雪莹','曾文舒','付勇'])]
        set_grant(settings.database_path, admin, users[0]['id'], True, True)
        yield settings, client, users


def overview(client):
    response = client.get(PREFIX+'/overview')
    assert response.status_code == 200, response.text
    return response.json()


def save(client, code, value, revision=None):
    data=overview(client)
    update=data['current_update']
    return client.post(PREFIX+'/prices/bulk-adjustments',json={
        'update_id':update['id'] if update else None,'updated_at':update['updated_at'] if update else None,
        'effective_date':'2026-09-09','reason':'供应商最新报价','items':[{'material_id':next(m['id'] for m in data['materials'] if m['code']==code),'price':value}], **(revision or {})})


def publish(client, mode='immediate'):
    data=overview(client); update=data['current_update']
    return client.post(PREFIX+f"/updates/{update['id']}/publish",json={'mode':mode,'activate_at':(datetime.now(UTC)+timedelta(hours=1)).isoformat() if mode=='scheduled' else None,'updated_at':update['updated_at'],'baseline_id':data['batches'][0]['id']})


def login(client, index):
    client.post('/api/logout')
    assert client.post('/api/login',json={'username':f'buyer{index}','password':PASSWORD}).status_code==200


def test_real_migration_counts_dates_provenance_and_no_invented_events(real_data):
    settings,client,_=real_data
    data=overview(client)
    assert len(data['materials'])==460
    assert sum(m['published_price'] is not None for m in data['materials'])==138
    assert [(len(d['material_ids']),d['priced']) for d in data['departments']]==[(182,88),(22,20),(268,72),(27,16),(100,50),(9,9)]
    assert [b['version'] for b in data['batches']]==list(range(20,0,-1))
    latest=data['batches'][0]
    assert (latest['comparison']['up'],latest['comparison']['down'],latest['comparison']['unchanged'])==(19,0,119)
    assert latest['provenance']['reported_count']==30
    assert sum(m['reported'] for m in data['materials'])==30
    for code in ['CF001L', next(m['code'] for m in data['materials'] if m['published_price'] is None)]:
        material=next(m for m in data['materials'] if m['code']==code)
        detail=client.get(PREFIX+f"/materials/{material['id']}")
        assert detail.status_code==200,detail.text
        assert detail.json()['changes']==[]
    detail=client.get(PREFIX+f"/batches/{latest['id']}").json()
    assert detail['changes']==[] and detail['provenance']['filename']==SOURCE_NAME
    assert detail['snapshot_sources'][next(m['id'] for m in data['materials'] if m['code']=='CF001L')]['price_date']=='2026-09-01'
    v3=data['batches'][-3]
    material=next(m for m in data['materials'] if m['code']=='CF021B')
    assert v3['comparison']['items'][material['id']]['kind']=='incomparable'
    with pytest.raises(ValueError,match='已迁入'):
        source=settings.data_dir.parent / SOURCE_NAME
        import_history(settings.database_path,source,IdentityStore(settings.database_path).list_users()[0]['id'],expected_sha256=history_preview(source.read_bytes())['sha256'])


def test_import_audit_keeps_only_hash_and_counts_without_losing_source_values(real_data):
    settings, _, _ = real_data
    with sqlite3.connect(settings.database_path) as db:
        detail = json.loads(db.execute("SELECT detail FROM procurement_admin_events WHERE action='history.imported'").fetchone()[0])
        sha = db.execute('SELECT sha256 FROM procurement_source_imports').fetchone()[0]
        assert detail == {'sha256': sha, 'material_count': 460, 'history_material_count': 138, 'version_count': 20, 'anomaly_count': 11}
        assert db.execute("SELECT count(*) FROM procurement_snapshot_sources WHERE raw_price='4..5'").fetchone()[0] > 0
        assert db.execute("SELECT count(*) FROM procurement_snapshot_sources WHERE raw_price='10-11'").fetchone()[0] > 0


def test_shared_edit_conflicts_attribution_and_official_distribution(real_data):
    settings,client,users=real_data
    initial=overview(client)
    login(client,1)
    assert save(client,'CF001L','13.6').status_code==200
    one=overview(client)['current_update']
    login(client,2)
    assert save(client,'CF001L','13.7').status_code==200
    conflict=save(client,'CF001L','14',{'update_id':one['id'],'updated_at':one['updated_at']})
    assert conflict.status_code==409
    data=overview(client); material=next(m for m in data['materials'] if m['code']=='CF001L')
    assert material['latest_price']=='13.7' and material['published_price']=='13.5'
    assert {u['id'] for u in material['round_participants']}=={users[1]['id'],users[2]['id']}
    filtered=client.get(PREFIX+'/overview',params={'editor_id':users[1]['id']}).json()
    assert filtered['materials'][0]['latest_price']=='13.7'
    assert data['departments']==initial['departments']
    assert publish(client).status_code==403
    login(client,0)
    assert publish(client).status_code==200
    assert next(m for m in overview(client)['materials'] if m['code']=='CF001L')['published_price']=='13.7'
    assert client.get(PREFIX+'/overview',params={'editor_id':users[1]['id']}).json()['materials']==[]
    assert len(client.get(PREFIX+'/overview',params={'editor_id':users[1]['id'],'editor_scope':'all'}).json()['materials'])==1
    batch=client.get(PREFIX+'/batches/'+overview(client)['batches'][0]['id']).json()
    assert {c['actor'] for c in batch['changes']}=={'曾文舒','付勇'}


def test_grants_no_delegation_risk_confirmation_and_stale_overview(real_data):
    settings,client,users=real_data
    login(client,1)
    assert save(client,'CF001L','27').status_code==200
    update=overview(client)['current_update']; issue=next(i for i in update['issues'] if i['kind']=='price_spike')
    path=PREFIX+f"/updates/{update['id']}/issues/{issue['id']}/review"
    assert client.post(path,json={'reason':'供应商确认无误','updated_at':update['updated_at']}).status_code==403
    assert client.put(PREFIX+'/activation-grants/'+users[2]['id'],json={'enabled':True}).status_code==403
    login(client,0)
    assert client.put(PREFIX+'/activation-grants/'+users[1]['id'],json={'enabled':True}).status_code==200
    login(client,1)
    assert client.put(PREFIX+'/activation-grants/'+users[2]['id'],json={'enabled':True}).status_code==403
    assert save(client,'CF001L','28').status_code==200
    assert client.post(path,json={'reason':'供应商确认无误','updated_at':update['updated_at']}).status_code==409
    update=overview(client)['current_update']
    assert client.post(path,json={'reason':'供应商确认无误','updated_at':update['updated_at']}).status_code==200
    reviewed=overview(client)['current_update']
    assert save(client,'CF001L','29').status_code==200
    assert client.post(PREFIX+f"/updates/{reviewed['id']}/publish",json={'mode':'immediate','updated_at':reviewed['updated_at'],'baseline_id':overview(client)['batches'][0]['id']}).status_code==409
    login(client,0)
    assert client.put(PREFIX+'/activation-grants/'+users[1]['id'],json={'enabled':False}).status_code==200
    login(client,1)
    assert publish(client).status_code==403


def test_cancel_and_schedule_copy_keep_correct_before_and_source(real_data):
    settings,client,_=real_data
    assert save(client,'CF001L','13.9').status_code==200
    update=overview(client)['current_update']
    assert client.post(PREFIX+f"/updates/{update['id']}/cancel",json={'reason':'取消本轮测试'}).status_code==200
    assert next(m for m in overview(client)['materials'] if m['code']=='CF001L')['latest_price']=='13.5'
    assert save(client,'CF001L','13.6').status_code==200
    update=overview(client)['current_update']
    assert update['changes'][0]['items'][0]['before']=='13.5'
    assert publish(client,'scheduled').status_code==200
    response=client.post(PREFIX+f"/updates/{update['id']}/cancel-schedule",json={'reason':'复制排期演练','copy_to_draft':True})
    assert response.status_code==200,response.text
    assert publish(client).status_code==200
    latest=overview(client)['batches'][0]
    detail=client.get(PREFIX+'/batches/'+latest['id']).json()
    material=next(m for m in overview(client)['materials'] if m['code']=='CF001L')
    assert detail['snapshot_sources'][material['id']]['price_date']=='2026-09-09'
    assert detail['snapshot_sources'][material['id']]['raw_price']=='13.6'
    assert detail['changes'][0]['event']=='copied_from_schedule'


def test_disabled_or_revoked_scheduler_pauses_immediately(real_data):
    settings,client,users=real_data
    login(client,0)
    assert save(client,'CF001L','13.6').status_code==200
    assert publish(client,'scheduled').status_code==200
    IdentityStore(settings.database_path).update_user(users[0]['id'],is_active=False)
    with sqlite3.connect(settings.database_path) as db:
        assert db.execute("SELECT status FROM procurement_updates ORDER BY created_at DESC LIMIT 1").fetchone()[0]=='revalidation_required'
    assert ProcurementStore(settings.database_path).process_scheduled(datetime.now(UTC)+timedelta(days=1))==0


@pytest.mark.parametrize('independent_grant', [False, True])
def test_manager_demotion_only_pauses_when_effective_activation_is_lost(real_data, independent_grant):
    settings,client,users = real_data
    admin = client.get('/api/me').json()
    target = users[1]['id']
    IdentityStore(settings.database_path).update_user(target, scope_levels={'procurement':4})
    if independent_grant:
        set_grant(settings.database_path, admin, target, True)
    login(client,2)
    assert save(client,'CF001L','13.6').status_code == 200
    login(client,1)
    assert publish(client,'scheduled').status_code == 200
    IdentityStore(settings.database_path).update_user(target, scope_levels={'procurement':3})
    with sqlite3.connect(settings.database_path) as db:
        status = db.execute('SELECT status FROM procurement_updates ORDER BY created_at DESC LIMIT 1').fetchone()[0]
    assert status == ('scheduled' if independent_grant else 'revalidation_required')


def test_revoking_independent_grant_keeps_manager_activation_and_schedule(real_data):
    settings,client,users = real_data
    admin = client.get('/api/me').json()
    target = users[1]['id']
    IdentityStore(settings.database_path).update_user(target, scope_levels={'procurement':4})
    set_grant(settings.database_path, admin, target, True)
    login(client,2)
    assert save(client,'CF001L','13.6').status_code == 200
    login(client,1)
    assert publish(client,'scheduled').status_code == 200
    set_grant(settings.database_path, admin, target, False)
    from api.procurement_collaboration import grants
    row = next(u for u in grants(settings.database_path)['users'] if u['id'] == target)
    assert row['role_granted'] and not row['granted'] and not row['manager']
    assert capabilities(settings.database_path, IdentityStore(settings.database_path).get_user(target))['can_activate']
    with sqlite3.connect(settings.database_path) as db:
        assert db.execute('SELECT status FROM procurement_updates ORDER BY created_at DESC LIMIT 1').fetchone()[0] == 'scheduled'


def test_daily_import_full_preview_blanks_unknown_and_revision(real_data):
    _,client,_=real_data
    payload={'source_name':'日常导入','effective_date':'2026-09-09','reason':'供应商最新报价','content':'编号,名称,单位,最新价\nCF001L,CF001L,kg,\nCF001M,CF001M,kg,错误\nCF002,CF002,kg,-1\nNEW-X,NEW-X,kg,12\n'}
    result=client.post(PREFIX+'/import-preview',json=payload).json()
    assert len(result['rows'])==4 and result['skipped_count']==3
    assert client.post(PREFIX+'/imports',json=payload).status_code==422
    payload['content']='编号,名称,单位,最新价\nCF001L,CF001L,kg,\nCF001M,CF001M,kg,3.8\n'
    assert client.post(PREFIX+'/imports',json=payload).status_code==201
    data=overview(client)
    assert next(m for m in data['materials'] if m['code']=='CF001L')['latest_price']=='13.5'
    assert len(data['current_update']['changes'][0]['items'])==1
    assert client.post(PREFIX+'/imports',json=payload).status_code==409
    assert len(overview(client)['materials'])==460


def test_department_membership_only_and_xlsx_limits(real_data):
    settings,client,_=real_data
    data=overview(client); group=data['departments'][0]
    response=client.put(PREFIX+f"/departments/{group['id']}/materials",json={'material_ids':group['material_ids'][1:]})
    assert response.status_code==200
    after=overview(client)
    assert len(after['materials'])==460 and after['batches']==data['batches']
    assert after['departments'][1:]==data['departments'][1:]
    login(client,1)
    assert client.put(PREFIX+f"/departments/{group['id']}/materials",json={'material_ids':[]}).status_code==403
    selected=selected_prices((settings.data_dir.parent / SOURCE_NAME).read_bytes(),'原料行情总表','2026-09-08',{m['code']:m for m in data['materials']})
    assert selected['valid']==30 and selected['unreported']==108
    bomb=io.BytesIO()
    with zipfile.ZipFile(bomb,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('xl/vbaProject.bin',b'dummy')
    with pytest.raises(ValueError): read_workbook(bomb.getvalue())


def test_revalidated_snapshot_and_copied_edit_keep_provenance(real_data):
    _,client,_ = real_data
    assert save(client,'CF001L','13.6').status_code == 200
    scheduled = overview(client)['current_update']
    assert publish(client,'scheduled').status_code == 200
    assert save(client,'CF001M','12').status_code == 200
    assert publish(client).status_code == 200
    assert overview(client)['current_update']['status'] == 'revalidation_required'
    assert publish(client).status_code == 200
    data = overview(client)
    mid = next(m['id'] for m in data['materials'] if m['code']=='CF001M')
    batch = client.get(PREFIX+'/batches/'+data['batches'][0]['id']).json()
    assert next(i['latest_price'] for i in batch['items'] if i['material_id']==mid) == '11'
    assert batch['snapshot_sources'][mid]['raw_price'] == '11'
    assert batch['snapshot_sources'][mid]['price_date'] == '2026-09-08'
    assert save(client,'CF001L','13.8').status_code == 200
    scheduled = overview(client)['current_update']
    assert publish(client,'scheduled').status_code == 200
    assert client.post(PREFIX+f"/updates/{scheduled['id']}/cancel-schedule",json={'reason':'复制后单项修改','copy_to_draft':True}).status_code == 200
    material = next(m for m in overview(client)['materials'] if m['code']=='CF001L')
    detail = client.get(PREFIX+'/materials/'+material['id']).json()
    assert client.post(PREFIX+'/materials/'+material['id']+'/adjustments',json={'price':'13.9','effective_date':'2026-09-09','reason':'修改复制后的价格','updated_at':detail['material']['updated_at']}).status_code == 201
    assert overview(client)['current_update']['changes'][0]['items'][0]['before'] == '13.8'
    assert publish(client).status_code == 200
    batch = client.get(PREFIX+'/batches/'+overview(client)['batches'][0]['id']).json()
    assert batch['snapshot_sources'][material['id']]['raw_price'] == '13.9'


def test_excel_numeric_expansion_malformed_xml_and_failed_archive(real_data):
    settings,client,users = real_data
    for value in ['1e100000','1e-100000','1e9999999','NaN','Infinity','-1']:
        assert price_value(value) == (None,'invalid')
    source = settings.data_dir.parent / SOURCE_NAME
    content = source.read_bytes()
    damaged = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(content)) as old, zipfile.ZipFile(damaged,'w') as new:
        for entry in old.infolist():
            new.writestr(entry, b'<broken>' if entry.filename=='xl/workbook.xml' else old.read(entry.filename))
    response = client.post(PREFIX+'/excel-preview', files={'file':('broken.xlsx',damaged.getvalue())})
    assert response.status_code == 422
    archive = settings.data_dir/'controlled-work'/'procurement-sources'/(history_preview(content)['sha256']+'.xlsx')
    with pytest.raises(PermissionError):
        import_history(settings.database_path,source,users[1]['id'],expected_sha256=history_preview(content)['sha256'])
    assert archive.read_bytes() == content
