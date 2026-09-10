import pytest
from scripts.procurement_news_probe import merge, parse_feed, browser_items


def test_failed_source_preserves_cache():
    previous = {"source": {"items": [{"url": "https://example.com/a"}], "last_success": "before"}}
    assert merge(previous, [("source", None, "timeout")])["source"] == {**previous["source"], "error": "timeout"}


def test_feed_filters_and_sanitizes():
    raw = b'<rss><channel><item><title>PPI news</title><link>https://example.com/a</link><pubDate>2026-09-09 09:30:00</pubDate><description><![CDATA[<b>data</b><script>bad()</script>]]></description></item><item><title>PPI unsafe</title><link>javascript:alert(1)</link><pubDate>2026-09-09 09:30:00</pubDate></item></channel></rss>'
    items = parse_feed(raw, "source")
    assert len(items) == 1
    assert items[0]["summary"] == "data"


def test_browser_requires_real_dates_and_deduplicates():
    row = {"url": "https://www.100ppi.com/news/detail-20260910-123.html", "title": "化工报价", "date": "2026-09-10 08:49"}
    assert len(browser_items([row, row, {**row, "url": "https://evil.example/a"}])) == 1
    assert browser_items([row])[0]["summary"] == ""
    with pytest.raises(ValueError):
        browser_items([{**row, "date": ""}])


def test_browser_failure_does_not_remove_other_source():
    old = {"rss": {"items": [1], "last_success": "yesterday"}, "browser": {"items": [2], "last_success": "yesterday"}}
    result = merge(old, [("rss", [3], None), ("browser", None, "verification page")])
    assert result["rss"]["items"] == [3]
    assert result["browser"]["items"] == [2]


def test_ministry_filters_and_accepts_date_only():
    row = {"url": "https://trb.mofcom.gov.cn/myjjdc/art/2026/art_123.html", "title": "聚甲醛公告", "date": "2026-09-07"}
    assert len(browser_items([row, {**row, "url": row["url"].replace("123", "124"), "title": "牛肉公告"}], "商务部")) == 1


def test_oilchem_uses_page_date_not_url_year():
    row = {"url": "https://www.oilchem.net/19-0404-19-2816873f82add672.html", "title": "PA6动态", "date": "2026-09-10 09:24"}
    assert browser_items([row], "隆众资讯")[0]["published_at"] == "2026-09-10T09:24"
