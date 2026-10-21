"""Bounded sales reads; ownership is applied before counting and paging."""
import json
from datetime import date

from api.postgres import transaction
from api.research import digest

SCOPE = '(b.owner_id=%s OR %s)'
BATCHES = """WITH scoped AS (
 SELECT b.id,b.updated_at,b.summary_payload::jsonb AS value,
 (SELECT count(*) FROM sales_records r WHERE r.batch_id=b.id AND r.status='active') AS active,
 (SELECT count(*) FROM jsonb_array_elements(b.summary_payload::jsonb->'items') i
 WHERE NOT COALESCE((i->>'voided')::boolean,false) AND
 (NOT COALESCE((i->>'adopted')::boolean,false) OR COALESCE(i->>'adjustment_reason','')!='')) AS pending,
 (SELECT count(*) FROM jsonb_array_elements(b.summary_payload::jsonb->'items') i WHERE (i->>'voided')::boolean) AS voided
 FROM sales_batches b WHERE """ + SCOPE + """ AND jsonb_array_length(b.summary_payload::jsonb->'items')>0
), rows AS (SELECT *, CASE WHEN active>0 AND pending>0 THEN 'partial' WHEN active>0 THEN 'adopted'
 WHEN pending>0 THEN 'pending' WHEN voided>0 THEN 'void' ELSE 'pending' END AS status FROM scoped) """


def bounds(start, end):
    for value in (start, end):
        if value:
            date.fromisoformat(value)
    if start and end and start > end:
        raise ValueError('开始日期不能晚于结束日期')


def version(db, actor, query):
    values = db.execute("SELECT table_name,version FROM honghao_meta.read_versions WHERE table_name=ANY(%s) ORDER BY table_name", (['sales_batches','sales_records','sales_trials','identity_users','identity_user_scopes'],)).fetchall()
    return digest([actor['id'],bool(actor.get('is_system_admin')),actor.get('scope_levels'),query,values])


def page(store, actor, kind, page=1, page_size=50, search='', start='', end='', product='', batch='', mode='', status='', token=''):
    store._authorize(actor)
    if kind=='timeline':
        return timeline(store,actor,batch,page,page_size,token)
    if kind not in ('batches','records','trials') or not 1 <= page_size <= 200 or page < 1 or (kind=='trials' and status):
        raise ValueError('分页参数无效')
    bounds(start,end)
    with transaction(store.url) as db:
        stamp = version(db,actor,[kind,page_size,search,start,end,product,batch,mode,status])
        reset = bool(token and token != stamp)
        if reset:
            page = 1
        args = [actor['id'],bool(actor.get('is_system_admin'))]
        if kind == 'batches':
            prefix, source, field, day = BATCHES, 'rows', 'value', 'updated_at'
            where = ['true']
        else:
            table = 'sales_records' if kind == 'records' else 'sales_trials'
            prefix, source, field, day = '', f'{table} r JOIN sales_batches b ON b.id=r.batch_id JOIN identity_users u ON u.id=r.actor_id', 'r.summary_payload::jsonb', 'r.created_at'
            where = [SCOPE]
            if product:
                where.append('r.product_id=%s' if kind == 'records' else "r.product_ids ? %s")
                args.append(product)
            if batch:
                store._get(db,batch,actor)
                where.append('r.batch_id=%s'); args.append(batch)
        if start:
            where.append(f'{day}>=%s'); args.append(start)
        if end:
            where.append(f'{day}<%s'); args.append(end+'T99')
        if mode:
            where.append(f"{field}->>'mode'=%s"); args.append(mode)
        if status:
            where.append('status=%s' if kind == 'batches' else 'r.status=%s'); args.append(status)
        if search.strip():
            where.append(f"strpos(lower(({field})::text),lower(%s))>0"); args.append(search.strip())
        clause = ' AND '.join(where)
        total = db.execute(prefix+f'SELECT count(*) FROM {source} WHERE {clause}',args).fetchone()[0]
        page = min(page,max(1,(total+page_size-1)//page_size))
        extra = ",status,active,pending,voided" if kind == 'batches' else (",r.status,u.display_name,b.summary_payload::jsonb->>'customer_code',b.summary_payload::jsonb->'uncoded'" if kind == 'records' else ',u.display_name')
        rows = db.execute(prefix+f'SELECT {field}{extra} FROM {source} WHERE {clause} ORDER BY {day} DESC,'+('id' if kind=='batches' else 'r.id')+' DESC LIMIT %s OFFSET %s',[*args,page_size,(page-1)*page_size]).fetchall()
        values=[]
        for row in rows:
            item = row[0]
            if kind == 'batches':
                item.update(list_status=row[1],active_count=row[2],pending_count=row[3],voided_count=row[4])
            elif kind == 'records':
                item.update(status=row[1],actor_name=row[2],current_customer_code=row[3],current_uncoded=row[4])
            else:
                item.update(actor_name=row[1],items=[])
            values.append(item)
        return {'items':values,'total':total,'page':page,'page_size':page_size,'version':stamp,'reset':reset}


def record(store, actor, kind, key):
    store._authorize(actor)
    if kind=='batches':
        with transaction(store.url) as db:
            return {'batch':store._get(db,key,actor)}
    if kind not in ('records','trials'):
        raise ValueError('记录类型无效')
    with transaction(store.url) as db:
        table='sales_records' if kind=='records' else 'sales_trials'
        row=db.execute(f'SELECT r.payload FROM {table} r JOIN sales_batches b ON b.id=r.batch_id WHERE r.id=%s AND '+SCOPE,(key,actor['id'],bool(actor.get('is_system_admin')))).fetchone()
        if not row:
            raise KeyError('报价记录不存在')
        return json.loads(row[0])


def series(store, actor, product, start, end, mode):
    store._authorize(actor)
    if not product or not start or not end:
        raise ValueError('请选择产品和日期范围')
    result=page(store,actor,'records',page_size=200,start=start,end=end,product=product,mode=mode)
    if result['total']>200:
        raise ValueError('当前范围超过200条报价，请缩小日期范围；完整记录可在历史中分页查看')
    return {'records':result['items'],'version':result['version']}


def overview(store, actor, start='', end='', mode='domestic_direct'):
    store._authorize(actor)
    bounds(start,end)
    with transaction(store.url) as db:
        scope=[actor['id'],bool(actor.get('is_system_admin'))]
        counts=dict(db.execute(BATCHES+'SELECT status,count(*) FROM rows GROUP BY status',scope).fetchall())
        active=db.execute('SELECT count(*) FROM sales_records r JOIN sales_batches b ON b.id=r.batch_id WHERE '+SCOPE+" AND r.status='active'",scope).fetchone()[0]
        previews=[]
        for states in (['pending','partial'],['adopted','partial']):
            values=db.execute(BATCHES+'SELECT value,status FROM rows WHERE status=ANY(%s) ORDER BY updated_at DESC,id DESC LIMIT 5',[*scope,states]).fetchall()
            previews.append([{'batch':value,'status':status} for value,status in values])
        eligible=[]
        if start and end:
            from api.research_formulas import DEFAULT_COMPOSITE
            eligible=[r[0] for r in db.execute(CATALOG+"SELECT c.id FROM catalog c WHERE (SELECT count(*) FROM (SELECT 1 FROM sales_records r JOIN sales_batches b ON b.id=r.batch_id WHERE r.product_id=c.id AND "+SCOPE+" AND r.created_at>=%s AND r.created_at<%s AND r.summary_payload::jsonb->>'mode'=%s AND (r.summary_payload::jsonb#>>'{item,result,normal_price}' IS NOT NULL OR r.summary_payload::jsonb#>>'{item,final_price}' IS NOT NULL) LIMIT 2) eligible_rows)=2 ORDER BY research_natural(c.code),c.id LIMIT 1",[DEFAULT_COMPOSITE,*scope,start,end+'T99',mode])]

        hot=db.execute("SELECT a.product_id,count(*) FILTER(WHERE a.trials>0),sum(a.adopted) FROM sales_activity a JOIN sales_batches b ON b.id=a.batch_id WHERE "+SCOPE+" GROUP BY a.product_id HAVING count(*) FILTER(WHERE a.trials>0)>0 ORDER BY count(*) FILTER(WHERE a.trials>0) DESC,sum(a.adopted) DESC,a.product_id LIMIT 6",scope).fetchall()
        return {'counts':counts,'active':active,'pending':previews[0],'recent':previews[1],
                'hot':[dict(product_id=r[0],batches=r[1],adopted=r[2]) for r in hot], 'eligible':eligible}


CATALOG = """WITH catalog AS (
 SELECT 'research:'||id AS id,CASE WHEN formula::jsonb->>'kind'='recipe' THEN formula::jsonb->>'name' ELSE 'CF401B' END AS code,
 CASE WHEN formula::jsonb->>'kind'='recipe' THEN formula::jsonb->>'name' ELSE 'CF401B' END AS name,
 COALESCE(NULLIF(formula::jsonb->>'department',''),CASE WHEN formula::jsonb->>'source_kind'='erp_bom' THEN '部门未记录' ELSE '研发五部' END) AS department,'research' AS source
 FROM research_formulas WHERE lifecycle='active' AND (formula::jsonb->>'kind'='recipe' OR id=%s)
 UNION ALL SELECT 'procurement:'||id,code,name,'采购','procurement' FROM procurement_materials
 WHERE archived_at IS NULL AND code!='CF401B' AND lower(trim(unit)) IN ('kg','公斤','千克')) """


def catalog(store, actor, page=1, page_size=50, search='', source='', department='', exclude=''):
    from api.research_formulas import DEFAULT_COMPOSITE
    store._authorize(actor)
    if page<1 or not 1<=page_size<=200:
        raise ValueError('分页参数无效')
    excluded=exclude.split(',') if exclude else []
    if len(excluded)>500:
        raise ValueError('产品选择超过上限')
    with transaction(store.url) as db:
        args=[DEFAULT_COMPOSITE]
        conditions=['NOT(id=ANY(%s))'];args.append(excluded)
        for column,value in [('source',source),('department',department)]:
            if value:
                conditions.append(column+'=%s');args.append(value)
        if search.strip():
            conditions.append("strpos(lower(code||' '||name||' '||department),lower(%s))>0");args.append(search.strip())
        where=' WHERE '+' AND '.join(conditions)
        total=db.execute(CATALOG+'SELECT count(*) FROM catalog'+where,args).fetchone()[0]
        page=min(page,max(1,(total+page_size-1)//page_size))
        ids=[row[0] for row in db.execute(CATALOG+'SELECT id FROM catalog'+where+' ORDER BY research_natural(code),id LIMIT %s OFFSET %s',[*args,page_size,(page-1)*page_size])]
        products,_=store._catalog(db,ids)
        departments=[r[0] for r in db.execute(CATALOG+'SELECT DISTINCT department FROM catalog ORDER BY department',[DEFAULT_COMPOSITE])]
        return {'products':[products[key] for key in ids if key in products],'total':total,'page':page,'departments':departments}


def selected_products(store, actor, ids):
    store._authorize(actor)
    if not isinstance(ids,list) or len(ids)>500 or any(not isinstance(key,str) for key in ids):
        raise ValueError('产品选择无效')
    with transaction(store.url) as db:
        products,_=store._catalog(db,ids)
        return {'products':list(products.values())}


def timeline(store, actor, batch, page=1, page_size=50, token=''):
    if page<1 or not 1<=page_size<=200 or not batch:
        raise ValueError('分页参数无效')
    with transaction(store.url) as db:
        store._get(db,batch,actor)
        stamp=version(db,actor,['timeline',batch,page_size])
        reset=bool(token and token!=stamp)
        if reset: page=1
        source="""WITH rows AS (SELECT id,created_at,'records' AS kind,summary_payload::jsonb || jsonb_build_object('status',status) AS value FROM sales_records WHERE batch_id=%s
 UNION ALL SELECT id,created_at,'trials',summary_payload::jsonb FROM sales_trials WHERE batch_id=%s) """
        total=db.execute(source+'SELECT count(*) FROM rows',(batch,batch)).fetchone()[0]
        page=min(page,max(1,(total+page_size-1)//page_size))
        rows=db.execute(source+"SELECT value || jsonb_build_object('history_kind',kind) FROM rows ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s",(batch,batch,page_size,(page-1)*page_size)).fetchall()
        return {'items':[r[0] for r in rows],'total':total,'page':page,'page_size':page_size,'version':stamp,'reset':reset}
