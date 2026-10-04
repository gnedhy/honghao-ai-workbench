"""Synthetic operational failures, privacy and alert recovery; never connect to a database."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / file)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


monitor = load('operations_monitor', 'operations-monitor.py')
auditor = load('dependency_audit', 'check-dependencies.py')
policy = monitor.read_json(Path(__file__).resolve().parents[1] / 'operations-policy.json')


class OperationalProbes(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'application'
        self.release = self.root / 'releases/fixed'; self.data = self.root / 'data'
        self.release.mkdir(parents=True); self.data.mkdir()
        self.now = datetime(2026, 10, 4, 12, tzinfo=timezone.utc)
        self.write(self.root/'active.json', {'release_dir':str(self.release), 'data_dir':str(self.data), 'database_profile':'production', 'host':'127.0.0.1', 'port':8000})
        self.write(self.data/'workbench-runtime-config.json', {'workbench_modes':{'procurement':'active','research':'active'}})
        for name in ('api/main.py','dist/index.html','uv.lock','package-lock.json'):
            target=self.release/name; target.parent.mkdir(exist_ok=True); target.write_text('fixed',encoding='utf-8')
        self.write(self.release/'release-manifest.json', {'files':{name:monitor.sha256(self.release/name) for name in ('api/main.py','dist/index.html')}})
        self.write(self.data/'procurement-news/cache.json', {'checked_at':self.now.isoformat(), 'sources':{name:{'items':[{'title':'PRIVATE_ARTICLE'}], 'last_success':self.now.isoformat(), 'error':None} for name in monitor.SOURCES}})
        self.snapshot=self.root/'backups/snapshot-fixed'
        self.write(self.snapshot/'manifest.json', {'version':2,'engine':'postgresql','environment':'production','database_environment':'production','created_at':(self.now-timedelta(hours=1)).isoformat()})
        self.health={'status':'ok','environment':'production','service':'honghao-ai-api'}
        self.readiness={'status':'ready','checks':dict.fromkeys(monitor.READINESS|{'procurement_scheduler','research_startup','research_scheduler'},'ok')}
        self.dependencies={'schema':1,'complete':True,'locks':auditor.lock_fingerprint(self.release),'count':0,'checkedAt':self.now.isoformat()}

    def write(self, file, value):
        file.parent.mkdir(parents=True,exist_ok=True); file.write_text(json.dumps(value),encoding='utf-8')

    def http(self, url, timeout):
        if url.endswith('/health'): return 200,json.dumps(self.health).encode(),10
        if url.endswith('/readiness'): return 200,json.dumps(self.readiness).encode(),20
        return 200,b'fixed',5

    def run_probe(self, previous=None, **changes):
        empty = {'research':{'pending':0,'failed':0,'oldestSeconds':0},'procurement':{'overdue':0,'oldestSeconds':0}}
        return monitor.probe(self.root,policy,previous or {},self.now,http=changes.pop('http',self.http),owner=changes.pop('owner',lambda root:True),backup=changes.pop('backup',lambda release,snapshot:True),dependencies=changes.pop('dependencies',self.dependencies),queues=changes.pop('queues',lambda *args:empty),**changes)

    def test_real_result_checks_and_private_payloads_never_enter_receipts(self):
        report,_=self.run_probe()
        self.assertEqual(report['checks']['health']['level'],'ok')
        self.assertEqual(report['checks']['backup_integrity']['level'],'ok')
        self.assertEqual(report['checks']['served_assets']['level'],'ok')
        self.assertNotIn('PRIVATE_ARTICLE',json.dumps(report))
        self.assertNotIn(str(self.root),json.dumps(report))

    def test_wrong_instance_failed_scheduler_missing_checks_and_http_failure_are_critical(self):
        self.health['environment']='development'
        self.readiness['checks']['research_scheduler']='failed'
        report,_=self.run_probe(owner=lambda root:False)
        self.assertEqual(report['checks']['health']['level'],'critical')
        self.assertEqual(report['checks']['runtime.research_scheduler']['level'],'critical')
        self.assertEqual(report['checks']['process_identity']['level'],'critical')
        del self.readiness['checks']['schema_versions']
        self.assertEqual(self.run_probe()[0]['checks']['readiness']['level'],'critical')
        def unavailable(url, timeout): raise OSError('PRIVATE_ERROR')
        report,_=self.run_probe(http=unavailable)
        self.assertEqual(report['checks']['served_assets']['level'],'critical')
        self.assertNotIn('PRIVATE_ERROR',json.dumps(report))

    def test_escaped_config_and_manifest_cannot_probe_arbitrary_hosts_or_files(self):
        active=monitor.read_json(self.root/'active.json');active['host']='remote.example';self.write(self.root/'active.json',active)
        with self.assertRaises(ValueError): self.run_probe()
        active['host']='127.0.0.1';active['release_dir']=str(self.root.parent);self.write(self.root/'active.json',active)
        with self.assertRaises(ValueError): self.run_probe()

    def test_news_stale_errors_and_missing_sources_are_warnings(self):
        news=monitor.read_json(self.data/'procurement-news/cache.json')
        news['checked_at']=(self.now-timedelta(hours=3)).isoformat()
        news['sources'][monitor.SOURCES[0]]['error']='PRIVATE_ERROR'
        news['sources'][monitor.SOURCES[1]]=None
        news['sources'][monitor.SOURCES[2]]['last_success']=(self.now+timedelta(hours=2)).isoformat()
        self.write(self.data/'procurement-news/cache.json',news)
        report,_=self.run_probe()
        for name in ('news_task','news_source_1','news_source_2','news_source_3'): self.assertEqual(report['checks'][name]['level'],'warning')
        self.assertNotIn('PRIVATE_ERROR',json.dumps(report))

    def test_silent_task_backlog_and_failed_events_are_detected_even_when_readiness_is_ready(self):
        jobs={'research':{'pending':2,'failed':1,'oldestSeconds':5},'procurement':{'overdue':1,'oldestSeconds':301}}
        report,_=self.run_probe(queues=lambda *args:jobs)
        self.assertEqual(report['checks']['readiness']['level'],'ok')
        self.assertEqual(report['checks']['research_backlog']['level'],'critical')
        self.assertEqual(report['checks']['procurement_backlog']['level'],'critical')
        self.assertEqual(self.run_probe(queues=lambda *args:None)[0]['checks']['task_queues']['level'],'critical')

    def test_backup_integrity_is_rechecked_on_expiry_or_manifest_change_and_failure_is_critical(self):
        report,state=self.run_probe()
        def unexpected(*args): raise AssertionError('Cached verification should be reused')
        self.run_probe(state,backup=unexpected)
        state['backup']['verifiedAt']=(self.now-timedelta(hours=25)).isoformat()
        self.assertEqual(self.run_probe(state,backup=lambda *args:False)[0]['checks']['backup_integrity']['level'],'critical')
        metadata=monitor.read_json(self.snapshot/'manifest.json');metadata['created_at']=(self.now-timedelta(days=8)).isoformat();self.write(self.snapshot/'manifest.json',metadata)
        self.assertEqual(self.run_probe(state)[0]['checks']['backup_age']['level'],'critical')

    def test_log_cursor_retains_first_new_line_and_counts_errors_without_exporting_routes(self):
        log=self.root/'service-fixed.out.log';log.write_text('INFO: "GET /api/health HTTP/1.1" 200 OK\n',encoding='utf-8')
        _,cursor,_=monitor.log_sample(log,{},1024*1024)
        with log.open('a',encoding='utf-8') as stream:
            stream.write('INFO: "GET /api/private?private=PRIVATE_VALUE HTTP/1.1" 503 Fail\n')
        counts,_,baseline=monitor.log_sample(log,cursor,1024*1024)
        self.assertEqual(counts,{'requests':1,'serverErrors':1,'clientErrors':0});self.assertFalse(baseline)
        self.assertNotIn('PRIVATE_VALUE',json.dumps(counts))
        report,_=self.run_probe();self.assertEqual(report['checks']['api_errors']['level'],'warning')

    def test_warning_confirmation_critical_escalation_and_recovery_are_recorded(self):
        previous={};report={'checkedAt':self.now.isoformat(),'checks':{'backup_age':{'level':'warning'}}}
        for _ in range(2):
            previous,events=monitor.advance_alerts(report,previous,policy);self.assertEqual(events,[])
        previous,events=monitor.advance_alerts(report,previous,policy);self.assertEqual(events[0]['state'],'opened')
        report['checks']['backup_age']['level']='critical'
        previous,events=monitor.advance_alerts(report,previous,policy);self.assertEqual(events[0]['state'],'escalated')
        report['checks']['backup_age']['level']='ok'
        previous,events=monitor.advance_alerts(report,previous,policy);self.assertEqual(events[0]['state'],'recovered')
        report['checks']['backup_age']['level']='critical'
        _,events=monitor.advance_alerts(report,previous,policy);self.assertEqual(events[0]['state'],'opened')

    def test_dependency_findings_incomplete_stale_or_wrong_lock_receipts_do_not_pass(self):
        self.dependencies['count']=8
        self.assertEqual(self.run_probe()[0]['checks']['dependency_audit']['level'],'critical')
        self.dependencies['count']=0;self.dependencies['locks']='old'
        self.assertEqual(self.run_probe()[0]['checks']['dependency_audit']['level'],'critical')
        self.dependencies['locks']=auditor.lock_fingerprint(self.release);self.dependencies['checkedAt']=(self.now-timedelta(days=9)).isoformat()
        self.assertEqual(self.run_probe()[0]['checks']['dependency_audit']['level'],'warning')

    def test_audit_command_failure_produces_incomplete_receipt_without_private_stderr(self):
        output=Path(self.temporary.name)/'audit.json'
        with patch.object(auditor.subprocess,'run',return_value=subprocess.CompletedProcess([],2,b'{}',b'PRIVATE_ERROR')):
            receipt=auditor.audit(self.release,output)
        self.assertFalse(receipt['complete']);self.assertNotIn('PRIVATE_ERROR',output.read_text())

    def test_new_modules_unknown_checks_and_invalid_thresholds_cannot_skip_monitoring(self):
        rows=[{'id':name,'entry':name+'.tsx'} for name in policy['moduleChecks']]
        monitor.validate_contract(policy,rows)
        with self.assertRaises(ValueError): monitor.validate_contract(policy,rows+[{'id':'new','entry':'new.tsx'}])
        changed=json.loads(json.dumps(policy));changed['moduleChecks']['sales']=['invented']
        with self.assertRaises(ValueError): monitor.validate_contract(changed,rows)
        changed=json.loads(json.dumps(policy));changed['backupCriticalHours']=1
        with self.assertRaises(ValueError): monitor.validate_contract(changed,rows)

    def test_critical_to_warning_does_not_claim_recovery(self):
        report={'checkedAt':self.now.isoformat(),'checks':{'health':{'level':'critical'}}}
        previous,_=monitor.advance_alerts(report,{},policy)
        report['checks']['health']['level']='warning'
        previous,events=monitor.advance_alerts(report,previous,policy)
        self.assertTrue(previous['health']['active']);self.assertEqual(events,[])
        report['checks']['health']['level']='ok'
        _,events=monitor.advance_alerts(report,previous,policy)
        self.assertEqual(events[0]['state'],'recovered')

    def test_partial_log_is_revisited_without_persisting_private_text(self):
        log=self.root/'service-partial.out.log'
        log.write_bytes(b'INFO: "GET /api/private?PRIVATE_VALUE HTTP/1.1" ')
        counts,cursor,_=monitor.log_sample(log,{},1024)
        self.assertEqual(counts['requests'],0);self.assertEqual(cursor['offset'],0)
        with log.open('ab') as stream: stream.write(b'503 Fail\n')
        counts,cursor,_=monitor.log_sample(log,cursor,1024)
        self.assertEqual(counts['serverErrors'],1)
        self.assertNotIn('PRIVATE_VALUE',json.dumps(cursor))

    def test_corrupt_state_produces_fresh_critical_receipt(self):
        output=Path(self.temporary.name)/'reports';output.mkdir()
        (output/'state.json').write_text('PRIVATE_INVALID_JSON',encoding='utf-8')
        with patch('sys.argv',['monitor','--application-root',str(self.root),'--output',str(output)]), patch.object(monitor,'probe',side_effect=AssertionError('Do not probe with invalid state')):
            self.assertEqual(monitor.main(),2)
        self.assertEqual(monitor.read_json(output/'latest.json')['checks']['monitor_probe']['level'],'critical')
        self.assertNotIn('PRIVATE_INVALID_JSON',(output/'latest.json').read_text())

    def test_nonzero_empty_audits_fail_and_scope_ignores_omit_environment(self):
        output=Path(self.temporary.name)/'audit.json'
        npm_data={'vulnerabilities':{},'metadata':{'vulnerabilities':{'total':0},'dependencies':{'total':10}}}
        calls=[]
        def command(args,**kwargs):
            calls.append((args,kwargs))
            if 'audit' in args: return subprocess.CompletedProcess(args,1,json.dumps(npm_data).encode(),b'PRIVATE_ERROR')
            if 'export' in args: return subprocess.CompletedProcess(args,0,b'',b'')
            Path(args[args.index('--output')+1]).write_text(json.dumps({'dependencies':[{'name':'safe','version':'1','vulns':[]}]}))
            return subprocess.CompletedProcess(args,0,b'',b'')
        with patch.dict(auditor.os.environ,{'UV_NO_DEV':'1','NODE_ENV':'production','npm_config_omit':'dev'}), patch.object(auditor.subprocess,'run',side_effect=command):
            receipt=auditor.audit(self.release,output)
        self.assertFalse(receipt['complete'])
        self.assertIn('--include=dev',calls[0][0])
        self.assertNotIn('npm_config_omit',calls[0][1]['env'])
        npm_data['vulnerabilities']={'unsafe':{'severity':'high','via':['unsafe']}}
        def failed_python(args,**kwargs):
            result=command(args,**kwargs)
            return subprocess.CompletedProcess(args,1,result.stdout,result.stderr) if 'pip-audit' in args else result
        calls.clear()
        with patch.dict(auditor.os.environ,{'UV_NO_DEV':'1'}), patch.object(auditor.subprocess,'run',side_effect=failed_python):
            self.assertFalse(auditor.audit(self.release,output)['complete'])
        export=next(row for row in calls if 'export' in row[0])
        self.assertIn('--all-groups',export[0]);self.assertNotIn('UV_NO_DEV',export[1]['env'])
        npm_data['metadata']['dependencies']['total']=0
        with patch.object(auditor.subprocess,'run',return_value=subprocess.CompletedProcess([],0,json.dumps(npm_data).encode(),b'')):
            self.assertFalse(auditor.audit(self.release,output)['complete'])


if __name__ == '__main__': unittest.main()
