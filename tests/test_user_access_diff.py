from api.authorization import AuthorizationStore
from api.identity import IdentityStore
from scripts.user_access_diff import compare
from tests.helpers import TEST_ADMIN_PASSWORD, authenticated_client
from tests.test_procurement_workbench import procurement_settings


def test_access_diff_reads_legacy_policy_without_mutating_accounts(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings):
        identities = IdentityStore(settings.database_path)
        identities.create_user(username='diff-viewer', display_name='查看', department=None, password=TEST_ADMIN_PASSWORD, scope_levels={'procurement': 2})
        identities.create_user(username='diff-editor', display_name='编辑', department=None, password=TEST_ADMIN_PASSWORD, scope_levels={'procurement': 3})
        identities.create_user(username='diff-other', display_name='跨范围', department=None, password=TEST_ADMIN_PASSWORD, scope_levels={'research': 2})
        policy = AuthorizationStore(settings.database_path)
        policy.set_field_policy('procurement.material_unit_price', 4, 4, [], [])
        before = identities.list_users()
        changes = [c for c in compare(settings.database_path)['差异'] if c['字段'] == '原料采购单价']
        assert {(c['账号'], c['操作']) for c in changes} == {
            ('diff-viewer', '查看'), ('diff-editor', '查看'), ('diff-editor', '编辑')}
        assert identities.list_users() == before


def test_access_diff_includes_procurement_business_roles(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings):
        identities = IdentityStore(settings.database_path)
        for level in (2, 3, 4):
            identities.create_user(username=f'role-{level}', display_name=str(level), department=None,
                                   password=TEST_ADMIN_PASSWORD, scope_levels={'procurement': level})
        changes = [c for c in compare(settings.database_path)['差异'] if c['字段'] == '业务操作']
        assert {c['操作'] for c in changes if c['账号'] == 'role-3'} == {'退回更新', '查看已归档记录'}
        assert {c['操作'] for c in changes if c['账号'] == 'role-4'} == {'启用价格', '管理原料目录'}
        assert not [c for c in changes if c['账号'] == 'role-2']
