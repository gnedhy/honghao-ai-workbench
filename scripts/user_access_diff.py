"""Read-only comparison of legacy field restrictions and scope-based access."""
import argparse
import json
import sys

import psycopg

from api.authorization import FIELD_CATALOG
from api.postgres import transaction
from api.settings import Settings


def compare(database_url: str):
    with transaction(database_url) as connection:
        users = connection.execute('SELECT id,username,display_name,is_active,access_level FROM identity_users').fetchall()
        scopes = connection.execute('SELECT user_id,scope_id,access_level FROM identity_user_scopes').fetchall()
        policies = {row[0]: row[1:] for row in connection.execute('SELECT field_id,read_min_level,write_min_level,read_scope_ids,write_scope_ids FROM authorization_field_policies')}
        activation_grants = {row[0] for row in connection.execute('SELECT user_id FROM procurement_activation_grants')}
    changes = []
    for user_id, username, name, active, level in users:
        if level == 5:
            continue
        grants = {scope: value for uid, scope, value in scopes if uid == user_id}
        for field_id, area, field_name, _ in FIELD_CATALOG:
            scope = field_id.split('.')[0]
            policy = policies.get(field_id, (4, 4, '[]', '[]'))
            for index, (operation, minimum) in enumerate([('查看', 2), ('编辑', 3)]):
                gate = grants.get(scope, 0) >= minimum
                old = gate and any(grants.get(s, 0) >= policy[index] for s in json.loads(policy[index + 2]))
                new = gate
                if old != new:
                    changes.append({'账号': username, '姓名': name, '账号状态': '使用中' if active else '已停用（仅重新启用后影响）',
                                    '范围': area, '字段': field_name, '操作': operation, '原权限': old, '新权限': new})
        procurement = grants.get('procurement', 0)
        price_policy = policies.get('procurement.material_unit_price', (4, 4, '[]', '[]'))
        old_write = procurement >= 3 and any(grants.get(s, 0) >= price_policy[1] for s in json.loads(price_policy[3]))
        for operation, old, new in [
            ('退回更新', procurement >= 4, procurement >= 3),
            ('查看已归档记录', procurement >= 4, procurement >= 3),
            ('启用价格', old_write and user_id in activation_grants, procurement >= 3 and (procurement >= 4 or user_id in activation_grants)),
            ('管理原料目录', False, procurement >= 4),
        ]:
            if old != new:
                changes.append({'账号': username, '姓名': name, '账号状态': '使用中' if active else '已停用（仅重新启用后影响）',
                                '范围': '采购工作台', '字段': '业务操作', '操作': operation, '原权限': old, '新权限': new})
    return {'账号数': len(users), '受影响账号数': len({c['账号'] for c in changes}),
            '当前启用受影响账号数': len({c['账号'] for c in changes if c['账号状态'] == '使用中'}),
            '说明': '比较正式旧字段策略及采购业务操作；编辑可退回及查看归档，管理包含启用和目录管理。非当前启用工作台为未来影响。知识内容边界不变，未读取密码或会话。', '差异': changes}


def main(argv=None):
    parser = argparse.ArgumentParser(description='只读比较账号权限；数据库连接使用 HONGHAO_DATABASE_URL 环境变量。')
    parser.parse_args(argv)
    try:
        settings = Settings.from_environment()
        print(json.dumps(compare(settings.database_url), ensure_ascii=False, indent=2))
        return 0
    except (psycopg.Error, OSError, ValueError, RuntimeError):
        print('权限比较失败，请检查数据库连接、权限和运行配置。', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
