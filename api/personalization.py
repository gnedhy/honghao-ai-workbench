"""Account-owned instructions and memories; runtime writes use epoch fencing."""
from uuid import UUID, uuid4
from pathlib import Path
import os
from datetime import UTC, datetime
from hashlib import sha256
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from api.database import _actor, _one, _revision, WorkspaceAccessError, WorkspaceNotFoundError, WorkspaceConflictError
from api.postgres import transaction


# Exact empty documents observed in Harness 0.160.0; never infer emptiness from keywords in real memories.
_EMPTY_NATIVE_DOCUMENTS = {
    'memory_summary.md': 'ffc5737a4e8d67beb69672023126d4760489b54f50e35b7ffb797d1fba1879bd',
    'MEMORY.md': '554b84ec62c5adbdeb783fc576d02b92cafd5d1db00c770f85c89f0a6b724eab',
}


def instruction_file(data_dir, relative, digest, actor_id, scope):
    """Resolve only immutable files inside the account's own instruction namespace."""
    root=Path(data_dir).resolve()
    parts=Path(relative).parts
    if len(parts)!=6 or parts[:2]!=('controlled-work','instructions') or parts[2]!=UUID(actor_id).hex or parts[3]!=('personal' if scope=='personal' else UUID(scope).hex) or parts[5]!='AGENTS.md':
        raise ValueError('Instruction path does not match its owner and scope')
    if UUID(parts[2]).hex!=parts[2] or UUID(parts[4]).hex!=parts[4]:
        raise ValueError('Invalid instruction namespace')
    path=root.joinpath(*parts)
    for item in (path,*path.parents):
        if item==root.parent: break
        if item.is_symlink() or item.is_junction(): raise ValueError('Instruction links are forbidden')
    if not path.resolve().is_relative_to(root): raise ValueError('Instruction path escapes data directory')
    raw=path.read_bytes()
    if len(raw)>64000 or sha256(raw).hexdigest()!=digest: raise ValueError('Instruction file hash mismatch')
    return raw.decode('utf-8')


class PersonalizationStore:
    def __init__(self, url, data_dir):
        self.url = url
        self.data_dir = Path(data_dir)

    def native_directory(self, actor_id, *, create=False):
        directory = self.data_dir.resolve()
        for part in ('controlled-work', 'native', UUID(actor_id).hex):
            directory = directory / part
            if directory.is_symlink() or directory.is_junction():
                raise WorkspaceConflictError('Native memory links are forbidden')
            if create:
                directory.mkdir(mode=0o700, exist_ok=True)
        return directory

    def _read(self, relative, digest, actor_id, scope):
        if relative is None: return ''
        try:
            return instruction_file(self.data_dir,relative,digest,actor_id,scope)
        except (OSError,ValueError) as error:
            raise WorkspaceConflictError('指令文件缺失或校验失败，请检查受控存储后重试') from error

    def _write(self, actor_id, scope, content):
        if len(content)>16000: raise WorkspaceConflictError('Instructions exceed 16000 characters')
        actor_id=UUID(actor_id).hex;scope='personal' if scope=='personal' else UUID(scope).hex
        relative=f'controlled-work/instructions/{actor_id}/{scope}/{uuid4().hex}/AGENTS.md'
        root=self.data_dir.resolve()
        path=root/relative
        directory=root
        for part in Path(relative).parts[:-1]:
            directory=directory/part
            if directory.is_symlink() or directory.is_junction(): raise WorkspaceConflictError('Instruction links are forbidden')
            directory.mkdir(mode=0o700,exist_ok=True)
        raw=content.encode('utf-8')
        # Immutable revision first; a rolled-back DB write can only leave an unreferenced file.
        with path.open('xb') as stream:
            if os.name!='nt': os.chmod(path,0o600)
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        return relative,sha256(raw).hexdigest()

    def _settings(self, db, actor_id):
        _actor(db, actor_id)
        db.execute('INSERT INTO personalizations(owner_id,memory_since) SELECT id,created_at::timestamptz FROM identity_users WHERE id=%s ON CONFLICT DO NOTHING', (actor_id,))
        return _one(db, 'SELECT * FROM personalizations WHERE owner_id=%s FOR UPDATE', (actor_id,))

    def _bump(self, db, actor_id):
        db.execute('UPDATE personalizations SET memory_epoch=memory_epoch+1 WHERE owner_id=%s', (actor_id,))
        db.execute("UPDATE memory_extractions SET status='discarded' WHERE owner_id=%s AND status='pending'", (actor_id,))

    def get(self, actor_id):
        with transaction(self.url, write=True) as db:
            row = self._settings(db, actor_id)
            legacy_count = db.execute('SELECT count(*) FROM personal_memories WHERE owner_id=%s', (actor_id,)).fetchone()[0]
            try: count=len(self.memories(actor_id)['items'])
            except WorkspaceConflictError: count=1  # Keep the switch and reset accessible when an optional memory file needs repair.
            return {key: row[key] for key in ('revision','memory_enabled','updated_at')} | {'memory_count':count,'legacy_memory_count':legacy_count,'instructions':self._read(row['instructions_path'],row['instructions_sha256'],actor_id,'personal')}

    def update(self, actor_id, revision, changes):
        with transaction(self.url, write=True) as db:
            row = self._settings(db, actor_id)
            _revision(row, revision)
            if not changes or not changes.keys() <= {'memory_enabled','instructions'}:
                raise WorkspaceConflictError('No valid changes supplied')
            if 'memory_enabled' in changes and changes['memory_enabled'] != row['memory_enabled']:
                self._bump(db, actor_id)
                db.execute('UPDATE personalizations SET memory_since=now() WHERE owner_id=%s', (actor_id,))
            changes=changes.copy()
            if 'instructions' in changes:
                changes['instructions_path'],changes['instructions_sha256']=self._write(actor_id,'personal',changes.pop('instructions'))
            db.execute('UPDATE personalizations SET '+','.join(key+'=%s' for key in changes)+',revision=revision+1,updated_at=now() WHERE owner_id=%s', (*changes.values(),actor_id))
            return self.get(actor_id)

    def _project(self, db, actor_id, project_id, write=False):
        _actor(db, actor_id)
        row = _one(db,'SELECT * FROM projects WHERE id=%s AND owner_id=%s',(project_id,actor_id))
        if not row:
            raise WorkspaceNotFoundError('Project not found')
        if write and row['removed']:
            raise WorkspaceAccessError('Removed project is read-only')
        return row

    def project(self, actor_id, project_id, connection=None):
        with transaction(self.url, write=True, connection=connection) as db:
            self._project(db,actor_id,project_id)
            settings = self._settings(db,actor_id)
            row = _one(db,'SELECT revision,content_path,content_sha256,updated_at FROM project_instructions WHERE project_id=%s',(project_id,)) or {'revision':0,'content_path':None,'content_sha256':None,'updated_at':None}
            content=self._read(row['content_path'],row['content_sha256'],actor_id,project_id) if row['content_path'] is not None else None
            return {'revision':row['revision'],'updated_at':row['updated_at'],'content':content,'source':'project' if content is not None else 'personal',
                'effective_content':content if content is not None else self._read(settings['instructions_path'],settings['instructions_sha256'],actor_id,'personal')}

    def save_project(self, actor_id, project_id, revision, content):
        with transaction(self.url, write=True) as db:
            self._settings(db,actor_id)
            self._project(db,actor_id,project_id,write=True)
            row = _one(db,'SELECT revision FROM project_instructions WHERE project_id=%s',(project_id,)) or {'revision':0}
            _revision(row,revision)
            if content is not None and not content.strip(): raise WorkspaceConflictError('Project instructions must not be empty')
            relative,digest=self._write(actor_id,project_id,content) if content is not None else (None,None)
            db.execute('INSERT INTO project_instructions(project_id,content_path,content_sha256) VALUES(%s,%s,%s) ON CONFLICT(project_id) DO UPDATE SET content_path=EXCLUDED.content_path,content_sha256=EXCLUDED.content_sha256,revision=project_instructions.revision+1,updated_at=now()', (project_id,relative,digest))
            return self.project(actor_id,project_id)

    def memories(self, actor_id):
        with transaction(self.url) as db:
            _actor(db,actor_id)
        root = self.native_directory(actor_id) / 'memories'
        if root.is_symlink() or root.is_junction():
            raise WorkspaceConflictError('Native memory links are forbidden')
        items = []
        for name in ('memory_summary.md', 'MEMORY.md'):
            path = root / name
            if path.is_symlink() or path.is_junction():
                raise WorkspaceConflictError('Native memory links are forbidden')
            if not path.exists():
                continue
            try:
                fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_BINARY',0))
                with os.fdopen(fd,'rb') as stream:
                    raw=stream.read(1048577)
                    updated=os.fstat(stream.fileno()).st_mtime
                content=raw.decode('utf-8')
            except (OSError,UnicodeError) as error:
                raise WorkspaceConflictError('原生记忆暂时无法读取，请稍后重试') from error
            if len(raw) > 1048576:
                raise WorkspaceConflictError('原生记忆文件过大，暂时无法显示')
            if content.strip() and sha256(' '.join(content.split()).encode()).hexdigest() != _EMPTY_NATIVE_DOCUMENTS[name]:
                items.append({'id':name,'content':content,'revision':0,'updated_at':datetime.fromtimestamp(updated,UTC).isoformat(),
                              'source_conversation_id':None,'source_title':None})
        return {'items':items}

    def snapshot(self, *, actor_id, mode, project_id=None, connection=None):
        with transaction(self.url, write=True, connection=connection) as db:
            row=self._settings(db,actor_id)
            instructions, revision, source = '',0,'none'
            relative,digest,scope=None,None,'personal'
            if mode=='work':
                relative,digest,revision,source=row['instructions_path'],row['instructions_sha256'],row['revision'],'personal'
                if project_id:
                    self._project(db,actor_id,project_id)
                    project=_one(db,'SELECT * FROM project_instructions WHERE project_id=%s',(project_id,))
                    if project and project['content_path'] is not None:
                        relative,digest,revision,source,scope=project['content_path'],project['content_sha256'],project['revision'],'project',project_id
                instructions=self._read(relative,digest,actor_id,scope)
            try: refs=[{'file':item['id'],'sha256':sha256(item['content'].encode()).hexdigest()} for item in self.memories(actor_id)['items']] if row['memory_enabled'] else []
            except WorkspaceConflictError: refs=[]
            return {'instruction_source':source,'instruction_revision':revision,'instructions':instructions,'instruction_path':relative,'instruction_sha256':digest,'instruction_scope':scope,'memory_refs':refs,'memory_epoch':row['memory_epoch'],'memory_enabled':row['memory_enabled']}



class SettingsUpdate(BaseModel):
    model_config=ConfigDict(extra='forbid')
    revision:int=Field(ge=1)
    memory_enabled:bool|None=None
    instructions:str|None=Field(default=None,max_length=16000)

class InstructionsUpdate(BaseModel):
    model_config=ConfigDict(extra='forbid')
    revision:int=Field(ge=0)
    content:str|None=Field(max_length=16000)
    @field_validator('content')
    @classmethod
    def nonblank(cls,value):
        if value is not None and not value.strip(): raise ValueError('Instructions must not be empty; use null to restore personal instructions')
        return value


def create_personalization_router(store,current_user,reset_memory):
    router=APIRouter()
    @router.get('/api/personalization')
    def get(request:Request): return store.get(current_user(request)['id'])
    @router.patch('/api/personalization')
    def update(request:Request,body:SettingsUpdate):
        values=body.model_dump(exclude={'revision'},exclude_unset=True)
        if not values or any(value is None for value in values.values()): raise HTTPException(422,'Invalid empty settings')
        return store.update(current_user(request)['id'],body.revision,values)
    @router.get('/api/projects/{project_id}/instructions')
    def project(request:Request,project_id:str): return store.project(current_user(request)['id'],project_id)
    @router.put('/api/projects/{project_id}/instructions')
    def project_update(request:Request,project_id:str,body:InstructionsUpdate): return store.save_project(current_user(request)['id'],project_id,body.revision,body.content)
    @router.get('/api/personalization/memories')
    def memories(request:Request): return store.memories(current_user(request)['id'])
    @router.delete('/api/personalization/memories',status_code=204)
    def clear(request:Request):
        reset_memory(current_user(request)['id'])
        return Response(status_code=204)
    return router
