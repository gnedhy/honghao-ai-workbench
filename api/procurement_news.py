"""Read-only procurement news cache; deliberately independent of price storage."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil

from scripts.procurement_news_probe import SOURCES, browser_items

CHINA = timezone(timedelta(hours=8))
INTERVAL = 3600


def now():
    return datetime.now(CHINA)


def recent(items, at):
    cutoff = (at - timedelta(days=30)).date().isoformat()
    return [item for item in items if cutoff <= item['published_at'][:10] <= at.date().isoformat()]


def combine(old, new, at):
    # Latest fetch wins URL changes; equivalent syndicated entries within a source collapse.
    urls = {item['url']: item for item in recent(old + new, at)}
    seen = set()
    result = []
    for item in reversed(list(urls.values())):
        key = (item['source'], item['title'], item['published_at'][:10])
        if key not in seen:
            result.append(item)
            seen.add(key)
    return sorted(result, key=lambda item: (item['published_at'], item['url']), reverse=True)


def market_highlights(items):
    # Two balanced pages, newest first within each page; scarce sources are not padded.
    pools = [[item for item in items if item['source'] == name][:5] for name in ('生意社', '隆众资讯')]
    selected = {item['url'] for pool in pools for item in pool}
    for item in items:
        if len(selected) >= 10: break
        if item['url'] not in selected:
            pools[0 if item['source'] == '生意社' else 1].append(item)
            selected.add(item['url'])
    order = lambda item: (item['published_at'], item['url'])
    if len(selected) <= 5: return sorted(pools[0] + pools[1], key=order, reverse=True)
    take_a = min(5, len(pools[0]), max(3, 5-len(pools[1])))
    if len(selected) >= 7 and min(map(len, pools)) >= 2:
        take_a = min(max(take_a, 6-len(pools[1]), 1), len(pools[0])-1, 4)
    first = pools[0][:take_a] + pools[1][:5-take_a]
    first_urls = {item['url'] for item in first}
    rest = sorted([item for pool in pools for item in pool if item['url'] not in first_urls], key=order, reverse=True)
    return sorted(first, key=order, reverse=True) + rest


class NewsStore:
    def __init__(self, directory):
        self.path = Path(directory) / 'procurement-news' / 'cache.json'
        self.lock = asyncio.Lock()
        self.process = None
        self.cache = {'checked_at': None, 'sources': {}}
        try:
            loaded = json.loads(self.path.read_text(encoding='utf-8'))
            if isinstance(loaded, dict) and isinstance(loaded.get('sources'), dict):
                checked = loaded.get('checked_at')
                try:
                    if checked and datetime.fromisoformat(checked).tzinfo:
                        self.cache['checked_at'] = checked
                except (ValueError, TypeError): pass
                for name in SOURCES:
                    entry = loaded['sources'].get(name)
                    if not isinstance(entry, dict): continue
                    try:
                        last = entry.get('last_success')
                        if last and not datetime.fromisoformat(last).tzinfo: continue
                        saved = entry.get('items', [])
                        items = browser_items([{'url':item['url'], 'title':item['title'], 'date':item['published_at'].replace('T', ' ')} for item in saved], name) if saved else []
                        self.cache['sources'][name] = {'items': combine([], items, now()), 'last_success':last, 'error':entry.get('error')}
                    except (ValueError, TypeError, KeyError, AttributeError): continue
        except (OSError, ValueError, TypeError): pass
        if not self.cache['sources']:
            self.cache['checked_at'] = None

    def delay(self):
        try: return max(0, INTERVAL - (now() - datetime.fromisoformat(self.cache['checked_at'])).total_seconds())
        except (TypeError, ValueError): return 0

    def listing(self, source='all', page=1):
        at = now()
        states = []
        items = []
        for name in SOURCES:
            entry = self.cache['sources'].get(name, {})
            last = entry.get('last_success')
            stale = not last or (at - datetime.fromisoformat(last)).total_seconds() > INTERVAL * 2
            status = 'delayed' if entry.get('error') or stale else 'ok'
            if not entry: status = 'pending'
            states.append({'name': name, 'status': status, 'last_success': last})
            if source == 'all' or source == name or source == 'market' and name != '商务部':
                items.extend(recent(entry.get('items', []), at))
        items.sort(key=lambda item: (item['published_at'], item['url']), reverse=True)
        if source == 'market': items = market_highlights(items)
        limit = 10 if source == 'market' else 20
        total = len(items)
        page = min(page, max(1, (total + limit - 1) // limit))
        relevant = [s for s in states if source != 'market' or s['name'] != '商务部']
        return {'items': items[(page-1)*limit:page*limit], 'total': total, 'page': page, 'page_size': limit,
                'sources': states, 'updated_at': max((s['last_success'] for s in relevant if s['last_success']), default=None),
                'delayed': any(s['status'] == 'delayed' for s in relevant)}

    def accept(self, outcomes):
        if not isinstance(outcomes, list) or any(not isinstance(o, dict) or o.get('name') not in SOURCES for o in outcomes):
            raise ValueError('Invalid collection result')
        at = now()
        updated = dict(self.cache['sources'])
        for outcome in outcomes:
            name = outcome['name']
            if name not in SOURCES: continue
            old = updated.get(name, {})
            error = outcome.get('error')
            items = []
            if not error:
                try: items = browser_items(outcome['rows'], name)
                except (ValueError, TypeError, KeyError, AttributeError): error = 'InvalidContent'
            updated[name] = {'items': combine(old.get('items', []), items, at),
                             'last_success': old.get('last_success') if error else at.isoformat(), 'error': error}
        data = {'checked_at': at.isoformat(), 'sources': updated}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        temporary.replace(self.path)
        self.cache = data

    async def stop(self):
        process = self.process
        if process is None or process.returncode is not None: return
        try:
            process.stdin.write(b'stop\n')
            await process.stdin.drain()
            await asyncio.wait_for(process.wait(), 5)
        except (OSError, ConnectionError, asyncio.TimeoutError):
            if os.name == 'nt':
                killer = await asyncio.create_subprocess_exec('taskkill', '/PID', str(process.pid), '/T', '/F', stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await killer.wait()
            else: process.kill()
            await process.wait()

    async def refresh(self):
        if self.lock.locked(): return
        async with self.lock:
            try:
                node = shutil.which('node')
                if not node: raise OSError('Node unavailable')
                runner = Path(__file__).resolve().parents[1] / 'scripts' / 'procurement_news_browser.mjs'
                self.process = await asyncio.create_subprocess_exec(node, str(runner), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                raw = await asyncio.wait_for(self.process.stdout.read(), 100)
                await asyncio.wait_for(self.process.wait(), 5)
                self.accept(json.loads(raw))
            except asyncio.CancelledError:
                raise
            except (OSError, ValueError, asyncio.TimeoutError):
                self.accept([{'name':name,'error':'CollectionFailed'} for name in SOURCES])
            finally:
                await self.stop()
                self.process = None

    async def run(self):
        while True:
            await asyncio.sleep(self.delay())
            try: await self.refresh()
            except OSError: await asyncio.sleep(INTERVAL)
