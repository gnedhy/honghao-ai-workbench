"""Isolated public-news probe; no procurement database or production imports."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html import escape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import os
import shutil
import subprocess
import tempfile
import urllib.request
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

SOURCES = {
    "商务部": "https://trb.mofcom.gov.cn/",
    "生意社": "https://www.100ppi.com/news/list-14--1.html",
    "隆众资讯": "https://www.oilchem.net/1/32458/",
}
ARTICLE_PATTERNS = {
    "商务部": r"https://trb\.mofcom\.gov\.cn/[^?#]+/art_\w+\.html",
    "生意社": r"https://www\.100ppi\.com/news/detail-\d{8}-\d+\.html",
    "隆众资讯": r"https://www\.oilchem\.net/\d{2}-\d{4}-\d{2}-[a-f0-9]+\.html",
}
CHEMICAL = re.compile(r"化工|石油|树脂|聚|苯|醇|醛|酸|碱|氯|硅|磷|氨|胺|酯|橡胶|塑料|原油|能源|供应链")
KEYWORDS = re.compile(r"化工|石油|能源|生产资料|工业生产者|PPI|采购经理|物流|运价|汇率|关税|进出口|供应链", re.I)


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}: self.hidden += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style"}: self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden: self.parts.append(data)


def plain(value):
    parser = PlainText()
    parser.feed(value)
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


def parse_feed(raw, source):
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("不接受带外部实体的订阅")
    encoding = re.search(br'encoding=["\x27]([^"\x27]+)', raw[:200], re.I)
    root = ET.fromstring(raw.decode(encoding.group(1).decode("ascii") if encoding else "utf-8"))
    if root.tag != "rss": raise ValueError("返回内容不是RSS，可能需要浏览器验证")
    items = []
    for node in root.findall("./channel/item"):
        title, url = plain(node.findtext("title", "")), node.findtext("link", "").strip()
        if not title or urlsplit(url).scheme not in {"https", "http"} or not urlsplit(url).hostname: continue
        if not KEYWORDS.search(title): continue
        date = node.findtext("pubDate", "").strip()
        parsed = None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%a, %d %b %Y %H:%M:%S %z"):
            try:
                parsed = datetime.strptime(date, fmt).isoformat()
                break
            except ValueError: pass
        if not parsed: continue
        items.append({"title": title, "url": url, "published_at": parsed, "source": source,
                      "summary": plain(node.findtext("description", ""))[:160]})
    return items


def fetch_source(pair):
    name, url = pair
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "ProcurementNewsProbe/0.1", "Accept": "application/rss+xml, text/xml"})
        with urllib.request.urlopen(request, timeout=12) as response:
            raw = response.read(16_000_001)
        if len(raw) > 16_000_000: raise ValueError("订阅超过16MB上限")
        items = parse_feed(raw, name)
        if not items: raise ValueError("未读到有效资讯，保留上次结果")
        return name, items, None
    except Exception as error:
        return name, None, f"{type(error).__name__}: {str(error)[:180]}"


def browser_items(rows, source="生意社"):
    items = {}
    for row in rows:
        url = row.get("url", "")
        title = plain(row.get("title", ""))
        if not re.fullmatch(ARTICLE_PATTERNS[source], url) or not title:
            continue
        try:
            date = row.get("date", "")
            parsed = datetime.strptime(date, "%Y-%m-%d %H:%M" if len(date) > 10 else "%Y-%m-%d")
            published = parsed.isoformat(timespec="minutes") if len(date) > 10 else parsed.date().isoformat()
        except ValueError:
            continue
        items[url] = {"title": title, "url": url, "published_at": published,
                      "source": source, "summary": ""}
    if not items: raise ValueError("浏览器未读到带日期的化工资讯，保留上次结果")
    return [item for item in items.values() if source != "商务部" or CHEMICAL.search(item["title"])]


def fetch_browser(pair):
    name, source_url = pair
    executable = shutil.which("npx.cmd" if os.name == "nt" else "npx")
    if not executable: return name, None, "未安装 npx，浏览器读取不可用"
    # ponytail: validation-only CLI; pin a browser runtime before production scheduling.
    command = [executable, "--yes", "--package", "@playwright/cli", "playwright-cli", f"-s=news-probe-{os.getpid()}-{list(SOURCES).index(name)}"]
    def run(*arguments):
        result = subprocess.run(command + list(arguments), capture_output=True, timeout=45)
        if result.returncode: raise ValueError("浏览器命令失败")
        return result.stdout.decode("utf-8")
    try:
        run("open", source_url)
        rows = json.loads(run("eval", "() => Array.from(document.querySelectorAll('li a')).map(a => ({url:a.href,title:a.getAttribute('title')||a.textContent,date:(a.closest('li').textContent.replace(/\\s+/g,' ').match(/\\d{4}-\\d{2}-\\d{2}(?: \\d{2}:\\d{2})?/)||[])[0]||''}))", "--raw"))
        return name, browser_items(rows, name), None
    except Exception as error:
        return name, None, f"{type(error).__name__}: {str(error)[:180]}"
    finally:
        try: run("close")
        except Exception: pass


def merge(previous, outcomes):
    result = dict(previous)
    for name, items, error in outcomes:
        old = previous.get(name, {})
        result[name] = {"items": old.get("items", []) if error else items,
                        "last_success": old.get("last_success") if error else datetime.now(timezone.utc).isoformat(),
                        "error": error}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="独立验证目录，不使用正式数据目录")
    parser.add_argument("--browser", action="store_true", help="兼容旧命令；三个固定来源均使用浏览器读取")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    cache_path = args.output / "news-cache.json"
    previous = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    # Old source caches remain in a separate file as evidence, never mixed into this edition.
    if previous and set(previous) != set(SOURCES):
        backup = args.output / "news-cache-before-fixed-sources.json"
        if not backup.exists(): backup.write_text(json.dumps(previous, ensure_ascii=False, indent=2), encoding="utf-8")
    previous = {name: previous[name] for name in SOURCES if name in previous}
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(fetch_browser, SOURCES.items()))
    cache = merge(previous, results)
    unique = {item["url"]: item for source in cache.values() for item in source["items"]}
    items = sorted(unique.values(), key=lambda item: item["published_at"], reverse=True)
    # Atomic replacement keeps the previous completed cache if writing is interrupted.
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.output, delete=False) as temporary:
        json.dump(cache, temporary, ensure_ascii=False, indent=2)
    Path(temporary.name).replace(cache_path)
    report = {"checked_at": datetime.now(timezone.utc).isoformat(), "unique_count": len(items),
              "sources": [{"name": name, "status": "failed_cached" if source["error"] else "ok", "count": len(source["items"]), "error": source["error"], "last_success": source["last_success"]} for name, source in cache.items()]}
    (args.output / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with (args.output / "runs.jsonl").open("a", encoding="utf-8") as history:
        history.write(json.dumps(report, ensure_ascii=False) + "\n")
    rows = "".join(f'<li><a href="{escape(item["url"], quote=True)}" target="_blank" rel="noopener noreferrer">{escape(item["title"])}</a><p>{escape(item["summary"])}</p><small>{escape(item["source"])} · {escape(item["published_at"])}</small></li>' for item in items[:12])
    rows = "".join('<li><h3>'+escape(name)+'</h3><ul>'+"".join(f'<li><a href="{escape(item["url"], quote=True)}" target="_blank" rel="noopener noreferrer">{escape(item["title"])}</a><br><small>{escape(item["published_at"].replace("T", " "))}</small></li>' for item in items if item["source"] == name)+'</ul></li>' for name in SOURCES)
    status = "".join(f'<li>{escape(row["name"])}：{row["status"]} · {row["count"]}条{(" · " + escape(row["error"])) if row["error"] else ""}</li>' for row in report["sources"])
    (args.output / "index.html").write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>采购资讯采集验证</title><style>body{max-width:880px;margin:40px auto;padding:0 20px;font:15px/1.7 system-ui;color:#30363b}li{margin:16px 0;overflow-wrap:anywhere}p,small{color:#66717b}a{color:#315d7c}h1{font-size:24px}</style><h1>采购资讯 · 三个固定信源</h1><p>独立验证，不连接正式库。商务部按化工关键词筛选；生意社读取化工列表，隆众读取热点列表。日期为列表标注日期，可能包含历史资讯或更新日期。本页展示标题及原文入口，尚未生成阅读总结。</p><p>采集时间：'+escape(report['checked_at'])+'</p><h2>来源状态</h2><ul>'+status+'</ul><h2>本轮获取内容（按来源分组）</h2><ol>'+rows+'</ol></html>', encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__": main()
