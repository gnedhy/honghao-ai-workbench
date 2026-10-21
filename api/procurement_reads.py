"""Bounded procurement reads; prices remain frozen snapshot strings."""
from api.postgres import transaction


def series(url, *, start, end, material_id=None, boundaries=False, official_only=False):
    with transaction(url) as db:
        if material_id and not db.execute("SELECT 1 FROM procurement_materials WHERE id=%s AND archived_at IS NULL", (material_id,)).fetchone():
            raise LookupError("Material not found")
        if boundaries:
            # Keep the original quotation-date rule, including carried snapshots and zero prices.
            rows = db.execute("""SELECT DISTINCT point.batch_id,point.version,point.published_at,point.price_date,
                    point.material_id,point.code,point.latest_price,point.source_id,point.source_date,point.price_kind
                FROM procurement_materials m CROSS JOIN (VALUES (%s::text),(%s::text)) cutoff(day)
                CROSS JOIN LATERAL (
                    SELECT q.quote_day FROM procurement_price_read_points q
                    WHERE q.material_id=m.id AND q.batch_day<=%s AND q.quote_day<=cutoff.day
                      AND q.latest_price IS NOT NULL AND (q.source_id IS NULL OR q.price_kind='number')
                    ORDER BY q.quote_day DESC LIMIT 1
                ) distinct_points
                CROSS JOIN LATERAL (
                    SELECT canonical.* FROM (
                        SELECT DISTINCT ON(p.quote_date,p.latest_price::numeric) p.* FROM procurement_price_read_points p
                        WHERE p.material_id=m.id AND p.batch_day<=%s AND p.quote_day=distinct_points.quote_day
                          AND p.latest_price IS NOT NULL AND (p.source_id IS NULL OR p.price_kind='number')
                        ORDER BY p.quote_date,p.latest_price::numeric,(p.price_date=p.quote_date) DESC,p.version DESC
                    ) canonical ORDER BY quote_date DESC,version DESC LIMIT 1
                ) point
                WHERE m.archived_at IS NULL
            """, (end,start,end,end)).fetchall()
        else:
            official = " AND EXISTS(SELECT 1 " + OFFICIAL + " AND b.id=p.batch_id)" if official_only else ""
            rows = db.execute("""SELECT p.batch_id,p.version,p.published_at,p.price_date,p.material_id,p.code,p.latest_price,
                    p.source_id,p.source_date,p.price_kind
                FROM procurement_price_read_points p
                WHERE p.material_id=%s AND p.batch_day BETWEEN %s AND %s""" + official + " ORDER BY p.version LIMIT 1001", (material_id,start,end,*([material_id] if official_only else []))).fetchall()
            if len(rows)>1000:
                raise ValueError("所选范围超过 1000 期，请缩小日期范围；完整历史仍可分页查询。")
        batches={}
        for ident,version,published,day,mid,code,price,source_id,source_date,kind in rows:
            batch=batches.setdefault(ident,dict(id=ident,version=version,published_at=published,price_date=day,items=[],snapshot_sources={}))
            batch['items'].append(dict(material_id=mid,code=code,latest_price=price))
            if source_id is not None:
                batch['snapshot_sources'][mid]=dict(price_date=source_date,price_kind=kind)
        return {'batches':sorted(batches.values(),key=lambda b:b['version'],reverse=True)}


def eligible(url, start, end):
    with transaction(url) as db:
        return [row[0] for row in db.execute("""SELECT p.material_id FROM procurement_price_read_points p
            JOIN procurement_materials m ON m.id=p.material_id AND m.archived_at IS NULL
            WHERE p.batch_day BETWEEN %s AND %s AND p.latest_price IS NOT NULL
            GROUP BY p.material_id HAVING count(DISTINCT p.batch_day)>=2""",(start,end))]

# Catalog-only supplemental batches do not create a new price period for untouched materials.
OFFICIAL = """FROM procurement_price_batch_items i JOIN procurement_price_batches b ON b.id=i.batch_id
    LEFT JOIN procurement_snapshot_sources s ON s.batch_id=b.id AND s.material_id=i.material_id
    WHERE i.material_id=%s AND NOT (
        EXISTS(SELECT 1 FROM procurement_price_batches p WHERE p.version<b.version)
        AND EXISTS(SELECT 1 FROM procurement_saved_changes c WHERE c.update_id=b.update_id)
        AND NOT EXISTS(SELECT 1 FROM procurement_saved_changes c JOIN procurement_price_batch_items old
            ON old.material_id=c.material_id AND old.batch_id=(SELECT id FROM procurement_price_batches p WHERE p.version<b.version ORDER BY version DESC LIMIT 1)
            WHERE c.update_id=b.update_id)
        AND NOT EXISTS(SELECT 1 FROM procurement_saved_changes c WHERE c.update_id=b.update_id AND c.material_id=i.material_id))"""


def modifier(db, material_id, version):
    return db.execute("SELECT procurement_price_modifier(%s,%s)",(material_id,version)).fetchone()[0]


def official_history(url, material_id, *, start='', end='', search='', page=1, page_size=10, version=None, batch_id=None):
    import hashlib
    from datetime import date
    from fastapi import HTTPException
    try:
        if start: date.fromisoformat(start)
        if end: date.fromisoformat(end)
        if start and end and start > end: raise ValueError()
    except ValueError as error:
        raise HTTPException(status_code=422, detail="日期范围无效") from error
    with transaction(url) as db:
        if not db.execute("SELECT 1 FROM procurement_materials WHERE id=%s AND archived_at IS NULL",(material_id,)).fetchone():
            raise LookupError('Material not found')
        current=hashlib.sha256(str(db.execute("SELECT table_name,version FROM honghao_meta.read_versions WHERE table_name LIKE 'procurement%%' ORDER BY table_name").fetchall()).encode()).hexdigest()
        if version and version!=current:
            raise HTTPException(status_code=409,detail='历史记录已更新，请从第一页重新读取。')
        metadata=db.execute('SELECT count(*),min(b.price_date),max(b.price_date) '+OFFICIAL,(material_id,)).fetchone()
        where=OFFICIAL
        params=[material_id]
        if start:
            where+=' AND b.price_date>=%s';params.append(start)
        if end:
            where+=' AND b.price_date<=%s';params.append(end)
        if batch_id:
            where+=' AND b.id=%s';params.append(batch_id)
        # Search includes the same modifier name that is displayed, without loading full snapshots.
        if search:
            where+=" AND concat(b.price_date,' v',b.version::text,' ',procurement_price_modifier(i.material_id,b.version)->>'name') ILIKE %s"
            params.extend(['%'+search.strip().replace('\\','\\\\').replace('%','\\%').replace('_','\\_')+'%'])
        total=db.execute('SELECT count(*) '+where,params).fetchone()[0]
        rows=db.execute('SELECT b.id,b.version,b.price_date,i.latest_price,s.price_date,s.raw_price,s.price_kind,s.sheet,s.cell '+where+' ORDER BY b.price_date DESC,b.version DESC,b.id DESC LIMIT %s OFFSET %s',(*params,page_size,(page-1)*page_size)).fetchall()
        result=[]
        for row in rows:
            item=dict(zip(('id','version','version_date','latest_price','price_date','raw_price','price_kind','sheet','cell'),row))
            item['modifier']=modifier(db,material_id,row[1])
            if not batch_id:
                item.pop('sheet');item.pop('cell')
            result.append(item)
        return dict(items=result,total=total,scope_total=metadata[0],start_date=metadata[1],end_date=metadata[2],version=current,page=page)


def material_comparison(url, batch_id, material_id):
    from decimal import Decimal
    from api.procurement import _change
    with transaction(url) as db:
        while batch_id:
            batch=db.execute('SELECT version,update_id FROM procurement_price_batches WHERE id=%s',(batch_id,)).fetchone()
            prior=db.execute('SELECT id,version FROM procurement_price_batches WHERE version<%s ORDER BY version DESC LIMIT 1',(batch[0],)).fetchone()
            values=db.execute("""SELECT i.latest_price,s.raw_price,s.price_kind FROM procurement_price_batch_items i
                LEFT JOIN procurement_snapshot_sources s ON s.batch_id=i.batch_id AND s.material_id=i.material_id
                WHERE i.batch_id=%s AND i.material_id=%s""",(batch_id,material_id)).fetchone()
            old=db.execute("""SELECT i.latest_price,s.raw_price,s.price_kind FROM procurement_price_batch_items i
                LEFT JOIN procurement_snapshot_sources s ON s.batch_id=i.batch_id AND s.material_id=i.material_id
                WHERE i.batch_id=%s AND i.material_id=%s""",(prior[0] if prior else None,material_id)).fetchone()
            if not values:return None
            before=old[0] if old else None
            unusual=values[2] in ('range','invalid') or (old and old[2] in ('range','invalid'))
            kind='incomparable' if unusual else 'missing' if values[0] is None else 'first' if before is None else 'up' if Decimal(values[0])>Decimal(before) else 'down' if Decimal(values[0])<Decimal(before) else 'unchanged'
            supplement=prior and db.execute("""SELECT EXISTS(SELECT 1 FROM procurement_saved_changes WHERE update_id=%s)
                AND NOT EXISTS(SELECT 1 FROM procurement_saved_changes c JOIN procurement_price_batch_items i ON i.material_id=c.material_id AND i.batch_id=%s WHERE c.update_id=%s)
                AND NOT EXISTS(SELECT 1 FROM procurement_saved_changes WHERE update_id=%s AND material_id=%s)""",(batch[1],prior[0],batch[1],batch[1],material_id)).fetchone()[0]
            if supplement and kind=='unchanged':
                batch_id=prior[0];continue
            return dict(previous=before,previous_raw=old[1] if old else None,change=None if unusual else _change(values[0],before),kind=kind,version=batch[0],previous_version=prior[1] if prior else None)


def current_authorship(url, version, pending_id=None):
    with transaction(url) as db:
        official={mid:value for mid,value in db.execute('SELECT id,procurement_price_modifier(id,%s) FROM procurement_materials WHERE archived_at IS NULL',(version,)) if value is not None} if version is not None else {}
        updates={mid:dict(kind='system',name=name,id=actor) for mid,actor,name in db.execute("""SELECT DISTINCT ON(c.material_id) c.material_id,c.actor_id,c.actor_name FROM procurement_saved_changes c
            JOIN procurement_updates u ON u.id=c.update_id WHERE c.update_id=%s AND u.status!='cancelled'
            ORDER BY c.material_id,c.created_at DESC,c._order DESC""",(pending_id,))} if pending_id else {}
        purchasers={mid:names for mid,names in db.execute("""SELECT material_id,array_agg(DISTINCT trim(raw_json::jsonb->>0) ORDER BY trim(raw_json::jsonb->>0))
            FROM procurement_material_sources WHERE NULLIF(trim(raw_json::jsonb->>0),'') IS NOT NULL GROUP BY material_id""")}
        return official,updates,purchasers


def batch_page(store, *, page=1, page_size=10, status='all', version=None, start=None, end=None):
    import hashlib
    from fastapi import HTTPException
    with transaction(store.url) as db:
        current=hashlib.sha256(str(db.execute("SELECT table_name,version FROM honghao_meta.read_versions WHERE table_name LIKE 'procurement%%' ORDER BY table_name").fetchall()).encode()).hexdigest()
        if version and version!=current: raise HTTPException(status_code=409,detail='价格版本已更新，请从第一页重新读取。')
        total,latest=db.execute('SELECT count(*),max(version) FROM procurement_price_batches').fetchone()
        where='WHERE TRUE';params=[]
        if status!='all':
            where+=' AND version '+('=' if status=='active' else '<')+' %s';params.append(latest)
        count=db.execute('SELECT count(*) FROM procurement_price_batches '+where,params).fetchone()[0]
        if start is not None and end is not None:
            rows=db.execute("""SELECT DISTINCT b.id,b.version,b.published_at,b.item_count,b.price_date,b.activated_at,b.source_name,b.submitted_by,b.published_by
                FROM (VALUES(%s::text),(%s::text)) bounds(day) CROSS JOIN LATERAL (
                    SELECT * FROM procurement_price_batches WHERE LEFT(COALESCE(NULLIF(price_date,''),published_at),10)<=bounds.day
                    ORDER BY LEFT(COALESCE(NULLIF(price_date,''),published_at),10) DESC,version DESC LIMIT 1) b""",(start,end)).fetchall()
        else:
            rows=db.execute('SELECT id,version,published_at,item_count,price_date,activated_at,source_name,submitted_by,published_by FROM procurement_price_batches '+where+' ORDER BY version DESC LIMIT %s OFFSET %s',(*params,page_size,(page-1)*page_size)).fetchall()
        from api import procurement_collaboration as collaboration
        items=[]
        for row in rows:
            item=dict(zip(('id','version','published_at','item_count','price_date','activated_at','source_name','submitted_by','published_by'),row))
            item.update(status='active' if row[1]==latest else 'historical',comparison=store.batch_comparison(row[0]),provenance=collaboration.provenance(store.url,row[0]),published_by_name=store._user_name(row[8]))
            item["revision_note"] = revision_note(db,row[0])
            items.append(item)
        return dict(items=items,total=count,scope_total=total,page=page,version=current)


def revision_note(db, batch_id):
    row=db.execute('SELECT note FROM procurement_batch_revisions WHERE batch_id=%s',(batch_id,)).fetchone()
    return row[0] if row else None
