"""Prepare a separate local acceptance environment; never switches production."""
import argparse
import hashlib
import json
import secrets
from pathlib import Path

from api.authorization import AuthorizationStore
from api.identity import IdentityStore
from api.operations import migrate_data, create_snapshot, verify_snapshot
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
    settings=Settings.from_data_dir(target,workbench_modes={'procurement':'active','research':'off','sales':'off','management':'off'})
    migrate_data(settings)
    identities=IdentityStore(settings.database_path)
    accounts=[]
    for username,name in [('admin','验收管理员'),('lixueying','黎雪莹'),('zengwenshu','曾文舒'),('fuyong','付勇'),('wangyuanyuan','王远远'),('zengqi','曾淇')]:
        password=secrets.token_urlsafe(20)
        user=identities.create_user(username=username,display_name=name,department='采购部',password=password,is_system_admin=username=='admin',scope_levels={} if username=='admin' else {'procurement':3})
        accounts.append({'id':user['id'],'username':username,'name':name,'password':password})
    authorization=AuthorizationStore(settings.database_path)
    for field in ['procurement.material_unit_price','procurement.supplier_quote']:
        authorization.set_field_policy(field,2,3,['procurement'],['procurement'])
    admin=identities.get_user(accounts[0]['id'])
    set_grant(settings.database_path,admin,accounts[1]['id'],True,True)
    import_history(settings.database_path,source,admin['id'],expected_sha256=preview['sha256'])
    (target/'acceptance-accounts.json').write_text(json.dumps(accounts,ensure_ascii=False,indent=2),encoding='utf-8')
    (target/'source-preflight.json').write_text(json.dumps(preview,ensure_ascii=False,indent=2),encoding='utf-8')
    if hashlib.sha256(source.read_bytes()).hexdigest()!=preview['sha256']:
        raise ValueError('原文件校验发生变化')
    snapshot=create_snapshot(settings,target/'backups');verify_snapshot(snapshot,expected_environment='test')
    print(json.dumps({'environment':'test','data_dir':str(target),'snapshot':str(snapshot),'materials':460,'versions':20,'credentials':'acceptance-accounts.json'},ensure_ascii=False))


if __name__=='__main__':main()
