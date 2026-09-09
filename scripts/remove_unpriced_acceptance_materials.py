"""One-time, guarded removal of the 322 unused acceptance materials."""
import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path('C:/Users/gnedhy/AppData/Local/HonghaoAI/procurement-acceptance-20260909')
DB = ROOT / 'honghao.db'
QUERY = """SELECT id,code FROM procurement_materials m WHERE archived_at IS NULL
AND NOT EXISTS(SELECT 1 FROM procurement_price_batch_items b WHERE b.material_id=m.id AND b.latest_price IS NOT NULL)
AND NOT EXISTS(SELECT 1 FROM procurement_snapshot_sources s WHERE s.material_id=m.id AND s.price_kind!='missing') ORDER BY code"""

def digest(db, table):
    rows = db.execute(f'SELECT * FROM {table} ORDER BY rowid').fetchall()
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    run = 'remove-unpriced-' + now.strftime('%Y%m%dT%H%M%SZ')
    with sqlite3.connect(DB) as db:
        db.execute('BEGIN IMMEDIATE')
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        rows = db.execute(QUERY).fetchall()
        assert len(rows) == 322, f'Unexpected target count: {len(rows)}'
        assert db.execute('SELECT count(*) FROM procurement_materials WHERE archived_at IS NULL').fetchone()[0] == 460
        ids = [row[0] for row in rows]
        placeholders = ','.join('?' for _ in ids)
        for table in ('procurement_update_items', 'procurement_saved_changes', 'procurement_price_history', 'procurement_material_identity_changes'):
            assert db.execute(f'SELECT count(*) FROM {table} WHERE material_id IN ({placeholders})', ids).fetchone()[0] == 0, table
        protected = ('procurement_price_batches', 'procurement_price_batch_items', 'procurement_snapshot_sources', 'procurement_updates', 'procurement_saved_changes')
        before = {table: digest(db, table) for table in protected}
        links = db.execute(f'SELECT department_id,material_id FROM procurement_department_materials WHERE material_id IN ({placeholders})', ids).fetchall()
        assert len(links) == 353
        if not args.apply:
            print(json.dumps({'targets': len(rows), 'department_links': len(links), 'apply': False}))
            return
        backup_dir = ROOT / 'backups' / run
        backup_dir.mkdir(parents=True, exist_ok=False)
        backup = backup_dir / 'honghao-before.db'
        # A separate reader can back up while this connection holds the write reservation.
        with sqlite3.connect(f'file:{DB.as_posix()}?mode=ro', uri=True) as reader, sqlite3.connect(backup) as target:
            reader.backup(target)
            assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        actor = 'local-maintenance:codex'
        db.executemany('UPDATE procurement_materials SET archived_at=?, archived_by=? WHERE id=? AND archived_at IS NULL', [(now.isoformat(), actor, id_) for id_ in ids])
        db.execute(f'DELETE FROM procurement_department_materials WHERE material_id IN ({placeholders})', ids)
        detail = {'authorization': 'User requested removal of 322 unpriced unused materials', 'materials': rows, 'removed_department_links': links, 'backup': str(backup), 'mode': 'recoverable_archive'}
        db.execute('INSERT INTO procurement_admin_events(id,actor_id,action,target_id,detail,created_at) VALUES(?,?,?,?,?,?)', (run, actor, 'unused_materials_removed', '322-unpriced-materials', json.dumps(detail, ensure_ascii=False), now.isoformat()))
        assert db.execute('SELECT count(*) FROM procurement_materials WHERE archived_at IS NULL').fetchone()[0] == 138
        assert before == {table: digest(db, table) for table in protected}
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        (backup_dir / 'removal-manifest.json').write_text(json.dumps(detail, ensure_ascii=False, indent=2), encoding='utf-8')
        db.commit()
        print(json.dumps({'removed': 322, 'remaining': 138, 'removed_department_links': 353, 'backup': str(backup), 'historical_snapshots_unchanged': True}))

if __name__ == '__main__':
    main()
