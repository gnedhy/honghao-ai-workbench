"""One confirmed correction: DM064 tax-inclusive inventory price is 7.40 yuan/kg."""
import json
from api.postgres import transaction
from api.research import now,packed,enqueue
from api.procurement_collaboration import admin_event


def correct(url,actor):
    with transaction(url,write=True) as db:
        if db.execute('SELECT access_level,is_active FROM identity_users WHERE id=%s',(actor,)).fetchone()!=(5,1):
            raise PermissionError('仅限有效系统管理员')
        rows=db.execute("SELECT i.material_id,i.price,i.quantity,i.source_sha256,i.source_row FROM procurement_inventory i JOIN procurement_materials m ON m.id=i.material_id WHERE m.code='DM064'").fetchall()
        if len(rows)!=1:raise ValueError('DM064 原料匹配不唯一')
        mid,price,qty,sha,source_row=rows[0]
        source=db.execute("SELECT source_row,raw_json FROM procurement_material_sources WHERE material_id=%s AND sha256=%s AND sheet='ERP库存汇总' ORDER BY source_row DESC LIMIT 1",(mid,sha)).fetchone()
        if source is None:raise ValueError('缺少原始库存来源')
        provenance=json.loads(source[1])[-1]
        if price=='7.40' and provenance.get('price_correction',{}).get('inclusive_price')=='7.40':return {'changed':False}
        if not provenance.get('tax_normalization'):raise ValueError('不是本次已核对的 ERP 含税库存数据')
        stamp=now();audit={'before_price':price,'inclusive_price':'7.40','quantity':qty,'reason':'用户确认 DM064 含税库存价为 7.40 元/kg','actor':actor,'recorded_at':stamp}
        db.execute('INSERT INTO procurement_material_sources(material_id,sheet,source_row,raw_json,sha256) VALUES(%s,%s,%s,%s,%s)',(mid,'ERP库存汇总',source[0]+1,packed(['','DM064',dict(provenance,price_correction=audit)]),sha))
        db.execute('UPDATE procurement_inventory SET price=%s,source_row=%s,imported_by=%s,imported_at=%s WHERE material_id=%s',('7.40',source[0]+1,actor,stamp,mid))
        admin_event(db,actor,'inventory.price_corrected',mid,audit)
        enqueue(db,'DM064含税库存价格更正')
        return dict(audit,changed=True)
