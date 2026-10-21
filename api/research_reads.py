"""Product-scoped reads from transactionally maintained history projections."""
import json
from datetime import date, timedelta

from api.research_access import ResearchAccess
from api.research_history import BACKFILL_DETAIL


def access_product(db, key, actor):
    access=ResearchAccess(db,actor)
    row=db.execute('SELECT formula FROM research_formulas WHERE id=%s',(key,)).fetchone()
    if row is None:
        raise KeyError('产品不存在')
    access.require(json.loads(row[0]))
    return access


def history_page(db,key,actor,*,page=1,page_size=50,search='',start='',end='',trend=False,version=None):
    access=access_product(db,key,actor)
    current_version=db.execute('SELECT revision FROM research_history_versions WHERE product_id=%s',(key,)).fetchone()
    from api.research import digest
    current_version=digest([key,current_version[0] if current_version else 0,access.admin,access.level,access.departments])
    if version is not None and version!=current_version:
        raise RuntimeError('历史记录已更新，请从第一页重新读取')
    scope,scope_params=scope_sql(access,'payload')
    if trend:
        last=db.execute('SELECT effective_date FROM research_history_reads WHERE product_id=%s AND '+scope+' ORDER BY effective_date DESC LIMIT 1',[key]+scope_params).fetchone() if not start and not end else None
        total,minimum,maximum=0,None,last[0] if last else end or None
    else:
        total,minimum,maximum=db.execute('SELECT count(*),min(effective_date),max(effective_date) FROM research_history_reads WHERE product_id=%s AND '+scope,[key]+scope_params).fetchone()
    if trend and not start and not end and maximum:
        end=maximum
        start=(date.fromisoformat(maximum)-timedelta(days=90)).isoformat()
    for value in (start,end):
        if value:
            date.fromisoformat(value)
    if start and end and start>end:
        raise ValueError('开始日期不能晚于结束日期')
    where='product_id=%s AND '+scope; params=[key]+scope_params
    if start: where+=' AND effective_date>=%s'; params.append(start)
    if end: where+=' AND effective_date<=%s'; params.append(end)
    if search:
        where+=" AND strpos(lower(effective_date || ' ' || COALESCE(payload->>'reason','') || ' ' || COALESCE(purchase_version::text,'')),lower(%s))>0"; params.append(search)
    count=db.execute('SELECT count(*) FROM research_history_reads WHERE '+where,params).fetchone()[0]
    if trend: total,minimum,maximum=count,start or None,end or maximum
    if trend and count>2000:
        raise ValueError('趋势记录超过2000条，请缩小日期范围；完整历史可分页查看')
    page_size=2000 if trend else page_size
    page=min(page,max(1,(count+page_size-1)//page_size))
    rows=[row[0] for row in db.execute('SELECT payload FROM research_history_reads WHERE '+where+' ORDER BY effective_date DESC,(record_type=\'formal\') DESC,recorded_at DESC,purchase_version DESC NULLS LAST,event_id DESC LIMIT %s OFFSET %s',params+[page_size,(page-1)*page_size])]
    rows=project_summaries(db,access,[normalize(row) for row in rows if access.allows(row)])
    result=dict(version=current_version,items=rows,total=count,scope_total=total,page=page,page_size=page_size,min_date=minimum,max_date=maximum)
    if trend:
        result['versions']=[dict(id=row['event_id'],products=[{k:v for k,v in row.items() if k in ('id','name','latest_cost','inventory_cost','effective_date','recorded_at','record_type','purchase_version','event_id','reason','missing_materials','status')}],**{k:row.get(k) for k in ('record_type','purchase_version','effective_date','recorded_at','reason')}) for row in rows]
    return result


def history_record(db,key,event_id,actor):
    access=access_product(db,key,actor)
    summary=db.execute('SELECT payload,record_type,purchase_version FROM research_history_reads WHERE product_id=%s AND event_id=%s',(key,event_id)).fetchone()
    if summary is None or not access.allows(summary[0]):
        raise KeyError('记录不存在')
    if summary[1]=='backfill':
        raw=db.execute(f'SELECT {BACKFILL_DETAIL} FROM research_backfill_records WHERE product_id=%s AND purchase_version=%s',(key,summary[2])).fetchone()
    else:
        raw=db.execute('SELECT payload FROM research_cost_records WHERE product_id=%s AND event_id=%s',(key,summary[0].get('source_event_id',event_id))).fetchone()
    if raw is None: raise KeyError('记录不存在')
    row=normalize({**json.loads(raw[0]),**summary[0]})
    access.require(row.get('formula',row))
    row.pop('_visibility',None)
    row=access.project(row,access.visible_ids(db) if not access.admin else set())
    return dict(id=event_id,products=[row],**{k:row.get(k) for k in ('record_type','purchase_version','effective_date','recorded_at','reason')})


def scope_sql(access, expression):
    if access.admin:
        return 'TRUE',[]
    if access.level<2:
        return 'FALSE',[]
    return f"(({expression}->>'department_id')=ANY(%s) OR (COALESCE({expression}->>'department_id','')='' AND COALESCE(NULLIF({expression}->>'department',''),CASE WHEN COALESCE({expression}->>'source_kind','')='' THEN '研发五部' END)=ANY(%s)))",[list(access.departments),[value['name'] for value in access.departments.values()]]

def ledger_source(db,actor,kind):
    """Filter and limit in SQL before materializing any ledger row."""
    access=ResearchAccess(db,actor)
    scope,params=scope_sql(access,'f.formula::jsonb')
    pending=db.execute("SELECT status FROM research_events WHERE status!='done' ORDER BY _order LIMIT 1").fetchone()
    if kind=='formulas':
        value="(CASE WHEN f.lifecycle='draft' THEN COALESCE(d.formula,f.formula) ELSE f.formula END)::jsonb - 'source_hashes' || jsonb_build_object('lifecycle',f.lifecycle,'revision',f.revision,'has_draft',d.id IS NOT NULL OR f.lifecycle='draft')"
        joins=''
    else:
        value="COALESCE(c.current_payload::jsonb,f.formula::jsonb || jsonb_build_object('latest_cost',NULL,'inventory_cost',NULL,'change',jsonb_build_object('percent',NULL,'reason','首次核算中'),'missing_materials','[]'::jsonb)) || jsonb_build_object('revision',f.revision,'has_draft',d.id IS NOT NULL) || CASE WHEN h.payload IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('change',h.payload->'change','comparison_basis',h.payload->'comparison_basis','includes_backfill',EXISTS(SELECT 1 FROM research_backfill_records b WHERE b.product_id=f.id)) END"
        if pending:
            value += " || jsonb_build_object('status','"+('failed' if pending[0]=='failed' else 'updating')+"')"
        joins="LEFT JOIN LATERAL(SELECT current_payload FROM research_cost_records WHERE product_id=f.id ORDER BY sequence DESC LIMIT 1)c ON true LEFT JOIN LATERAL(SELECT payload FROM research_history_reads WHERE product_id=f.id ORDER BY ordinal DESC LIMIT 1)h ON true"
        scope+=" AND f.lifecycle='active'"
    source=f"WITH scoped AS MATERIALIZED(SELECT {value} AS row FROM research_formulas f LEFT JOIN research_drafts d ON d.id=f.id {joins} WHERE f.formula::jsonb->>'kind'='recipe' AND {scope}), rows AS MATERIALIZED(SELECT row || jsonb_build_object('lines',CASE WHEN jsonb_typeof(row->'lines')='array' THEN jsonb_array_length(row->'lines') ELSE COALESCE((row->>'lines')::integer,0) END) AS row FROM scoped) "
    return source,params,access,pending


def ledger_page(db,actor,query):
    source,params,access,pending=ledger_source(db,actor,query['kind'])
    kind=query['kind']
    count,owners,depts=db.execute(source+"SELECT count(*),array_agg(DISTINCT row->>'owner') FILTER(WHERE COALESCE(row->>'owner','')!=''),array_agg(DISTINCT COALESCE(row->>'department','研发五部')) FROM rows",params).fetchone()
    conditions=[]; filters=[]
    for field in ('owner','department'):
        if query[field]: conditions.append("COALESCE(row->>'"+field+"','"+("研发五部" if field=="department" else "")+"')=%s"); filters.append(query[field])
    if query['search']: conditions.append("strpos(lower(row->>'name'),lower(%s))>0");filters.append(query['search'])
    if query['status']:
        if kind=='formulas' and query['status']=='draft': conditions.append("(row->>'lifecycle'='draft' OR (row->>'has_draft')::boolean)")
        else: conditions.append("row->>%s=%s");filters.extend(['lifecycle' if kind=='formulas' else 'status',query['status']])
    if query['draft']: conditions.append("COALESCE((row->>'has_draft')::boolean,false)=%s");filters.append(query['draft']=='yes')
    if query['yield_warning']: conditions.append("(row->>'yield')::numeric>1 AND NOT(COALESCE(row->>'source_kind','')='erp_bom' AND COALESCE(row->'yield_source'->>'kind','') IN ('mes_mean','bom_ratio_sum','user_confirmed'))")
    if query['movement']: conditions.append("(row->'change'->>'percent')::numeric "+{'none':'IS NULL','up':'>0','down':'<0','flat':'=0'}[query['movement']])
    where=' WHERE '+' AND '.join(conditions) if conditions else ''
    total=db.execute(source+'SELECT count(*) FROM rows'+where,params+filters).fetchone()[0]
    page=min(query['page'],max(1,(total+query['page_size']-1)//query['page_size']))
    sort=query['sort']
    if sort=='change': ordering="(row->'change'->>'percent')::numeric"
    elif sort in ('latest_cost','inventory_cost'): ordering="round((row->>'"+sort+"')::numeric,2)"
    elif sort in ('yield','lines'): ordering="(row->>'"+sort+"')::numeric"
    else: ordering="research_natural(COALESCE(row->>'"+sort+"','"+("研发五部" if sort=="department" else "")+"'))"
    rows=[r[0] for r in db.execute(source+'SELECT row FROM rows'+where+' ORDER BY '+ordering+(' ASC' if query['asc'] else ' DESC')+" NULLS LAST,research_natural(row->>'name'),row->>'id' LIMIT %s OFFSET %s",params+filters+[query['page_size'],(page-1)*query['page_size']])]
    if kind!='formulas' and rows:
        keys=[(row['id'],row.get('event_id','')) for row in rows]
        contexts={(pid,event):context for pid,event,context in db.execute("SELECT product_id,event_id,payload->'_visibility' FROM research_history_reads WHERE (product_id,event_id) IN ("+','.join(['(%s,%s)']*len(keys))+')',[value for pair in keys for value in pair])}
        for row in rows:
            row['_visibility']=contexts.get((row['id'],row.get('event_id','')))
        rows=project_summaries(db,access,[normalize(row) for row in rows])
    rows=access.project(rows,access.visible_ids(db) if not access.admin else set())
    departments=[{'id':ident,'name':name} for ident,name in db.execute("SELECT id,name FROM organization_departments WHERE parent_id IS NULL AND (name LIKE '研发%' OR name='浙江实验室') ORDER BY (name='研发五部') DESC,name")] if access.admin else [{'id':ident,'name':value['name']} for ident,value in sorted(access.departments.items(),key=lambda item:(not item[1]['primary'],item[1]['name']))]
    if access.admin:
        expanded=db.execute("SELECT EXISTS(SELECT 1 FROM research_formulas WHERE lifecycle='active' AND formula::jsonb->>'source_kind'='erp_bom')").fetchone()[0]
        owner_scope="d.name LIKE '研发%'" if expanded else "d.name='研发五部'"
        creation={row[0] for row in db.execute("SELECT u.display_name FROM identity_users u JOIN organization_memberships m ON m.user_id=u.id JOIN organization_departments d ON d.id=m.department_id WHERE u.is_active=1 AND "+owner_scope)}
    else:
        creation={row[0] for row in db.execute('SELECT u.display_name FROM identity_users u JOIN organization_memberships m ON m.user_id=u.id WHERE u.is_active=1 AND m.department_id=ANY(%s)',(list(access.departments),))}
    return dict(items=rows,total=total,scope_total=count,page=page,page_size=query['page_size'],owners=sorted(owners or []),department_names=sorted(depts or []),pending=bool(pending),departments=departments,creation_owners=sorted(creation|set(owners or [])))


def detail_history_metadata(db,key,actor,current):
    access=access_product(db,key,actor)
    scope,params=scope_sql(access,'payload')
    count,maximum=db.execute('SELECT count(*),max(effective_date) FROM research_history_reads WHERE product_id=%s AND '+scope,[key]+params).fetchone()
    history={'product_id':key,'latest':{'lines':[]},'inventory':{'lines':[]}}
    for policy in ('latest','inventory'):
        for line in (current.get(policy) or {}).get('lines',[]):
            if not line.get('unit_cost') or not line.get('quantity'): continue
            # Find the first differing or missing evidence, not merely the preceding period.
            found=db.execute("""SELECT matched.lines FROM research_history_reads h
              CROSS JOIN LATERAL(SELECT jsonb_agg(value) AS lines FROM jsonb_array_elements(h.line_prices->%s->'lines') value WHERE value->>'kind'=%s AND value->>'ref'=%s AND (value->>'quantity')::numeric>0) matched
              WHERE product_id=%s AND ordinal<(SELECT max(ordinal) FROM research_history_reads WHERE product_id=%s) AND """+scope+"""
              AND (matched.lines IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(matched.lines) value WHERE round((value->>'unit_cost')::numeric,2) IS DISTINCT FROM round(%s::numeric,2)))
              ORDER BY ordinal DESC LIMIT 1""",[policy,line['kind'],line['ref'],key,key]+params+[line['unit_cost']]).fetchone()
            if found and found[0]: history[policy]['lines'].extend(found[0])
    return {'history_total':count,'max_date':maximum,'line_history':[history]}

def versions_page(db,actor,*,page=1,page_size=10,search='',start='',end='',event_id=None,version=None,record_type='all'):
    access=ResearchAccess(db,actor)
    current_version=history_scope_version(db,access)
    if version is not None and version!=current_version:
        raise RuntimeError('历史记录已更新，请从第一页重新读取')
    scope,params=scope_sql(access,'h.payload')
    current_scope,current_params=scope_sql(access,'f.formula::jsonb')
    where='EXISTS(SELECT 1 FROM research_formulas f WHERE f.id=h.product_id AND '+current_scope+') AND '+scope
    params=current_params+params
    scope_source='FROM research_history_reads h WHERE '+where
    scope_params=list(params)
    if event_id: where+=' AND h.event_id=%s';params.append(event_id)
    event_where,event_params=where,list(params)
    if start: date.fromisoformat(start);where+=' AND h.effective_date>=%s';params.append(start)
    if end: date.fromisoformat(end);where+=' AND h.effective_date<=%s';params.append(end)
    if search: where+=" AND strpos(lower(h.effective_date || ' ' || COALESCE(h.payload->>'reason','') || ' ' || COALESCE(h.payload->>'name','')),lower(%s))>0";params.append(search)
    source='FROM research_history_reads h WHERE '+where
    if event_id:
        total=db.execute('SELECT count(*) '+source,params).fetchone()[0]
        scope_total=db.execute('SELECT count(*) FROM research_history_reads h WHERE '+event_where,event_params).fetchone()[0]
        if not scope_total: raise KeyError('记录不存在')
        page=min(page,max(1,(total+page_size-1)//page_size))
        prior_scope,prior_params=scope_sql(access,'p.payload')
        rows=[]
        statement="""SELECT h.payload,prior.payload FROM research_history_reads h LEFT JOIN LATERAL(
          SELECT p.payload FROM research_history_reads p WHERE p.product_id=h.product_id AND """+prior_scope+""" AND
          (p.effective_date,p.record_type='formal',p.recorded_at,COALESCE(p.purchase_version,0),p.event_id)<(h.effective_date,h.record_type='formal',h.recorded_at,COALESCE(h.purchase_version,0),h.event_id)
          ORDER BY p.effective_date DESC,(p.record_type='formal') DESC,p.recorded_at DESC,p.purchase_version DESC NULLS LAST,p.event_id DESC LIMIT 1)prior ON true
          WHERE """+where+" ORDER BY research_natural(h.payload->>'name'),h.product_id LIMIT %s OFFSET %s"
        for value,prior in db.execute(statement,prior_params+params+[page_size,(page-1)*page_size]):
            value['period_change']=period_change(value.get('latest_cost'),prior.get('latest_cost') if prior else None)
            rows.append(value)
        rows=project_summaries(db,access,[normalize(row) for row in rows])
        row=rows[0] if rows else db.execute('SELECT h.payload FROM research_history_reads h WHERE '+event_where+' ORDER BY h.product_id LIMIT 1',event_params).fetchone()[0]
        scope_total=db.execute('SELECT count(*) FROM research_history_reads h WHERE '+event_where,event_params).fetchone()[0]
        return dict(id=event_id,cost_version=row.get('purchase_version') if row.get('record_type')=='backfill' else version_numbers(db,scope_source,scope_params,[event_id]).get(event_id),products=rows,total=total,scope_total=scope_total,page=page,page_size=page_size,version=current_version,**{k:row.get(k) for k in ('record_type','purchase_version','effective_date','recorded_at','reason')})
    counts={kind:count for kind,count in db.execute('SELECT record_type,count(DISTINCT event_id) '+source+' GROUP BY record_type',params)}
    counts=dict(all=sum(counts.values()),formal=counts.get('formal',0),backfill=counts.get('backfill',0))
    if record_type!='all':
        source+=' AND h.record_type=%s';params.append(record_type)
    total=db.execute('SELECT count(DISTINCT event_id) '+source,params).fetchone()[0]
    page=min(page,max(1,(total+page_size-1)//page_size))
    rows=db.execute("SELECT event_id,max(effective_date),max(recorded_at),max(record_type),max(purchase_version),max(payload->>'reason'),count(*) "+source+" GROUP BY event_id ORDER BY max(effective_date) DESC,(max(record_type)='formal') DESC,max(recorded_at) DESC,event_id DESC LIMIT %s OFFSET %s",params+[page_size,(page-1)*page_size]).fetchall()
    scope_total,minimum,maximum=db.execute('SELECT count(DISTINCT event_id),min(effective_date),max(effective_date) '+scope_source,scope_params).fetchone()
    numbering=version_numbers(db,scope_source,scope_params,[row[0] for row in rows])
    return dict(items=[dict(id=eid,effective_date=effective,recorded_at=recorded,record_type=kind,purchase_version=version,reason=reason,products=[],cost_version=version if kind=='backfill' else numbering.get(eid),stats=(stats:=version_stats(db,access,eid)),product_count=sum(stats.values())) for eid,effective,recorded,kind,version,reason,count in rows],counts=counts,total=total,scope_total=scope_total,page=page,page_size=page_size,min_date=minimum,max_date=maximum,version=current_version)


def version_numbers(db,scope_source,scope_params,event_ids):
    return dict(db.execute("WITH versions AS(SELECT event_id,max(effective_date) AS effective_date,max(recorded_at) AS recorded_at,max(record_type) AS record_type,max(purchase_version) AS purchase_version "+scope_source+" GROUP BY event_id), numbered AS(SELECT event_id,row_number() OVER(ORDER BY effective_date,recorded_at,purchase_version NULLS FIRST,event_id)+COALESCE((SELECT max(purchase_version) FROM versions WHERE record_type='backfill'),0) AS cost_version FROM versions WHERE record_type='formal') SELECT event_id,cost_version FROM numbered WHERE event_id=ANY(%s)",scope_params+[event_ids]))


def project_summaries(db,access,rows):
    visible=access.visible_ids(db) if not access.admin else set()
    for row in rows:
        context=row.pop('_visibility',None)
        if access.admin:
            continue
        if context is None:
            # Fail closed for projections created before the masking migration.
            if row.get('missing_materials'):
                row['missing_materials']=['引用链存在缺价，请核对本部门投料或联系相关部门']
            row.pop('price_review_pending',None)
            continue
        projected=access.project({**context,'missing_materials':row.get('missing_materials',[])},visible)
        row['missing_materials']=projected.get('missing_materials',[])
        if 'price_review_pending' in row:
            row['price_review_pending']=sorted({code for policy in ('latest','inventory') for code in projected.get(policy,{}).get('price_review_pending',[])})
    return rows


def normalize(row):
    if 'comparison_basis' in row:
        from api.research import comparison
        row['change']=comparison(row.get('latest_cost'),row.get('comparison_basis'))
    return row


def history_scope_version(db,access):
    from api.research import digest,OVERVIEW_INSTANCE,OVERVIEW_TABLES
    versions=db.execute('SELECT table_name,version FROM honghao_meta.read_versions WHERE table_name=ANY(%s)',(list(OVERVIEW_TABLES),)).fetchall()
    return digest([OVERVIEW_INSTANCE,access.admin,access.level,access.departments,sorted(versions)])


def period_change(current,prior):
    from api.research import comparison_price
    left,right=comparison_price(current),comparison_price(prior)
    if left is None or right is None:
        return dict(direction='none',percent=None,reason='本期或上期缺少成本记录，暂无对比')
    direction='stable' if left==right else 'up' if left>right else 'down'
    percent=0 if direction=='stable' else None if right==0 else float((left-right)/right*100)
    return dict(direction=direction,percent=percent,reason=f'较上一期行情优先成本（元/kg）：{right:.2f} → {left:.2f}'+('；上期为零，无法计算百分比' if right==0 and left!=right else ''))


def version_stats(db,access,event_id):
    scope,params=scope_sql(access,'h.payload')
    current,current_params=scope_sql(access,'f.formula::jsonb')
    prior_scope,prior_params=scope_sql(access,'p.payload')
    statement="""SELECT
      count(*) FILTER(WHERE current>previous),count(*) FILTER(WHERE current<previous),
      count(*) FILTER(WHERE current=previous),count(*) FILTER(WHERE current IS NULL OR previous IS NULL)
      FROM(SELECT round((h.payload->>'latest_cost')::numeric,2) AS current,round((prior.payload->>'latest_cost')::numeric,2) AS previous
      FROM research_history_reads h LEFT JOIN LATERAL(SELECT p.payload FROM research_history_reads p
        WHERE p.product_id=h.product_id AND """+prior_scope+""" AND
        (p.effective_date,p.record_type='formal',p.recorded_at,COALESCE(p.purchase_version,0),p.event_id)<(h.effective_date,h.record_type='formal',h.recorded_at,COALESCE(h.purchase_version,0),h.event_id)
        ORDER BY p.effective_date DESC,(p.record_type='formal') DESC,p.recorded_at DESC,p.purchase_version DESC NULLS LAST,p.event_id DESC LIMIT 1)prior ON true
      WHERE h.event_id=%s AND """+scope+' AND EXISTS(SELECT 1 FROM research_formulas f WHERE f.id=h.product_id AND '+current+')) values'
    row=db.execute(statement,prior_params+[event_id]+params+current_params).fetchone()
    return dict(zip(('up','down','stable','missing'),row))
