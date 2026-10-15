"""Personalization uses real account-owned PostgreSQL records; no model requests."""
import pytest
from contextlib import closing
from uuid import uuid4
from datetime import datetime, UTC
from psycopg.types.json import Jsonb
from api.personalization import PersonalizationStore
from api.database import Database
from api.postgres import transaction
from tests.test_ai_workspace import workspace, login, submit


def completed_run(settings,client,actor,store,text='我长期喜欢简洁中文',output='已了解'):
    receipt=submit(client,content=text,mode='chat')
    run_id=str(uuid4())
    snapshot=store.snapshot(actor_id=actor,mode='chat')
    with transaction(settings.database_url,write=True) as db:
        message=db.execute('SELECT id FROM conversation_messages WHERE conversation_id=%s',(receipt['conversation']['id'],)).fetchone()[0]
        now=datetime.now(UTC).isoformat()
        db.execute('''INSERT INTO task_runs(id,owner_id,input_message_id,conversation_id,status,started_at,ended_at,runtime_version,phase,output,personalization_snapshot)
            VALUES(%s,%s,%s,%s,'completed',%s,%s,'synthetic','ended',%s,%s)''',(run_id,actor,message,receipt['conversation']['id'],now,now,output,Jsonb(snapshot)))
    return run_id,receipt['conversation']['id']


def test_rule_api(workspace):
    settings,client,users=workspace
    login(client,'alice');actor=users[0]['id'];store=PersonalizationStore(settings.database_url,settings.data_dir)
    original=client.get('/api/personalization').json()
    assert original['memory_enabled'] and original['memory_count']==0
    saved=client.patch('/api/personalization',json={'revision':original['revision'],'instructions':'个人规则'}).json()
    assert saved['instructions']=='个人规则'
    assert client.patch('/api/personalization',json={'revision':original['revision'],'instructions':'stale'}).status_code==409
    assert client.patch('/api/personalization',json={'revision':saved['revision'],'memory_enabled':None}).status_code==422
    project=client.post('/api/projects',json={'title':'专用项目'}).json();path=f"/api/projects/{project['id']}/instructions"
    assert client.get(path).json()['effective_content']=='个人规则'
    assert store.snapshot(actor_id=actor,mode='chat')['instructions']==''
    assert store.snapshot(actor_id=actor,mode='work')['instructions']=='个人规则'
    assert client.put(path,json={'revision':0,'content':'  '}).status_code==422
    assert client.put(path,json={'revision':0,'content':'项目规则'}).status_code==200
    assert store.snapshot(actor_id=actor,mode='work',project_id=project['id'])['instructions']=='项目规则'
    assert client.put(path,json={'revision':0,'content':None}).status_code==409
    assert client.put(path,json={'revision':1,'content':None}).json()['effective_content']=='个人规则'
    for name in ('bob','test-admin'):
        login(client,name)
        assert client.get('/api/personalization').json()['instructions']==''
        assert client.get(path).status_code==404
        assert client.put(path,json={'revision':2,'content':'steal'}).status_code==404
    login(client,'alice')
    assert client.patch('/api/personalization',headers={'X-Workspace-Actor':users[1]['id']},json={'revision':saved['revision'],'instructions':'wrong account'}).status_code==401
    client.patch(f"/api/projects/{project['id']}",json={'revision':project['revision'],'title':project['title'],'removed':True})
    assert client.get(path).status_code==200
    assert client.put(path,json={'revision':2,'content':'change'}).status_code==403


def test_native_memories_are_read_only_and_account_isolated(workspace):
    settings,client,users=workspace
    login(client,'alice');actor=users[0]['id'];store=PersonalizationStore(settings.database_url,settings.data_dir)
    root=store.native_directory(actor,create=True)/'memories';root.mkdir()
    (root/'memory_summary.md').write_text('# Native memory\n\n偏好先结论后证据。',encoding='utf-8')
    assert client.get('/api/personalization').json()['memory_count']==1
    rows=client.get('/api/personalization/memories').json()['items']
    assert rows[0]['id']=='memory_summary.md' and '先结论' in rows[0]['content']
    for name in ('bob','test-admin'):
        login(client,name)
        assert client.get('/api/personalization/memories').json()['items']==[]
    login(client,'alice')
    assert client.get('/api/personalization/memories',headers={'X-Workspace-Actor':users[1]['id']}).status_code==401
    assert client.patch('/api/personalization/memories/memory_summary.md',json={'content':'overwrite','revision':0}).status_code==404
    assert client.delete('/api/personalization/memories/memory_summary.md').status_code==404
    assert (root/'memory_summary.md').read_bytes().decode('utf-8')==rows[0]['content']
    enabled=store.snapshot(actor_id=actor,mode='chat')
    assert enabled['memory_refs'][0]['file']=='memory_summary.md' and 'memories' not in enabled
    row=store.get(actor);store.update(actor,row['revision'],{'memory_enabled':False})
    disabled=store.snapshot(actor_id=actor,mode='chat')
    assert disabled['memory_refs']==[] and disabled['memory_epoch']>enabled['memory_epoch']
    assert store.memories(actor)['items']==rows
    row=store.get(actor);store.update(actor,row['revision'],{'memory_enabled':True})
    assert store.snapshot(actor_id=actor,mode='chat')['memory_refs']==enabled['memory_refs']


def test_native_initialization_documents_are_not_saved_memories(workspace):
    settings,client,users=workspace
    login(client,'alice');actor=users[0]['id'];store=PersonalizationStore(settings.database_url,settings.data_dir)
    root=store.native_directory(actor,create=True)/'memories';root.mkdir()
    summary="""v1

## User Profile

No durable user profile yet. No rollouts, raw memories, or ad-hoc notes (beyond the
extension instructions file) had been consolidated when this summary was generated.

## User preferences

- None recorded yet.

## General Tips

- None recorded yet.

## What's in Memory

No memories yet. This index will be populated as rollouts are consolidated into MEMORY.md,
skills/, and rollout_summaries/.
"""
    detail="""# Memory

No durable memories have been consolidated yet. No raw memories, rollout summaries, or
ad-hoc notes (beyond the extension instructions file) were present at build time, so there
is no evidence-based task-group content to record.

This file will be populated with `# Task Group:` blocks as rollouts are consolidated.
"""
    (root/'memory_summary.md').write_text(summary,encoding='utf-8')
    (root/'MEMORY.md').write_text(detail,encoding='utf-8')
    assert client.get('/api/personalization').json()['memory_count']==0
    assert client.get('/api/personalization/memories').json()['items']==[]
    assert store.snapshot(actor_id=actor,mode='chat')['memory_refs']==[]
    assert (root/'MEMORY.md').read_text(encoding='utf-8')==detail
    (root/'MEMORY.md').write_text(detail+'\n# Task Group: 沟通\n用户喜欢先结论后证据。',encoding='utf-8')
    assert client.get('/api/personalization').json()['memory_count']==1
    assert '用户喜欢' in client.get('/api/personalization/memories').json()['items'][0]['content']
    (root/'memory_summary.md').write_text(summary.replace('None recorded yet.','Prefer concise Chinese.'),encoding='utf-8')
    assert client.get('/api/personalization').json()['memory_count']==2


def test_legacy_memories_retained_without_new_injection_and_usage_kept(workspace):
    settings,client,users=workspace
    login(client,'alice');actor=users[0]['id'];store=PersonalizationStore(settings.database_url,settings.data_dir)
    run,conversation=completed_run(settings,client,actor,store)
    from hashlib import sha256
    with transaction(settings.database_url,write=True) as db:
        db.execute("INSERT INTO personal_memories(id,owner_id,content,content_hash) VALUES(%s,%s,%s,%s)",(str(uuid4()),actor,'旧版合成记忆',sha256('旧版合成记忆'.encode()).hexdigest()))
        db.execute("INSERT INTO memory_extractions(run_id,owner_id,memory_epoch,status,model_tokens) VALUES(%s,%s,0,'completed',17)",(run,actor))
    assert store.get(actor)['legacy_memory_count']==1 and store.memories(actor)['items']==[]
    assert store.snapshot(actor_id=actor,mode='chat')['memory_refs']==[]
    usage=Database(settings.database_url).ai_usage(actor_id=actor)
    assert usage['tokens']==17 and usage['chats']==1 and usage['work']==0
    assert client.get(f'/api/conversations/{conversation}/messages').status_code==200
    from api.operations import _table_evidence
    with transaction(settings.database_url) as db:
        assert {'personalizations','project_instructions','personal_memories','memory_suppressions','memory_extractions'}<=set(_table_evidence(db))


def test_native_memory_symlinks_and_large_files_rejected(workspace,tmp_path):
    settings,client,users=workspace
    login(client,'alice');actor=users[0]['id'];store=PersonalizationStore(settings.database_url,settings.data_dir)
    root=store.native_directory(actor,create=True)/'memories';root.mkdir()
    path=root/'memory_summary.md';path.write_bytes(b'a'*1048577)
    from api.database import WorkspaceConflictError
    with pytest.raises(WorkspaceConflictError,match='过大'):store.memories(actor)
    path.write_bytes(b'\xff')
    with pytest.raises(WorkspaceConflictError,match='无法读取'):store.memories(actor)
    assert store.get(actor)['memory_count']>0 and store.snapshot(actor_id=actor,mode='chat')['memory_refs']==[]
    path.unlink()
    outside=tmp_path/'outside.md';outside.write_text('other account')
    try:path.symlink_to(outside)
    except OSError:
        assert not path.exists()
    else:
        with pytest.raises(WorkspaceConflictError,match='links'):store.memories(actor)


def test_rule_files(workspace):
    from pathlib import Path
    from api.database import WorkspaceConflictError
    from api.operations import _references,_snapshot_sources
    settings,client,users=workspace
    login(client,'alice');actor=users[0]['id'];store=PersonalizationStore(settings.database_url,settings.data_dir)
    raw=Path('tests/fixtures/personalization-agents.md').read_bytes()
    content=raw.decode('utf-8')
    saved=store.update(actor,store.get(actor)['revision'],{'instructions':content})
    snapshot=store.snapshot(actor_id=actor,mode='work')
    path=settings.data_dir/snapshot['instruction_path']
    assert path.name=='AGENTS.md' and path.read_bytes()==raw
    assert saved['instructions']==content==snapshot['instructions']
    store.update(actor,saved['revision'],{'instructions':'# 新规则\n\n下一轮生效。'})
    assert path.read_bytes()==raw
    current=store.snapshot(actor_id=actor,mode='work')
    assert current['instruction_path']!=snapshot['instruction_path']
    assert current['instructions']=='# 新规则\n\n下一轮生效。'
    current_path=settings.data_dir/current['instruction_path']
    assert current_path in _snapshot_sources(settings)
    with transaction(settings.database_url) as db:
        assert current['instruction_path'] in _references(db,settings.data_dir)[0]
        columns={r[0] for r in db.execute("SELECT column_name FROM information_schema.columns WHERE table_name IN ('personalizations','project_instructions')")}
        assert 'instructions' not in columns and 'content' not in columns
    current_path.write_text('篡改',encoding='utf-8')
    with pytest.raises(WorkspaceConflictError,match='校验失败'): store.snapshot(actor_id=actor,mode='work')
    current_path.unlink()
    with pytest.raises(WorkspaceConflictError,match='缺失'): store.get(actor)
    assert store.snapshot(actor_id=actor,mode='chat')['instructions']==''


def test_rule_restore(workspace,tmp_path,second_pg):
    from pathlib import Path
    from api.settings import Settings
    from api.operations import create_snapshot,restore_snapshot,verify_snapshot
    settings,client,users=workspace
    login(client,'alice');actor=users[0]['id'];store=PersonalizationStore(settings.database_url,settings.data_dir)
    raw=Path('tests/fixtures/personalization-agents.md').read_bytes()
    store.update(actor,store.get(actor)['revision'],{'instructions':raw.decode('utf-8')})
    project=client.post('/api/projects',json={'title':'文件规则项目'}).json()
    store.save_project(actor,project['id'],0,'# 项目规则\n\n只整理已提供资料。')
    personal=store.snapshot(actor_id=actor,mode='work')
    project_snapshot=store.snapshot(actor_id=actor,mode='work',project_id=project['id'])
    import sqlite3
    native=store.native_directory(actor,create=True)
    (native/'memories').mkdir();(native/'state').mkdir()
    (native/'memories/memory_summary.md').write_bytes('# 原生记忆\n\n先看结论。'.encode('utf-8'))
    native_context=native/'contexts'/str(uuid4())
    with closing(sqlite3.connect(native/'state/state_5.sqlite')) as db, db:
        db.execute('CREATE TABLE threads(id text,rollout_path text,cwd text)')
        db.execute('INSERT INTO threads VALUES(?,?,?)',('synthetic',str(native_context/'home/session.jsonl'),str(native_context/'cwd')))
    project_snapshot=store.snapshot(actor_id=actor,mode='work',project_id=project['id'])
    backup=create_snapshot(settings,tmp_path/'snapshots')
    manifest=verify_snapshot(backup)
    assert {personal['instruction_path'],project_snapshot['instruction_path']}<=set(manifest['references'])
    target=Settings.from_data_dir(tmp_path/'restored',database_url=second_pg['migration_url'])
    restore_snapshot(target,backup)
    restored=PersonalizationStore(second_pg['url'],target.data_dir)
    assert (target.data_dir/personal['instruction_path']).read_bytes()==raw
    assert restored.get(actor)['instructions']==raw.decode('utf-8')
    assert restored.project(actor,project['id'])['content']=='# 项目规则\n\n只整理已提供资料。'
    assert restored.snapshot(actor_id=actor,mode='work',project_id=project['id'])==project_snapshot
    assert restored.memories(actor)['items'][0]['content']=='# 原生记忆\n\n先看结论。'
    relocated=restored.native_directory(actor)
    with closing(sqlite3.connect(relocated/'state/state_5.sqlite')) as db:
        paths=db.execute('SELECT rollout_path,cwd FROM threads').fetchone()
    assert all(Path(value).is_relative_to(relocated) for value in paths)
