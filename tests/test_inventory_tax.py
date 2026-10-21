import json
import pytest
from api.postgres import transaction
from scripts.normalize_erp_inventory_tax import normalize
from tests.test_procurement_inventory import inventory_data, apply


def test_tax_normalization_keeps_sources_and_rejects_repeat_or_stale_input(inventory_data):
    settings, _, _, admin = inventory_data
    apply(inventory_data)
    url = settings.database_url
    with transaction(url, write=True) as db:
        mid, sha = db.execute("SELECT i.material_id,i.source_sha256 FROM procurement_inventory i JOIN procurement_materials m ON m.id=i.material_id WHERE m.code='A'").fetchone()
        db.execute("UPDATE procurement_inventory SET sheet='ERP库存汇总' WHERE material_id=%s", (mid,))
        original = json.dumps(['','A',{'source':'ERP 库存','as_of':'2026-10-07'}])
        db.execute('INSERT INTO procurement_material_sources(material_id,sheet,source_row,raw_json,sha256) VALUES(%s,%s,1,%s,%s)',(mid,'ERP库存汇总',original,sha))
    with pytest.raises(PermissionError): normalize(url,'not-authorized')
    plan = normalize(url,admin)
    assert plan['matched'] == 1 and plan['rows'][0]['inclusive_price'] == '5.085'
    with pytest.raises(ValueError): normalize(url,admin,expected_sha256='stale')
    normalize(url,admin,expected_sha256=plan['sha256'])
    again = normalize(url,admin)
    assert again['matched'] == 0 and again['already_normalized'] == 1
    normalize(url,admin,expected_sha256=again['sha256'])
    with transaction(url, write=True) as db:
        assert db.execute('SELECT quantity,price,raw_price FROM procurement_inventory WHERE material_id=%s',(mid,)).fetchone() == ('12.34567','5.085','4.5')
        assert db.execute("SELECT raw_json FROM procurement_material_sources WHERE material_id=%s AND sheet='ERP库存汇总' AND source_row=1",(mid,)).fetchone()[0] == original
        assert db.execute('SELECT count(*) FROM procurement_inventory WHERE price IS NULL').fetchone()[0] == 2
        db.execute("UPDATE procurement_inventory SET price='4.5' WHERE material_id=%s",(mid,))
    with pytest.raises(ValueError, match='已换算记录'): normalize(url,admin)
