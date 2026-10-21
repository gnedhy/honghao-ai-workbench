"""Explicit, hash-pinned ERP stock normalization; source prices remain in the audit trail."""
import hashlib
import json
from decimal import Decimal

from api.postgres import transaction
from api.procurement_collaboration import admin_event
from api.research import enqueue, now, packed


def normalize(url, actor, *, expected_sha256=None):
    with transaction(url, write=expected_sha256 is not None) as db:
        if db.execute('SELECT access_level,is_active FROM identity_users WHERE id=%s', (actor,)).fetchone() != (5, 1):
            raise PermissionError('库存口径调整仅限有效系统管理员')
        rows = db.execute("""SELECT i.material_id,m.code,i.price,i.quantity,i.source_sha256,
            i.source_row,s.source_row,s.raw_json FROM procurement_inventory i
            JOIN procurement_materials m ON m.id=i.material_id
            LEFT JOIN LATERAL (SELECT source_row,raw_json FROM procurement_material_sources
                WHERE material_id=i.material_id AND sha256=i.source_sha256 AND sheet=i.sheet
                ORDER BY source_row DESC LIMIT 1) s ON TRUE
            WHERE i.sheet='ERP库存汇总' AND i.price IS NOT NULL ORDER BY i.material_id""").fetchall()
        changes = []
        skipped = 0
        for mid,code,price,qty,sha,stock_row,source_row,raw in rows:
            values = json.loads(raw) if raw else []
            provenance = values[-1] if values and isinstance(values[-1],dict) else {}
            if provenance.get('source') != 'ERP 库存':
                raise ValueError(f'{code} 缺少ERP库存来源，拒绝换算')
            tax = provenance.get('tax_normalization')
            if tax:
                if tax['rate'] != '0.13' or Decimal(price) != Decimal(tax['exclusive_price']) * Decimal('1.13'):
                    raise ValueError(f'{code} 已换算记录与当前价格不符，请重新核对来源')
                skipped += 1
                continue
            inclusive = format(Decimal(price) * Decimal('1.13'), 'f')
            changes.append(dict(material_id=mid,code=code,exclusive_price=price,inclusive_price=inclusive,
                                quantity=qty,sha256=sha,stock_row=stock_row,source_row=source_row,provenance=provenance))
        digest = hashlib.sha256(packed(changes).encode()).hexdigest()
        result = dict(sha256=digest,matched=len(changes),already_normalized=skipped,rows=changes)
        if expected_sha256 is None:
            return result
        if expected_sha256 != digest:
            raise ValueError('库存数据已变化，请重新预检')
        stamp = now()
        for row in changes:
            provenance = dict(row['provenance'],tax_normalization={
                'rate':'0.13','exclusive_price':row['exclusive_price'],'inclusive_price':row['inclusive_price'],
                'original_stock_row':row['stock_row'],'actor':actor,'recorded_at':stamp})
            source_row = row['source_row'] + 1
            db.execute('INSERT INTO procurement_material_sources(material_id,sheet,source_row,raw_json,sha256) VALUES(%s,%s,%s,%s,%s)',
                       (row['material_id'],'ERP库存汇总',source_row,packed(['',row['code'],provenance]),row['sha256']))
            db.execute('UPDATE procurement_inventory SET price=%s,source_row=%s,imported_by=%s,imported_at=%s WHERE material_id=%s',
                       (row['inclusive_price'],source_row,actor,stamp,row['material_id']))
        if changes:
            admin_event(db,actor,'inventory.tax_normalized',digest,{'rate':'0.13','matched':len(changes),'source':'ERP 库存'})
            enqueue(db,'ERP库存价格统一含13%税')
        return result
