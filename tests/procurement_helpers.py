"""Adapt existing workflow fixtures to explicit catalog setup and revision tokens.

New collaboration/security tests use raw requests to test missing and stale tokens.
This helper never grants permissions or changes the logged-in actor.
"""
from api.procurement import _parse_delimited


def procurement_post(client, url, **kwargs):
    prefix='/api/workbenches/procurement'
    if not url.startswith(prefix):
        return client.post(url,**kwargs)
    body=dict(kwargs.get('json') or {})
    if url==prefix+'/imports':
        # Old test inputs also defined their catalog. Create that fixture explicitly.
        actor=client.get('/api/me').json()
        if actor.get('is_system_admin'):
            try:
                rows=_parse_delimited(body.get('content',''))
            except ValueError:
                rows=[]
            known={m['code'] for m in client.get(prefix+'/overview').json().get('materials',[])}
            for row in rows:
                if row['code'] and row['code'] not in known:
                    client.post(prefix+'/materials',json={'code':row['code'],'name':row['name']})
                    known.add(row['code'])
        data=client.get(prefix+'/overview').json(); update=data.get('current_update')
        body.setdefault('update_id',update['id'] if update else None)
        body.setdefault('updated_at',update['updated_at'] if update else None)
    elif url.endswith('/publish') and '/updates/' in url:
        data=client.get(prefix+'/overview').json(); update=data.get('current_update')
        if update:
            body.setdefault('updated_at',update['updated_at'])
            body.setdefault('baseline_id',data['batches'][0]['id'] if data.get('batches') else None)
    elif url.endswith('/review') and '/issues/' in url:
        data=client.get(prefix+'/overview').json(); update=data.get('current_update')
        if update: body.setdefault('updated_at',update['updated_at'])
    elif url.endswith('/adjustments') and '/materials/' in url:
        detail=client.get(url.removesuffix('/adjustments')).json()
        if detail.get('material'): body.setdefault('updated_at',detail['material']['updated_at'])
    kwargs['json']=body
    return client.post(url,**kwargs)
