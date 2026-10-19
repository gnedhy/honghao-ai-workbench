"""Bounded server pages over a versioned, permission-projected ledger snapshot."""
from decimal import Decimal
from functools import cmp_to_key
import re


def page_rows(rows, *, kind, page, page_size, search='', owner='', department='', status='', draft='', movement='', yield_warning=False, sort='name', asc=True):
    def dept(row):
        return row.get('department') or '研发五部'
    def warning(row):
        return Decimal(row['yield']) > 1 and not (row.get('source_kind') == 'erp_bom' and (row.get('yield_source') or {}).get('kind') in ('mes_mean','bom_ratio_sum','user_confirmed'))
    def matches(row):
        change = (row.get('change') or {}).get('percent')
        state = (row.get('lifecycle') == 'draft' or row.get('has_draft')) if kind == 'formulas' and status == 'draft' else row.get('lifecycle' if kind == 'formulas' else 'status') == status
        return (not search or search.lower() in row['name'].lower()) and (not owner or row.get('owner') == owner) and (not department or dept(row) == department) and (not status or state) and (not draft or bool(row.get('has_draft')) == (draft == 'yes')) and (not yield_warning or warning(row)) and (not movement or (change is None if movement == 'none' else change is not None and {'up':change > 0,'down':change < 0,'flat':change == 0}[movement]))
    def natural(value):
        return [(1,int(part)) if part.isdigit() else (0,part.casefold()) for part in re.split(r'(\d+)',str(value))]
    def value(row):
        if sort == 'change': return (row.get('change') or {}).get('percent')
        if sort in ('latest_cost','inventory_cost'):
            from api.research import comparison_price
            return comparison_price(row.get(sort))
        if sort == 'yield': return Decimal(row['yield'])
        if sort == 'lines': return len(row['lines']) if isinstance(row['lines'],list) else row['lines']
        return natural(dept(row) if sort == 'department' else row.get(sort,''))
    def compare(left,right):
        a,b=value(left),value(right)
        tie=(natural(left['name']),left['id']) > (natural(right['name']),right['id'])
        reverse=(natural(left['name']),left['id']) < (natural(right['name']),right['id'])
        if a is None or b is None: return (tie-reverse) if a is b else (1 if a is None else -1)
        return ((a>b)-(a<b))*(1 if asc else -1) or tie-reverse
    selected=sorted((row for row in rows if matches(row)),key=cmp_to_key(compare))
    page=min(page,max(1,(len(selected)+page_size-1)//page_size))
    return {'items':selected[(page-1)*page_size:page*page_size], 'total':len(selected), 'scope_total':len(rows), 'page':page, 'page_size':page_size,
            'owners':sorted({row['owner'] for row in rows if row.get('owner')}),
            'department_names':sorted({dept(row) for row in rows})}
