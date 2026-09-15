"""Prepare a separate local acceptance environment; never switches production."""
import argparse
import hashlib
import json
import secrets
from pathlib import Path

from api.authorization import AuthorizationStore
from api.identity import IdentityStore
from api.operations import create_snapshot, verify_snapshot
from api.postgres import readiness, transaction
from api.procurement_excel import history_preview, import_history
from api.procurement_collaboration import set_grant
from api.settings import Settings


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--data-dir',type=Path,required=True)
    parser.add_argument('--source',type=Path,required=True)
    args=parser.parse_args()
    target=args.data_dir.resolve()
    if target.exists() and any(target.iterdir()):
        raise ValueError('验收目录必须为空；不会覆盖旧环境')
    source=args.source.resolve()
    preview=history_preview(source.read_bytes())
    if (preview['material_count'],preview['history_material_count'],len(preview['dates'])) != (460,138,20):
        raise ValueError('源文件数量与已确认方案不同')
    settings=Settings.from_data_dir(target,workbench_modes={'procurement':'active','research':'off','sales':'off','management':'off'},database_environment='acceptance')
    if any(value != 'ok' for value in readiness(settings.database_url, 'acceptance').values()):
        raise ValueError('请先由迁移账号显式准备独立验收数据库')
    with transaction(settings.database_url) as db:
        for table in ('identity_users', 'procurement_materials', 'research_formulas'):
            if db.execute(f'SELECT 1 FROM {table} LIMIT 1').fetchone():
                raise ValueError('验收数据库必须为空；不会覆盖已有业务数据')
    settings.ensure_directories()
    identities=IdentityStore(settings.database_url)
    accounts=[]
    for username,name in [('admin','验收管理员'),('lixueying','黎雪莹'),('zengwenshu','曾文舒'),('fuyong','付勇'),('wangyuanyuan','王远远'),('zengqi','曾淇')]:
        password=secrets.token_urlsafe(20)
        user=identities.create_user(username=username,display_name=name,department='采购部',password=password,is_system_admin=username=='admin',scope_levels={} if username=='admin' else {'procurement':3})
        accounts.append({'id':user['id'],'username':username,'name':name,'password':password})
    authorization=AuthorizationStore(settings.database_url)
    for field in ['procurement.material_unit_price','procurement.supplier_quote']:
        authorization.set_field_policy(field,2,3,['procurement'],['procurement'])
    admin=identities.get_user(accounts[0]['id'])
    set_grant(settings.database_url,admin,accounts[1]['id'],True,True)
    import_history(settings.database_url,source,admin['id'],data_dir=settings.data_dir,expected_sha256=preview['sha256'])
    (target/'acceptance-accounts.json').write_text(json.dumps(accounts,ensure_ascii=False,indent=2),encoding='utf-8')
    (target/'source-preflight.json').write_text(json.dumps(preview,ensure_ascii=False,indent=2),encoding='utf-8')
    if hashlib.sha256(source.read_bytes()).hexdigest()!=preview['sha256']:
        raise ValueError('原文件校验发生变化')
    snapshot=create_snapshot(settings,target/'backups')
    verify_snapshot(snapshot,expected_environment=settings.environment,expected_database_environment=settings.database_environment)
    print(json.dumps({'environment':settings.environment,'database_environment':settings.database_environment,'data_dir':str(target),'snapshot':str(snapshot),'materials':460,'versions':20,'credentials':'acceptance-accounts.json'},ensure_ascii=False))


if __name__=='__main__':main()
