"""Shared procurement attribution, distribution and narrowly scoped activation grants."""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from api.authorization import AuthorizationStore
from api.identity import IdentityStore


def initialize(db: sqlite3.Connection) -> None:
    db.executescript("""
        CREATE TABLE procurement_departments (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, position INTEGER NOT NULL);
        CREATE TABLE procurement_department_materials (
            department_id TEXT NOT NULL, material_id TEXT NOT NULL,
            PRIMARY KEY(department_id, material_id));
        CREATE TABLE procurement_activation_grants (
            user_id TEXT PRIMARY KEY, manager INTEGER NOT NULL DEFAULT 0,
            granted_by TEXT NOT NULL, granted_at TEXT NOT NULL);
        CREATE TABLE procurement_admin_events (
            id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
            target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE procurement_saved_changes (
            event_id TEXT NOT NULL, update_id TEXT NOT NULL, material_id TEXT NOT NULL,
            actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, before_price TEXT, after_price TEXT,
            price_date TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(event_id, material_id));
        CREATE TABLE procurement_source_imports (
            sha256 TEXT PRIMARY KEY, filename TEXT NOT NULL, stored_path TEXT NOT NULL,
            imported_by TEXT NOT NULL, imported_at TEXT NOT NULL);
        CREATE TABLE procurement_material_sources (
            material_id TEXT NOT NULL, sheet TEXT NOT NULL, source_row INTEGER NOT NULL,
            raw_json TEXT NOT NULL, sha256 TEXT NOT NULL,
            PRIMARY KEY(material_id, sheet, source_row, sha256));
        CREATE TABLE procurement_batch_provenance (
            batch_id TEXT PRIMARY KEY, origin TEXT NOT NULL, sha256 TEXT,
            imported_at TEXT, imported_by TEXT, reported_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE procurement_snapshot_sources (
            batch_id TEXT NOT NULL, material_id TEXT NOT NULL, price_date TEXT,
            raw_price TEXT, price_kind TEXT NOT NULL, sheet TEXT, cell TEXT, sha256 TEXT,
            PRIMARY KEY(batch_id, material_id));
    """)


def capabilities(path: Path, user: dict) -> dict:
    admin = user.get("is_system_admin", False)
    write = bool(user.get("is_active", True)) and AuthorizationStore(path).can_write_field("procurement.material_unit_price", admin, user["scope_levels"])
    with sqlite3.connect(path) as db:
        initialized = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='procurement_activation_grants'").fetchone()
        grant = db.execute("SELECT manager FROM procurement_activation_grants WHERE user_id=?", (user["id"],)).fetchone() if initialized else None
    manager = bool(write and (admin or grant and grant[0]))
    catalog_manager = bool(write and (admin or user["scope_levels"].get("procurement", 0) >= 4))
    return {"can_edit": bool(write), "can_activate": bool(write and (catalog_manager or grant)),
            "can_manage_grants": manager, "can_cancel_round": manager,
            "can_manage_catalog": catalog_manager}


def can_activate(path: Path, user_id: str) -> bool:
    user = IdentityStore(path).get_user(user_id)
    return bool(user and user["is_active"] and capabilities(path, user)["can_activate"])


def require_current(path: Path, user_id: str, capability: str) -> None:
    # Called after BEGIN IMMEDIATE: grants and account changes cannot race this write.
    user = IdentityStore(path).get_user(user_id)
    if not user or not user["is_active"] or not capabilities(path, user)[capability]:
        raise ValueError("账号权限已变化，请刷新后重试")


def pause_schedules(db, user_id: str):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE name='procurement_updates'").fetchone():
        return
    now = datetime.now(UTC).isoformat()
    rows = db.execute("""SELECT id FROM procurement_updates u WHERE status='scheduled' AND
        (SELECT actor_user_id FROM procurement_update_events e WHERE e.update_id=u.id AND event='scheduled'
         ORDER BY created_at DESC,rowid DESC LIMIT 1)=?""", (user_id,)).fetchall()
    for (id_,) in rows:
        db.execute("UPDATE procurement_updates SET status='revalidation_required',updated_at=? WHERE id=?", (now,id_))
        db.execute("INSERT INTO procurement_update_events VALUES (?,?,?,?,?,?)", (str(uuid4()),id_,"revalidation_required",None,"启用账号权限发生变化",now))


def admin_event(db, actor_id, action, target_id, detail):
    db.execute("INSERT INTO procurement_admin_events VALUES (?,?,?,?,?,?)",
               (str(uuid4()), actor_id, action, target_id, json.dumps(detail, ensure_ascii=False), datetime.now(UTC).isoformat()))


def grants(path: Path) -> dict:
    with sqlite3.connect(path) as db:
        assigned = {r[0]: r[1:] for r in db.execute("SELECT user_id,manager,granted_by,granted_at FROM procurement_activation_grants")}
        events = db.execute("SELECT e.action,e.target_id,e.detail,e.created_at,u.display_name,e.id FROM procurement_admin_events e LEFT JOIN identity_users u ON u.id=e.actor_id WHERE action LIKE 'grant.%' ORDER BY e.created_at DESC LIMIT 50").fetchall()
    users = []
    for user in IdentityStore(path).list_users():
        cap = capabilities(path, user)
        if not user["is_system_admin"] and (user["scope_levels"].get("procurement", 0) >= 2 or user["id"] in assigned):
            grant = assigned.get(user["id"])
            users.append({"id": user["id"], "name": user["display_name"], "active": user["is_active"],
                          "eligible": cap["can_edit"], "granted": bool(grant), "manager": bool(grant and grant[0]),
                          "role_granted": bool(user["is_active"] and user["scope_levels"].get("procurement", 0) >= 4),
                          "granted_by": grant[1] if grant else None, "granted_at": grant[2] if grant else None})
    return {"users": users, "events": [{"id": r[5], "action": r[0], "target_id": r[1], "detail": json.loads(r[2]), "created_at": r[3], "actor": r[4]} for r in events]}


def set_grant(path: Path, actor: dict, target_id: str, enabled: bool, manager: bool | None = None) -> None:
    if not capabilities(path, actor)["can_manage_grants"]:
        raise PermissionError("无启用授权管理权限")
    if manager is not None and not actor["is_system_admin"]:
        raise PermissionError("只有管理员可设置授权管理人员")
    target = IdentityStore(path).get_user(target_id)
    if not target or target["is_system_admin"]:
        raise ValueError("请选择普通采购账号，管理员权限不在此处调整")
    if enabled and not capabilities(path, target)["can_edit"]:
        raise ValueError("账号须已启用并具备采购编辑权限")
    with sqlite3.connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        require_current(path, actor["id"], "can_manage_grants")
        actor = IdentityStore(path).get_user(actor["id"])
        if manager is not None and not actor["is_system_admin"]:
            raise PermissionError("只有管理员可设置授权管理人员")
        if enabled:
            require_current(path, target_id, "can_edit")
        old = db.execute("SELECT manager FROM procurement_activation_grants WHERE user_id=?", (target_id,)).fetchone()
        if old and old[0] and not actor["is_system_admin"]:
            raise PermissionError("只有管理员可调整授权管理人员")
        if enabled:
            db.execute("INSERT INTO procurement_activation_grants VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET manager=excluded.manager,granted_by=excluded.granted_by,granted_at=excluded.granted_at",
                       (target_id, int(manager if manager is not None else bool(old and old[0])), actor["id"], datetime.now(UTC).isoformat()))
        else:
            db.execute("DELETE FROM procurement_activation_grants WHERE user_id=?", (target_id,))
            target = IdentityStore(path).get_user(target_id)
            if not (target and target["is_active"] and target["scope_levels"].get("procurement", 0) >= 4):
                pause_schedules(db, target_id)
        admin_event(db, actor["id"], "grant.enabled" if enabled else "grant.revoked", target_id, {"name": target["display_name"], "manager": manager})


def record_changes(db, event_id, update_id, actor_id, price_date, items):
    actor = db.execute("SELECT display_name FROM identity_users WHERE id=?", (actor_id,)).fetchone()
    now = datetime.now(UTC).isoformat()
    for material_id, before, after in items:
        db.execute("INSERT INTO procurement_saved_changes VALUES (?,?,?,?,?,?,?,?,?)",
                   (event_id, update_id, material_id, actor_id, actor[0] if actor else actor_id, before, after, price_date, now))


def participants(path: Path, update_id: str | None = None) -> dict:
    with sqlite3.connect(path) as db:
        rows = db.execute("SELECT DISTINCT material_id,actor_id,actor_name FROM procurement_saved_changes" +
                          (" WHERE update_id=?" if update_id is not None else ""), (update_id,) if update_id is not None else ()).fetchall()
    result = {}
    for material, actor, name in rows:
        result.setdefault(material, []).append({"id": actor, "name": name})
    return result


def price_authorship(path: Path, material_id: str | None = None) -> dict:
    """Trace names by explicit work-batch and source-file links, never matching dates."""
    with sqlite3.connect(path) as db:
        batches = db.execute("SELECT id,update_id FROM procurement_price_batches ORDER BY version").fetchall()
        sources = db.execute("SELECT batch_id,material_id,sheet,sha256 FROM procurement_snapshot_sources WHERE (? IS NULL OR material_id=?)", (material_id, material_id)).fetchall()
        originals = db.execute("SELECT material_id,sheet,sha256,raw_json FROM procurement_material_sources WHERE (? IS NULL OR material_id=?)", (material_id, material_id)).fetchall()
        changes = db.execute("""SELECT c.update_id,c.material_id,c.actor_id,c.actor_name,u.status
            FROM procurement_saved_changes c JOIN procurement_updates u ON u.id=c.update_id
            WHERE (? IS NULL OR c.material_id=?) ORDER BY c.created_at,c.rowid""", (material_id, material_id)).fetchall()
        touched = db.execute("""SELECT DISTINCT i.update_id,h.material_id FROM procurement_price_history h
            JOIN procurement_imports i ON i.id=h.import_id WHERE i.update_id IS NOT NULL
            AND (? IS NULL OR h.material_id=?)""", (material_id, material_id)).fetchall()
    source_names, purchasers = {}, {}
    for material, sheet, digest, raw in originals:
        values = json.loads(raw)
        name = str(values[0]).strip() if values and values[0] is not None else ""
        if name:
            source_names.setdefault((material, sheet, digest), set()).add(name)
            purchasers.setdefault(material, set()).add(name)
    by_update, by_source, touched_by_update = {}, {}, {}
    for update, material, actor, name, status in changes:
        if status != "cancelled":
            by_update.setdefault(update, {})[material] = {"kind": "system", "name": name, "id": actor}
    for update, material in touched:
        touched_by_update.setdefault(update, set()).add(material)
    for batch, material, sheet, digest in sources:
        if digest:
            names = source_names.get((material, sheet, digest), set())
            by_source.setdefault(batch, {})[material] = {"kind": "source", "name": "、".join(sorted(names)), "id": None} if names else {"kind": "unknown", "name": "", "id": None}
    snapshots, inherited = {}, {}
    for batch, update in batches:
        # Published snapshots explicitly inherit the preceding official baseline.
        inherited = dict(inherited)
        for material in touched_by_update.get(update, set()):
            inherited[material] = {"kind": "unknown", "name": "", "id": None}
        inherited.update(by_source.get(batch, {}))
        inherited.update(by_update.get(update, {}))
        snapshots[batch] = inherited
    return {"batches": snapshots, "updates": by_update, "purchasers": {key: sorted(value) for key, value in purchasers.items()}}


def saved_events(path: Path, *, update_id: str | None = None, material_id: str | None = None) -> list:
    with sqlite3.connect(path) as db:
        rows = db.execute("""SELECT c.event_id,e.event,e.reason,c.created_at,c.actor_name,c.material_id,m.code,m.name,m.unit,
            c.before_price,c.after_price,c.price_date,u.status,c.actor_id FROM procurement_saved_changes c
            JOIN procurement_update_events e ON e.id=c.event_id JOIN procurement_materials m ON m.id=c.material_id
            JOIN procurement_updates u ON u.id=c.update_id
            WHERE (? IS NULL OR c.update_id=?) AND (? IS NULL OR c.material_id=?) ORDER BY c.created_at DESC,c.rowid""",
            (update_id, update_id, material_id, material_id)).fetchall()
    events = {}
    for r in rows:
        event = events.setdefault(r[0], {"id": r[0], "event": r[1], "reason": r[2], "created_at": r[3], "actor": r[4], "actor_id": r[13], "status": r[12], "items": []})
        before, after = r[9], r[10]
        event["items"].append({"id": r[5], "code": r[6], "name": r[7], "unit": r[8], "before": before, "after": after,
            "before_recorded": before is not None, "before_basis": "saved", "price_date": r[11],
            "change": (float(after)-float(before))/abs(float(before)) if before is not None and after is not None and float(before) else None})
    return list(events.values())


def snapshot_sources(path: Path, batch_id: str | None) -> dict:
    with sqlite3.connect(path) as db:
        rows = db.execute("SELECT material_id,price_date,raw_price,price_kind,sheet,cell,sha256 FROM procurement_snapshot_sources WHERE batch_id=?", (batch_id,)).fetchall()
    return {r[0]: {"price_date": r[1], "raw_price": r[2], "price_kind": r[3], "sheet": r[4], "cell": r[5], "sha256": r[6]} for r in rows}


def provenance(path: Path, batch_id: str) -> dict | None:
    with sqlite3.connect(path) as db:
        row = db.execute("SELECT p.origin,p.imported_at,p.reported_count,s.filename,u.display_name FROM procurement_batch_provenance p LEFT JOIN procurement_source_imports s ON s.sha256=p.sha256 LEFT JOIN identity_users u ON u.id=p.imported_by WHERE p.batch_id=?", (batch_id,)).fetchone()
    return {"origin": row[0], "imported_at": row[1], "reported_count": row[2], "filename": row[3], "imported_by": row[4]} if row else None


def freeze_sources(db, batch_id, update_id, previous_id):
    # Snapshot keys include frozen work-batch IDs, so revalidation retains price provenance.
    if db.execute("SELECT 1 FROM procurement_snapshot_sources WHERE batch_id=?", (update_id,)).fetchone():
        previous_id = update_id
    if batch_id != previous_id:
        db.execute("INSERT INTO procurement_snapshot_sources SELECT ?,material_id,price_date,raw_price,price_kind,sheet,cell,sha256 FROM procurement_snapshot_sources WHERE batch_id=?", (batch_id, previous_id))
    rows = db.execute("SELECT material_id,price_date,after_price FROM procurement_saved_changes WHERE update_id=? ORDER BY created_at,rowid", (update_id,)).fetchall()
    for material, day, value in rows:
        db.execute("INSERT INTO procurement_snapshot_sources VALUES (?,?,?,?,?,NULL,NULL,NULL) ON CONFLICT(batch_id,material_id) DO UPDATE SET price_date=excluded.price_date,raw_price=excluded.raw_price,price_kind=excluded.price_kind,sheet=NULL,cell=NULL,sha256=NULL",
                   (batch_id, material, day, value, "number" if value is not None else "missing"))


def departments(path: Path, overview: dict) -> list:
    prices = {m["id"]: m.get("published_price") for m in overview["materials"]}
    with sqlite3.connect(path) as db:
        groups = db.execute("SELECT id,name FROM procurement_departments ORDER BY position").fetchall()
        links = db.execute("SELECT department_id,material_id FROM procurement_department_materials").fetchall()
    return [{"id": id_, "name": name, "material_ids": [m for g,m in links if g==id_],
             "priced": sum(prices.get(m) is not None for g,m in links if g==id_)} for id_,name in groups]


def set_department(path: Path, department_id: str, material_ids: list[str], actor_id: str):
    with sqlite3.connect(path) as db:
        db.execute("BEGIN IMMEDIATE")
        require_current(path, actor_id, "can_manage_catalog")
        if not db.execute("SELECT 1 FROM procurement_departments WHERE id=?", (department_id,)).fetchone():
            raise ValueError("部门不存在")
        known = {r[0] for r in db.execute("SELECT id FROM procurement_materials WHERE archived_at IS NULL")}
        if len(set(material_ids)) != len(material_ids) or not set(material_ids) <= known:
            raise ValueError("原料编号重复或不存在")
        previous = {r[0] for r in db.execute("SELECT material_id FROM procurement_department_materials WHERE department_id=?", (department_id,))}
        db.execute("DELETE FROM procurement_department_materials WHERE department_id=?", (department_id,))
        db.executemany("INSERT INTO procurement_department_materials VALUES (?,?)", [(department_id,m) for m in material_ids])
        admin_event(db, actor_id, "department.changed", department_id, {"added": sorted(set(material_ids)-previous), "removed": sorted(previous-set(material_ids))})
