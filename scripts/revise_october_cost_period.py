"""Apply the approved V27 inventory corrections as revisions of its cost event."""
from api.postgres import transaction
from api.research import now

ORIGINAL_NOTE = ('2026-10-21 库存资料修订：行情表内 138 项原料的库存价、库存量按《1021 原料行情表》同步；'
        '其余原料中 983 项 ERP 未税库存价按 13% 税率换算为含税价，库存量不变，缺价仍保留缺价。'
        '行情价格及原始行情快照不变；当前库存见原料详情。本次为本期资料修订，不新增行情版本。')

NOTE = ORIGINAL_NOTE + '另经核对，DM064 含税库存价更正为 7.40 元/kg，库存量不变，不再次加税。'


def revise(url, actor):
    with transaction(url, write=True) as db:
        db.execute("SET LOCAL statement_timeout='5min'")
        if db.execute('SELECT access_level,is_active FROM identity_users WHERE id=%s',(actor,)).fetchone() != (5,1):
            raise PermissionError('仅限有效系统管理员执行已确认的修订')
        events=db.execute('SELECT id,reason,read_period,status FROM research_events ORDER BY _order DESC LIMIT 4').fetchall()[::-1]
        if len(events)!=4 or [e[1] for e in events]!=['采购正式价格更新','库存价格更新','ERP库存价格统一含13%税','DM064含税库存价格更正']:
            raise ValueError('当前事件已变化，不能套用本次修订')
        period=events[0][2]
        if period.get('version')!=27 or period.get('price_date')!='2026-10-20' or any(e[2]!=period or e[3]!='done' for e in events):
            raise ValueError('期次或核算状态不一致')
        root=events[0][0]; ids=[e[0] for e in events]
        if db.execute('''SELECT 1 FROM research_cost_records WHERE event_id=ANY(%s) GROUP BY product_id
            HAVING count(DISTINCT payload::jsonb->'formula')>1 OR count(DISTINCT payload::jsonb->'graph')>1 LIMIT 1''',(ids,)).fetchone():
            raise ValueError('修订间存在配方变化，不能合并')
        existing=db.execute('SELECT event_id,root_event_id FROM research_event_revisions ORDER BY event_id').fetchall()
        expected=sorted((eid,root) for eid in ids[1:])
        note=db.execute('SELECT note FROM procurement_batch_revisions WHERE batch_id=%s',(period['id'],)).fetchone()
        if existing==expected and note==(NOTE,):
            return {'root':root,'changed':False}
        if not set(existing).issubset(set(expected)) or (note is not None and note[0] not in (ORIGINAL_NOTE,NOTE)):
            raise ValueError('已有修订记录不符')
        stamp=now()
        db.cursor().executemany('INSERT INTO research_event_revisions(event_id,root_event_id,actor,recorded_at) VALUES(%s,%s,%s,%s)',[(eid,root,actor,stamp) for eid in ids[1:] if (eid,root) not in existing])
        db.execute('INSERT INTO procurement_batch_revisions(batch_id,note,actor,recorded_at) VALUES(%s,%s,%s,%s) ON CONFLICT(batch_id) DO UPDATE SET note=excluded.note,actor=excluded.actor,recorded_at=excluded.recorded_at',(period['id'],NOTE,actor,stamp))
        keys=[k for k, in db.execute('SELECT DISTINCT product_id FROM research_cost_records WHERE event_id=ANY(%s)',(ids,))]
        for key in keys: db.execute('SELECT research_refresh_history(%s)',(key,))
        return {'root':root,'changed':True,'products':len(keys)}
