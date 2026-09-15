"""Explicit RD5 account setup. Dry run by default; never resets existing passwords."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.identity import IdentityStore, INITIAL_ACCOUNT_PASSWORD
from api.organization import OrganizationStore
from api.authorization import AuthorizationStore
from api.postgres import database_url, transaction

PEOPLE = [('linfeifei', '林菲菲', 4), ('caishilu', '蔡诗璐', 3),
          ('chengyunhong', '成运洪', 3), ('lubin', '卢彬', 3), ('wenhao', '温豪', 3)]


def configure(url, actor, apply=False):
    with transaction(url, write=apply):
        identity = IdentityStore(url)
        admin = identity.get_user(actor)
        if not admin or not admin['is_active'] or not admin['is_system_admin']:
            raise ValueError('需要有效系统管理员')
        users = identity.list_users()
        plan = []
        for username, name, level in PEOPLE:
            matches = [u for u in users if u['username'].lower() == username or u['display_name'] == name]
            if len(matches) > 1 or (matches and matches[0]['display_name'] != name):
                raise ValueError(f'{name} 存在账号或身份冲突，请核对后再配置')
            plan.append((username, name, level, matches[0] if matches else None))
        org = OrganizationStore(url)
        departments = [d for d in org.list_departments() if d['name'] == '研发五部']
        if len(departments) > 1:
            raise ValueError('存在多个研发五部，请核对部门')
        if apply:
            department = departments[0] if departments else org.save(actor, '研发五部', None)
            for username, name, level, user in plan:
                if user is None:
                    user = identity.create_user(username=username, display_name=name, department=None,
                        primary_department_id=department['id'], password=INITIAL_ACCOUNT_PASSWORD, scope_levels={'research':level})
                else:
                    identity.update_profile(user['id'], actor_id=actor, membership={
                        'primary_department_id':department['id'],
                        'additional_department_ids':[d['id'] for d in user.get('departments', []) if d['id'] != department['id']]})
                    identity.update_user(user['id'], is_active=True,
                        scope_levels={**user['scope_levels'], 'research':level})
                AuthorizationStore(url).audit('research.account.configured', actor_user_id=actor,
                    target_type='account', target_id=user['id'])
        return [{'name':n,'username':u['username'] if u else login,'research_level':l,
                 'action':'reuse' if u else 'create'} for login,n,l,u in plan]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--actor', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(configure(database_url(), args.actor, args.apply), ensure_ascii=False, indent=2))
