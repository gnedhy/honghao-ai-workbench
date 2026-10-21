"""Research membership narrows data scope; it never grants operation privileges."""
from copy import deepcopy


def department(formula):
    return formula.get('department') or ('研发五部' if not formula.get('source_kind') else None)


class ResearchAccess:
    def __init__(self, db, actor=None):
        # Internal calculation/backup callers do not project confidential graphs to HTTP.
        self.admin, self.level, self.departments = actor is None, 0, {}
        if actor is None:
            return
        row = db.execute("SELECT u.access_level,s.access_level FROM identity_users u LEFT JOIN identity_user_scopes s ON s.user_id=u.id AND s.scope_id='research' WHERE u.id=%s AND u.is_active=1", (actor['id'] if isinstance(actor,dict) else actor,)).fetchone()
        self.admin, self.level = bool(row and row[0] == 5), (row[1] or 0) if row else 0
        self.departments = {ident: {'name':name,'primary':bool(primary)} for ident,name,primary in db.execute("""
            SELECT d.id,d.name,m.is_primary FROM organization_memberships m JOIN organization_departments d ON d.id=m.department_id
            WHERE m.user_id=%s AND d.parent_id IS NULL AND (d.name LIKE '研发%%' OR d.name='浙江实验室')
        """, (actor['id'] if isinstance(actor,dict) else actor,))}

    def allows(self, formula):
        if self.admin:
            return True
        if self.level < 2:
            return False
        ident = formula.get('department_id')
        return ident in self.departments if ident else department(formula) in {v['name'] for v in self.departments.values()}

    def require(self, formula):
        if not self.allows(formula):
            raise KeyError('产品不存在')

    def allows_account(self, user):
        return self.admin or bool(set(self.departments) & {d['id'] for d in user.get('departments', [])})

    def creation_department(self, db, ident=None):
        if self.admin:
            if ident is None:
                from api.organization import legacy_department
                ident = legacy_department(db,'研发五部')
            row = db.execute("SELECT id,name FROM organization_departments WHERE parent_id IS NULL AND (%s::text IS NULL AND name='研发五部' OR id=%s)",(ident,ident)).fetchone()
            if not row or not (row[1].startswith('研发') or row[1]=='浙江实验室'):
                raise ValueError('请选择有效研发部门')
            return row
        if self.level < 3 or not self.departments:
            raise PermissionError('没有可创建产品的研发部门')
        if ident is None:
            ident = next((key for key,value in self.departments.items() if value['primary']),None)
            if ident is None and len(self.departments)==1:
                ident = next(iter(self.departments))
        if ident not in self.departments:
            raise PermissionError('请选择获准的研发部门')
        return ident,self.departments[ident]['name']

    def project(self, value, visible):
        if self.admin:
            return value
        return self._project(deepcopy(value),visible)

    def _project(self, value, visible):
        if isinstance(value,list):
            return [self._project(item,visible) for item in value]
        if not isinstance(value,dict):
            return value
        if 'affected' in value:
            value['affected'] = [r for r in value['affected'] if r['id'] in visible]
        if value.get('blocking'):
            value['blocking'] = ['引用链存在缺价，请核对本部门投料或联系相关部门']
        if 'referenced_by' in value:
            hidden = sum(r['id'] not in visible for r in value['referenced_by'])
            value['referenced_by'] = [r for r in value['referenced_by'] if r['id'] in visible] + ([{'id':'restricted','name':f'其他部门产品（{hidden}项）'}] if hidden else [])
        for key in ('graph','recipes'):
            if key in value:
                value[key] = [r for r in value[key] if r['id'] in visible]
        if 'calculations' in value:
            value['calculations'] = {p:{k:self._project(v,visible) for k,v in rows.items() if k in visible} for p,rows in value['calculations'].items()}
        for key in ('latest','inventory','current_latest','current_inventory','simulation','product'):
            if isinstance(value.get(key),dict):
                value[key] = self._project(value[key],visible)
        if isinstance(value.get('lines'),list):
            for line in value['lines']:
                if line.get('kind') in {'recipe','composite'} and line['ref'] not in visible:
                    line['restricted_reference'] = True
                    if line.get('missing_materials'):
                        line['missing_materials'] = [line['code']]
                    if line.get('price_review_pending'):
                        line['price_review_pending'] = [line['code']]
            if 'missing_materials' in value and all('missing_materials' in line for line in value['lines']):
                value['missing_materials'] = sorted({code for line in value['lines'] for code in line.get('missing_materials',[])})
            if 'price_review_pending' in value:
                value['price_review_pending'] = sorted({code for line in value['lines'] for code in line.get('price_review_pending',[])})
        if 'history' in value:
            value['history'] = self._project(value['history'],visible)
        for key in ('formula','draft'):
            if isinstance(value.get(key),dict):
                value[key] = self._project(value[key],visible)
        if value.get('latest') and value.get('inventory') and 'missing_materials' in value:
            value['missing_materials'] = sorted(set(value['latest'].get('missing_materials',[])+value['inventory'].get('missing_materials',[])))
        return value

    def visible_ids(self, db):
        if self.admin:
            return {row[0] for row in db.execute('SELECT id FROM research_formulas')}
        if self.level < 2:
            return set()
        return {row[0] for row in db.execute("""SELECT id FROM research_formulas WHERE
            formula::jsonb->>'department_id'=ANY(%s) OR
            (COALESCE(formula::jsonb->>'department_id','')='' AND
             COALESCE(NULLIF(formula::jsonb->>'department',''),CASE WHEN COALESCE(formula::jsonb->>'source_kind','')='' THEN '研发五部' END)=ANY(%s))""",
            (list(self.departments),[value['name'] for value in self.departments.values()]))}
