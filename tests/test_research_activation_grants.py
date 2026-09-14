"""Independent activation grants share procurement mechanics, never its scope."""
from urllib.parse import quote
import pytest
from fastapi.testclient import TestClient
from api.identity import IdentityStore
from api.main import create_app
from api import procurement_collaboration as grants
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, saved, K, PREFIX


def users_for(store):
    identity = IdentityStore(store.path)
    users = [identity.create_user(username=name, display_name=name, department='研发五部',
        password='Research-Password-2026', scope_levels={'research':level, 'procurement':3})
        for name, level in [('manager',4),('editor',3),('other',3),('viewer',2)]]
    return identity, users


def test_grant_manager_and_scope_boundaries(ready):
    settings, _, admin_id, store = ready
    identity, (manager, editor, other, viewer) = users_for(store)
    admin = identity.get_user(admin_id)
    grants.set_grant(store.path, admin, manager['id'], True, True, 'research')
    grants.set_grant(store.path, manager, editor['id'], True, scope='research')
    assert grants.capabilities(store.path, editor, 'research')['can_activate']
    assert not grants.capabilities(store.path, editor)['can_activate']
    assert not grants.capabilities(store.path, editor, 'research')['can_manage_catalog']
    for target, flag in [(other, None), (editor, True)]:
        with pytest.raises(PermissionError):
            grants.set_grant(store.path, editor, target['id'], True, flag, 'research')
    with pytest.raises(PermissionError):
        grants.set_grant(store.path, manager, other['id'], True, True, 'research')
    with pytest.raises(PermissionError):
        grants.set_grant(store.path, manager, manager['id'], False, scope='research')
    with pytest.raises(ValueError):
        grants.set_grant(store.path, manager, viewer['id'], True, scope='research')
    grants.set_grant(store.path, admin, other['id'], True)
    assert not grants.capabilities(store.path, other, 'research')['can_activate']
    grants.set_grant(store.path, admin, manager['id'], False, scope='research')
    assert grants.capabilities(store.path, manager, 'research')['can_activate']
    assert not grants.capabilities(store.path, manager, 'research')['can_manage_grants']
    assert len(grants.grants(store.path,'research')['events']) == 3
    assert len(grants.grants(store.path)['events']) == 1


@pytest.mark.parametrize('saved_by_editor',[False,True])
def test_http_grant_activate_revoke_and_no_deactivation(ready,saved_by_editor):
    settings, _, admin_id, store = ready
    identity, (manager, editor, other, viewer) = users_for(store)
    admin = identity.get_user(admin_id)
    _, receipt = saved(store, editor['id'] if saved_by_editor else other['id'])
    path = PREFIX + '/products/' + quote(K,safe='')
    with TestClient(create_app(settings)) as client:
        assert client.post('/api/login',json={'username':'editor','password':'Research-Password-2026'}).status_code == 200
        assert client.post(path+'/activate',json=receipt).status_code == 403
        grants.set_grant(store.path,admin,editor['id'],True,scope='research')
        assert client.get('/api/me/profile').json()['research_capabilities']['can_activate']
        assert client.get(path).json()['capabilities']['can_activate']
        assert client.get(PREFIX+'/activation-grants').status_code == 403
        assert client.put(PREFIX+'/activation-grants/'+other['id'],json={'enabled':True}).status_code == 403
        assert client.post(path+'/deactivate',json=receipt).status_code == 403
        assert client.post(path+'/activate',json=receipt).status_code == 200
        _, receipt = saved(store,editor['id'])
        grants.set_grant(store.path,admin,editor['id'],False,scope='research')
        assert not client.get('/api/me/profile').json()['research_capabilities']['can_activate']
        assert client.post(path+'/activate',json=receipt).status_code == 403
        with pytest.raises(ValueError,match='权限已变化'):
            store.activate(K,receipt,editor['id'])


@pytest.mark.parametrize('change',[{'is_active':False},{'scope_levels':{'research':2,'procurement':3}}])
def test_account_change_invalidates_retained_grant(ready,change):
    _, _, admin_id, store = ready
    identity, (manager, editor, other, viewer) = users_for(store)
    admin = identity.get_user(admin_id)
    grants.set_grant(store.path,admin,editor['id'],True,scope='research')
    _,receipt=saved(store,editor['id'])
    identity.update_user(editor['id'],**change)
    assert not grants.capabilities(store.path,identity.get_user(editor['id']),'research')['can_activate']
    with pytest.raises(ValueError,match='权限已变化'):
        store.activate(K,receipt,editor['id'])
    assert next(u for u in grants.grants(store.path,'research')['users'] if u['id']==editor['id'])['granted']


def test_http_manager_can_assign_but_not_promote(ready):
    settings, _, admin_id, store = ready
    identity, (manager, editor, other, viewer) = users_for(store)
    grants.set_grant(store.path,identity.get_user(admin_id),manager['id'],True,True,'research')
    with TestClient(create_app(settings)) as client:
        client.post('/api/login',json={'username':'manager','password':'Research-Password-2026'})
        assert client.get(PREFIX+'/activation-grants').status_code == 200
        route=PREFIX+'/activation-grants/'+editor['id']
        assert client.put(route,json={'enabled':True,'manager':True}).status_code == 403
        assert client.put(route,json={'enabled':True}).status_code == 200
        assert client.put(route,json={'enabled':False}).status_code == 200
        identity.update_user(manager['id'],scope_levels={'research':2})
        with pytest.raises(ValueError,match='权限已变化'):
            grants.set_grant(store.path,manager,other['id'],True,scope='research')


@pytest.mark.parametrize('scope',['research','procurement'])
@pytest.mark.parametrize('count',[0,10,11,57])
def test_grant_history_pagination_names_and_stable_order(ready,scope,count):
    import sqlite3,json
    settings,_,admin_id,store=ready
    identity,(manager,editor,other,viewer)=users_for(store)
    with sqlite3.connect(store.path) as db:
        for index in range(count):
            db.execute(f"INSERT INTO {scope}_admin_events VALUES(?,?,?,?,?,?)",(f'event-{index}',admin_id,'grant.enabled',editor['id'],json.dumps({'name':'保存时姓名'} if index%2 else {}),'2026-09-14T10:00:00+00:00'))
    first=grants.grants(store.path,scope)
    assert first['total']==count and len(first['events'])==min(count,10)
    assert first['has_more']==(count>10)
    all_events=[]
    for offset in range(0,max(count,1),50):
        page=grants.grants(store.path,scope,offset,50)
        all_events+=page['events']
        assert page['has_more']==(offset+50<count)
    assert [e['id'] for e in all_events]==[f'event-{i}' for i in reversed(range(count))]
    for event in all_events:
        assert event['target_name']==('保存时姓名' if int(event['id'].split('-')[1])%2 else 'editor')
    with TestClient(create_app(settings)) as client:
        client.post('/api/login',json={'username':'manager','password':'Research-Password-2026'})
        prefix=f'/api/workbenches/{scope}/activation-grants'
        assert client.get(prefix+'?limit=51').status_code==422
        assert client.get(prefix+'?offset=-1').status_code==422
        assert client.get(prefix).status_code==403
