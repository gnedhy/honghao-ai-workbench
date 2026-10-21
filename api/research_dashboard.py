"""Dashboard aggregates and bounded choices; never ship a product/period matrix."""
from datetime import date

from fastapi import Query, Request
from starlette.responses import JSONResponse, Response

from api.postgres import transaction
from api.research_reads import ledger_source, scope_sql


def overview(db,user):
    source,params,access,pending=ledger_source(db,user,'products')
    warning="(row->>'yield')::numeric>1 AND NOT(COALESCE(row->>'source_kind','')='erp_bom' AND COALESCE(row->'yield_source'->>'kind','') IN ('mes_mean','bom_ratio_sum','user_confirmed'))"
    counts=db.execute(source+f"""SELECT count(*),count(*) FILTER(WHERE (row->'change'->>'percent')::numeric>0),
        count(*) FILTER(WHERE (row->'change'->>'percent')::numeric<0),count(*) FILTER(WHERE row->>'status'='missing'),
        count(*) FILTER(WHERE {warning}),count(*) FILTER(WHERE row->>'status'='failed') FROM rows""",params).fetchone()
    formula_source,formula_params,_,_=ledger_source(db,user,'formulas')
    drafts=db.execute(formula_source+"SELECT count(*) FROM rows WHERE (row->>'has_draft')::boolean OR row->>'lifecycle'='draft'",formula_params).fetchone()[0]
    # Count the union, including inactive/draft formulas, rather than adding overlapping task counts.
    todo=source+f"SELECT row->>'id' FROM rows WHERE row->>'status'='missing' OR {warning}"
    draft_ids=formula_source+"SELECT row->>'id' FROM rows WHERE (row->>'has_draft')::boolean OR row->>'lifecycle'='draft'"
    tasks=db.execute('SELECT count(*) FROM (('+todo+') UNION ('+draft_ids+')) tasks',params+formula_params).fetchone()[0]
    scope,scope_params=scope_sql(access,'h.payload')
    current_scope,current_params=scope_sql(access,'f.formula::jsonb')
    scope+=" AND h.payload->>'kind'='recipe' AND EXISTS(SELECT 1 FROM research_formulas f WHERE f.id=h.product_id AND "+current_scope+")"
    scope_params+=current_params
    last=db.execute('SELECT effective_date FROM research_history_reads h WHERE '+scope+' ORDER BY effective_date DESC LIMIT 1',scope_params).fetchone()
    periods,recent=db.execute("SELECT count(*),max(e.recorded_at) FROM research_events e WHERE EXISTS(SELECT 1 FROM research_history_reads h WHERE h.event_id=e.id AND h.record_type='formal' AND "+scope+')',scope_params).fetchone()
    return dict(products=[],formulas=[],versions=[],pending=bool(pending),owners=[],departments=[],
        dashboard=dict(latest_date=last[0] if last else date.today().isoformat(),metrics=dict(products=counts[0],up=counts[1],down=counts[2],missing=counts[3],warnings=counts[4],failed=counts[5],drafts=drafts,tasks=tasks,periods=periods,recent=recent)))


def dates(start,end):
    date.fromisoformat(start);date.fromisoformat(end)
    if start>end:raise ValueError('开始日期不能晚于结束日期')


def options(db,user,search,start,end,selected,page):
    from api.research_access import ResearchAccess
    access=ResearchAccess(db,user)
    scope,params=scope_sql(access,'f.formula::jsonb')
    source=" FROM research_formulas f WHERE lifecycle='active' AND formula::jsonb->>'kind'='recipe' AND "+scope
    ordering=" ORDER BY research_natural(f.formula::jsonb->>'name'),f.id"
    display="SELECT f.id,f.formula::jsonb->>'name'"
    chosen=db.execute(display+source+' AND f.id=%s',params+[selected]).fetchone() if selected else None
    history_scope,history_params=scope_sql(access,'h.payload')
    dates(start,end)
    eligible=" AND (EXISTS(SELECT 1 FROM (SELECT DISTINCT effective_date FROM research_history_reads h WHERE product_id=f.id AND "+history_scope+" AND effective_date BETWEEN %s AND %s AND payload->>'latest_cost' IS NOT NULL LIMIT 2) x HAVING count(*)=2) OR EXISTS(SELECT 1 FROM (SELECT DISTINCT effective_date FROM research_history_reads h WHERE product_id=f.id AND "+history_scope+" AND effective_date BETWEEN %s AND %s AND payload->>'inventory_cost' IS NOT NULL LIMIT 2) x HAVING count(*)=2))"
    default=chosen or db.execute(display+source+eligible+ordering+' LIMIT 1',params+history_params+[start,end]+history_params+[start,end]).fetchone()
    if default is None:default=db.execute(display+source+ordering+' LIMIT 1',params).fetchone()
    if search:source+=" AND strpos(lower(f.formula::jsonb->>'name'),lower(%s))>0";params.append(search)
    count=db.execute('SELECT count(*)'+source,params).fetchone()[0]
    page=min(page,max(1,(count+49)//50))
    rows=db.execute(display+source+ordering+' LIMIT 50 OFFSET %s',params+[(page-1)*50]).fetchall()
    item=lambda value:dict(id=value[0],code=value[1]) if value else None
    return dict(items=[item(row) for row in rows],total=count,page=page,page_size=50,selected=item(chosen),default=item(default))


def movers(db,user,start,end,direction):
    dates(start,end)
    source,params,access,_=ledger_source(db,user,'products')
    scope,scope_params=scope_sql(access,'h.payload')
    boundary="SELECT h.payload FROM research_history_reads h WHERE h.product_id=row->>'id' AND "+scope+" AND h.effective_date<=%s ORDER BY h.effective_date DESC,(h.record_type='formal') DESC,h.recorded_at DESC,h.purchase_version DESC NULLS LAST,h.event_id DESC LIMIT 1"
    source+=", boundaries AS(SELECT row,a.payload AS before,b.payload AS after FROM rows LEFT JOIN LATERAL("+boundary+")a ON true LEFT JOIN LATERAL("+boundary+")b ON true), priced AS(SELECT row,before,after,round((before->>'latest_cost')::numeric,2) AS prior,round((after->>'latest_cost')::numeric,2) AS current FROM boundaries), movements AS(SELECT row,before,after,(current-prior)/NULLIF(prior,0)*100 AS percent FROM priced) "
    params+=scope_params+[start]+scope_params+[end]
    where=' WHERE percent'+('>0' if direction=='up' else '<0')
    total=db.execute(source+'SELECT count(*) FROM movements'+where,params).fetchone()[0]
    rows=db.execute(source+'SELECT row,before,after,percent FROM movements'+where+' ORDER BY percent '+('DESC' if direction=='up' else 'ASC')+",research_natural(row->>'name'),row->>'id' LIMIT 30",params).fetchall()
    items=[]
    for row,before,after,percent in rows:
        items.append(dict(id=row['id'],name=row['name'],latest_cost=after['latest_cost'],before=before['latest_cost'],change=dict(percent=float(percent),reason=f"{start} 截至成本 {before['latest_cost']} → {end} 截至成本 {after['latest_cost']} 元/kg")))
    return dict(items=items,total=total)


def gaps(db,user,direction):
    source,params,_,_=ledger_source(db,user,'products')
    source+=", priced AS(SELECT row,round((row->>'latest_cost')::numeric,2)-round((row->>'inventory_cost')::numeric,2) AS gap FROM rows WHERE row->>'status'='ready') "
    where=' WHERE gap'+{'all':'!=0','latest':'>0','inventory':'<0'}[direction]
    total=db.execute(source+'SELECT count(*) FROM priced'+where,params).fetchone()[0]
    rows=db.execute(source+'SELECT row,gap FROM priced'+where+" ORDER BY abs(gap) DESC,research_natural(row->>'name'),row->>'id' LIMIT 5",params).fetchall()
    return dict(items=[dict(id=row['id'],name=row['name'],latest_cost=row.get('latest_cost'),inventory_cost=row.get('inventory_cost'),gap=float(gap)) for row,gap in rows],total=total)


def register(router,store,actor,run,read_actor,read_slots):
    def read(request,fn,*args):
        from api.research import digest
        actor(request)
        with read_slots,transaction(store.url) as db:
            user=read_actor(request)
            version=run(store.overview_etag,user)
            tag='W/"'+digest([version,fn.__name__,args])+'"'
            headers={'ETag':tag,'Cache-Control':'no-store','Vary':'Cookie'}
            if tag in [value.strip() for value in request.headers.get('if-none-match','').split(',')]:return Response(status_code=304,headers=headers)
            return JSONResponse(run(fn,db,user,*args),headers=headers)

    @router.get('/dashboard')
    def dashboard(request:Request):return read(request,overview)

    @router.get('/product-options')
    def product_options(request:Request,search:str=Query('',max_length=200),start:str=Query(...),end:str=Query(...),selected:str='',page:int=Query(1,ge=1)):
        return read(request,options,search,start,end,selected,page)

    @router.get('/dashboard-movers')
    def dashboard_movers(request:Request,start:str,end:str,direction:str=Query('up',pattern='^(up|down)$')):return read(request,movers,start,end,direction)

    @router.get('/dashboard-gaps')
    def dashboard_gaps(request:Request,direction:str=Query('all',pattern='^(all|latest|inventory)$')):return read(request,gaps,direction)
