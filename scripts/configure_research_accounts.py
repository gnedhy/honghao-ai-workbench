"""Prepare approved department activators; apply only after the checked ERP import."""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from api.identity import IdentityStore,INITIAL_ACCOUNT_PASSWORD
from api.organization import OrganizationStore
from api.postgres import database_url,transaction
from api.procurement_collaboration import set_grant

PEOPLE=[('lishurong','李树荣','研发一部'),('chengwenjing','程文静','研发二部'),('fengkun','冯坤','研发三部'),('linxueyi','林雪怡','研发四部'),('maijiayi','麦嘉仪','研发六组')]
OFFICE_PEOPLE=('李文婷','张晓英','韦妹琴','张海容')
RESEARCH_DEPARTMENTS={'研发一部','研发二部','研发三部','研发四部','研发五部','研发六组','浙江实验室'}

def configure(url,actor,apply=False):
    with transaction(url,write=apply) as db:
        identity=IdentityStore(url);admin=identity.get_user(actor)
        if not admin or not admin['is_active'] or not admin['is_system_admin']:
            raise PermissionError('需要有效系统管理员')
        users=identity.list_users();departments=OrganizationStore(url).list_departments();plan=[]
        if apply:
            metadata=db.execute('SELECT payload FROM research_meta WHERE id=1').fetchone()
            if not metadata or not json.loads(metadata[0]).get('erp_import') or db.execute("SELECT 1 FROM research_events WHERE status!='done'").fetchone():
                raise ValueError('须在 ERP 统一导入及成本核对完成后配置账号')
        for login,name,dept in PEOPLE:
            matches=[u for u in users if u['username'].lower()==login or u['display_name']==name]
            if len(matches)>1 or matches and (matches[0]['display_name']!=name or matches[0]['is_system_admin']):
                raise ValueError(name+' 存在账号身份冲突')
            found=[d for d in departments if d['name']==dept and d['parent_id'] is None]
            if len(found)>1:raise ValueError(dept+' 部门重复')
            user=matches[0] if matches else None
            old_grant=db.execute('SELECT manager FROM research_activation_grants WHERE user_id=%s',(user['id'],)).fetchone() if user else None
            plan.append({'name':name,'username':user['username'] if user else login,'department':dept,'action':'复用' if user else '创建','research_level':max(3,user['scope_levels'].get('research',0)) if user else 3,'activation':True,'grant_manager':bool(old_grant and old_grant[0])})
            if apply:
                if not found:raise ValueError('导入后的研发部门缺失')
                department_id=found[0]['id']
                if user is None:
                    user=identity.create_user(username=login,display_name=name,department=None,primary_department_id=department_id,password=INITIAL_ACCOUNT_PASSWORD,scope_levels={'research':3})
                else:
                    identity.update_profile(user['id'],actor_id=actor,membership={'primary_department_id':department_id,'additional_department_ids':[d['id'] for d in user['departments'] if d['id']!=department_id]})
                    identity.update_user(user['id'],is_active=True,scope_levels={**user['scope_levels'],'research':plan[-1]['research_level']})
                set_grant(url,admin,user['id'],True,None,'research')
        research=[d for d in departments if d['parent_id'] is None and d['name'] in RESEARCH_DEPARTMENTS]
        if apply and {d['name'] for d in research}!=RESEARCH_DEPARTMENTS:
            raise ValueError('导入后的完整研发部门缺失')
        for name in OFFICE_PEOPLE:
            matches=[u for u in users if u['display_name']==name]
            if len(matches)!=1 or not matches[0]['is_active'] or matches[0]['scope_levels'].get('research',0)<2:
                raise ValueError(name+' 原研发账号缺失或状态已变化')
            user=matches[0]
            plan.append({'name':name,'username':user['username'],'action':'扩展研发范围','departments':sorted(RESEARCH_DEPARTMENTS),'research_level':user['scope_levels']['research'],'permissions':'原启用及管理授权保持'})
            if apply:
                additional={d['id'] for d in user['departments']}|{d['id'] for d in research}
                additional.discard(user['primary_department_id'])
                # Keep the office primary membership, password, scopes and activation grants.
                identity.update_profile(user['id'],actor_id=actor,membership={'primary_department_id':user['primary_department_id'],'additional_department_ids':sorted(additional)})
        return plan

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--actor',required=True);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    print(json.dumps(configure(database_url(),args.actor,args.apply),ensure_ascii=False,indent=2))
