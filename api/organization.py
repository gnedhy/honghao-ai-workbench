"""Organization membership is descriptive; it never grants business access."""
import psycopg
from api.postgres import transaction
from uuid import uuid4

from api.authorization import AuthorizationStore




def legacy_department(db, name):
    name = name.strip()
    row = db.execute("SELECT id FROM organization_departments WHERE parent_id IS NULL AND translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate(%s,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')", (name,)).fetchone()
    if row:
        return row[0]
    department_id = str(uuid4())
    db.execute("INSERT INTO organization_departments (id,name,parent_id) VALUES (%s,%s,NULL)", (department_id, name))
    return department_id


def require_admin(db, actor):
    if not db.execute("SELECT 1 FROM identity_users WHERE id=%s AND is_active=1 AND access_level=5", (actor,)).fetchone():
        raise PermissionError('仅系统管理员可以调整部门')


def assign(db, user_id, primary, extras):
    ids = ([primary] if primary else []) + extras
    if (extras and not primary) or len(set(ids)) != len(ids):
        raise ValueError('请选择唯一主部门，兼属部门不能重复或包含主部门')
    for department_id in ids:
        if not db.execute("SELECT 1 FROM organization_departments WHERE id=%s", (department_id,)).fetchone():
            raise ValueError('部门已不存在，请重新选择')
    db.execute('DELETE FROM organization_memberships WHERE user_id=%s', (user_id,))
    db.cursor().executemany('INSERT INTO organization_memberships (user_id,department_id,is_primary) VALUES (%s,%s,%s)', [(user_id, d, int(d == primary)) for d in ids])
    db.execute('UPDATE identity_users SET department=(SELECT name FROM organization_departments WHERE id=%s) WHERE id=%s', (primary, user_id))


class OrganizationStore:
    def __init__(self, url):
        self.url = url

    def list_departments(self):
        with transaction(self.url) as db:
            return [dict(zip(('id', 'name', 'parent_id'), row)) for row in db.execute('SELECT id,name,parent_id FROM organization_departments ORDER BY _order')]

    def save(self, actor, name, parent_id, department_id=None):
        name = name.strip()
        if not 1 <= len(name) <= 100:
            raise ValueError('部门名称须为1至100个字符')
        with transaction(self.url, write=True) as db:

            require_admin(db, actor)
            if department_id and not db.execute('SELECT 1 FROM organization_departments WHERE id=%s', (department_id,)).fetchone():
                raise ValueError('部门已不存在，请刷新')
            cursor, seen = parent_id, set()
            while cursor:
                if cursor == department_id or cursor in seen:
                    raise ValueError('不能将部门移动到自身或下级部门')
                seen.add(cursor)
                row = db.execute('SELECT parent_id FROM organization_departments WHERE id=%s', (cursor,)).fetchone()
                if row is None:
                    raise ValueError('上级部门不存在')
                cursor = row[0]
            created = department_id is None
            department_id = department_id or str(uuid4())
            try:
                if created:
                    db.execute('INSERT INTO organization_departments (id,name,parent_id) VALUES (%s,%s,%s)', (department_id, name, parent_id))
                else:
                    db.execute('UPDATE organization_departments SET name=%s,parent_id=%s WHERE id=%s', (name, parent_id, department_id))
                    db.execute('UPDATE identity_users SET department=%s WHERE id IN (SELECT user_id FROM organization_memberships WHERE department_id=%s AND is_primary=1)', (name, department_id))
            except psycopg.IntegrityError as error:
                raise ValueError('同一上级下已存在同名部门') from error
            AuthorizationStore(self.url).audit('department.created' if created else 'department.updated', actor_user_id=actor, target_type='department', target_id=department_id, connection=db)
        return {'id': department_id, 'name': name, 'parent_id': parent_id}

    def delete(self, actor, department_id):
        with transaction(self.url, write=True) as db:

            require_admin(db, actor)
            if db.execute('SELECT 1 FROM organization_departments WHERE parent_id=%s', (department_id,)).fetchone() or db.execute('SELECT 1 FROM organization_memberships WHERE department_id=%s', (department_id,)).fetchone():
                raise ValueError('请先调整该部门的人员及子部门，再删除')
            if not db.execute('DELETE FROM organization_departments WHERE id=%s', (department_id,)).rowcount:
                raise ValueError('部门已不存在，请刷新')
            AuthorizationStore(self.url).audit('department.deleted', actor_user_id=actor, target_type='department', target_id=department_id, connection=db)
