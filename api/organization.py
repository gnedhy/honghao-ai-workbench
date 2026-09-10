"""Organization membership is descriptive; it never grants business access."""
import sqlite3
from uuid import uuid4

from api.authorization import AuthorizationStore


def initialize(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS organization_departments (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES organization_departments(id));
        CREATE UNIQUE INDEX IF NOT EXISTS organization_sibling_name
            ON organization_departments(COALESCE(parent_id, ''), name COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS organization_memberships (
            user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
            department_id TEXT NOT NULL REFERENCES organization_departments(id),
            is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)),
            PRIMARY KEY(user_id,department_id));
        CREATE UNIQUE INDEX IF NOT EXISTS organization_one_primary
            ON organization_memberships(user_id) WHERE is_primary=1;
    """)
    if not db.execute("SELECT 1 FROM schema_metadata WHERE key='organization_schema_version'").fetchone():
        for user_id, name in db.execute("SELECT id,department FROM identity_users ORDER BY rowid").fetchall():
            if name and name.strip():
                department_id = legacy_department(db, name)
                assign(db, user_id, department_id, [])
        db.execute("INSERT INTO schema_metadata VALUES ('organization_schema_version',1)")


def legacy_department(db, name):
    name = name.strip()
    row = db.execute("SELECT id FROM organization_departments WHERE parent_id IS NULL AND name=? COLLATE NOCASE", (name,)).fetchone()
    if row:
        return row[0]
    department_id = str(uuid4())
    db.execute("INSERT INTO organization_departments VALUES (?,?,NULL)", (department_id, name))
    return department_id


def require_admin(db, actor):
    if not db.execute("SELECT 1 FROM identity_users WHERE id=? AND is_active=1 AND access_level=5", (actor,)).fetchone():
        raise PermissionError('仅系统管理员可以调整部门')


def assign(db, user_id, primary, extras):
    ids = ([primary] if primary else []) + extras
    if (extras and not primary) or len(set(ids)) != len(ids):
        raise ValueError('请选择唯一主部门，兼属部门不能重复或包含主部门')
    for department_id in ids:
        if not db.execute("SELECT 1 FROM organization_departments WHERE id=?", (department_id,)).fetchone():
            raise ValueError('部门已不存在，请重新选择')
    db.execute('DELETE FROM organization_memberships WHERE user_id=?', (user_id,))
    db.executemany('INSERT INTO organization_memberships VALUES (?,?,?)', [(user_id, d, int(d == primary)) for d in ids])
    db.execute('UPDATE identity_users SET department=(SELECT name FROM organization_departments WHERE id=?) WHERE id=?', (primary, user_id))


class OrganizationStore:
    def __init__(self, path):
        self.path = path

    def list_departments(self):
        with sqlite3.connect(self.path) as db:
            return [dict(zip(('id', 'name', 'parent_id'), row)) for row in db.execute('SELECT id,name,parent_id FROM organization_departments ORDER BY rowid')]

    def save(self, actor, name, parent_id, department_id=None):
        name = name.strip()
        if not 1 <= len(name) <= 100:
            raise ValueError('部门名称须为1至100个字符')
        with sqlite3.connect(self.path) as db:
            db.execute('BEGIN IMMEDIATE')
            require_admin(db, actor)
            if department_id and not db.execute('SELECT 1 FROM organization_departments WHERE id=?', (department_id,)).fetchone():
                raise ValueError('部门已不存在，请刷新')
            cursor, seen = parent_id, set()
            while cursor:
                if cursor == department_id or cursor in seen:
                    raise ValueError('不能将部门移动到自身或下级部门')
                seen.add(cursor)
                row = db.execute('SELECT parent_id FROM organization_departments WHERE id=?', (cursor,)).fetchone()
                if row is None:
                    raise ValueError('上级部门不存在')
                cursor = row[0]
            created = department_id is None
            department_id = department_id or str(uuid4())
            try:
                if created:
                    db.execute('INSERT INTO organization_departments VALUES (?,?,?)', (department_id, name, parent_id))
                else:
                    db.execute('UPDATE organization_departments SET name=?,parent_id=? WHERE id=?', (name, parent_id, department_id))
                    db.execute('UPDATE identity_users SET department=? WHERE id IN (SELECT user_id FROM organization_memberships WHERE department_id=? AND is_primary=1)', (name, department_id))
            except sqlite3.IntegrityError as error:
                raise ValueError('同一上级下已存在同名部门') from error
            AuthorizationStore(self.path).audit('department.created' if created else 'department.updated', actor_user_id=actor, target_type='department', target_id=department_id, connection=db)
        return {'id': department_id, 'name': name, 'parent_id': parent_id}

    def delete(self, actor, department_id):
        with sqlite3.connect(self.path) as db:
            db.execute('BEGIN IMMEDIATE')
            require_admin(db, actor)
            if db.execute('SELECT 1 FROM organization_departments WHERE parent_id=?', (department_id,)).fetchone() or db.execute('SELECT 1 FROM organization_memberships WHERE department_id=?', (department_id,)).fetchone():
                raise ValueError('请先调整该部门的人员及子部门，再删除')
            if not db.execute('DELETE FROM organization_departments WHERE id=?', (department_id,)).rowcount:
                raise ValueError('部门已不存在，请刷新')
            AuthorizationStore(self.path).audit('department.deleted', actor_user_id=actor, target_type='department', target_id=department_id, connection=db)
