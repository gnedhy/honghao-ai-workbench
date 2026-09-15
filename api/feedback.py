"""Account-scoped feedback and per-reader notifications, stored with the application DB."""
import base64
import binascii
from datetime import UTC, datetime
from io import BytesIO
from typing import Annotated, Literal
from uuid import uuid4
import warnings

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from psycopg.rows import dict_row

from api.postgres import transaction


class FeedbackCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["问题反馈", "功能建议"]
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=5000)]
    context: Annotated[str, StringConstraints(max_length=300)] = ""
    version: Annotated[str, StringConstraints(max_length=80)] = ""
    image: Annotated[str, StringConstraints(max_length=7_000_000)] | None = None


class FeedbackRead(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)


class FeedbackUpdate(FeedbackRead):
    status: Literal["待处理", "处理中", "已处理"]
    result: Annotated[str, StringConstraints(strip_whitespace=True, max_length=5000)] = ""


def decode_image(value):
    if value is None:
        return None, None
    from PIL import Image, UnidentifiedImageError
    try:
        header, payload = value.split(",", 1)
        allowed = {"data:image/png;base64": "PNG", "data:image/jpeg;base64": "JPEG", "data:image/webp;base64": "WEBP"}
        if header not in allowed:
            raise ValueError()
        data = base64.b64decode(payload, validate=True)
        if not data or len(data) > 5 * 1024 * 1024:
            raise ValueError()
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as image:
                if image.format != allowed[header] or image.width * image.height > 20_000_000:
                    raise ValueError()
                image.verify()
            with Image.open(BytesIO(data)) as image:
                image.load()
        return data, header[5:-7]
    except (ValueError, OSError, binascii.Error, UnidentifiedImageError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(422, "截图须为有效的 PNG、JPEG 或 WEBP，且不超过 5 MB / 2000 万像素") from None


class FeedbackStore:
    def __init__(self, database_url: str):
        self.database_url = database_url

    def listing(self, user):
        with transaction(self.database_url) as connection, connection.cursor(row_factory=dict_row) as db:
            rows = db.execute("""SELECT f.id, f.owner_id, f.owner_name, f.kind, f.text, f.context, f.version,
                f.created_at, f.status, f.result, f.result_at, f.revision, f.result_revision,
                f.image IS NOT NULL AS has_image, COALESCE(r.revision, 0) AS read_revision
                FROM feedback f LEFT JOIN feedback_reads r ON r.feedback_id=f.id AND r.user_id=%s
                WHERE %s OR f.owner_id=%s ORDER BY f.created_at DESC, f._order DESC""",
                (user['id'], user['is_system_admin'], user['id'])).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            read = item.pop('read_revision')
            result_revision = item.pop('result_revision')
            item['unread'] = (result_revision > read if item['owner_id'] == user['id'] else read < 1)
            item['has_image'] = bool(item['has_image'])
            result.append(item)
        return result

    def accessible(self, db, feedback_id, user):
        row = db.execute("SELECT * FROM feedback WHERE id=%s", (feedback_id,)).fetchone()
        if row is None or (not user['is_system_admin'] and row['owner_id'] != user['id']):
            raise HTTPException(404, "反馈不存在")
        return row

    def unread_count(self, user):
        with transaction(self.database_url) as db:
            return db.execute("""SELECT COUNT(*) FROM feedback f
                LEFT JOIN feedback_reads r ON r.feedback_id=f.id AND r.user_id=%s
                WHERE (f.owner_id=%s AND f.result_revision>COALESCE(r.revision,0))
                   OR (%s AND f.owner_id<>%s AND COALESCE(r.revision,0)<1)""",
                (user['id'],user['id'],user['is_system_admin'],user['id'])).fetchone()[0]


def create_feedback_router(store, current_user):
    router = APIRouter(prefix="/api/feedback")

    def writer(request):
        origin = request.headers.get('origin')
        if request.headers.get('sec-fetch-site') == 'cross-site' or (origin and origin != str(request.base_url).rstrip('/')):
            raise HTTPException(403, "不允许跨站操作")
        return current_user(request)

    @router.get("")
    def listing(request: Request):
        return store.listing(current_user(request))

    @router.get("/unread")
    def unread(request: Request):
        return {"count": store.unread_count(current_user(request))}

    @router.post("")
    def create(payload: FeedbackCreate, request: Request):
        user = writer(request)
        image, mime = decode_image(payload.image)
        feedback_id = str(uuid4())
        with transaction(store.database_url, write=True) as connection, connection.cursor(row_factory=dict_row) as db:
            user = writer(request)
            db.execute("""INSERT INTO feedback (id,owner_id,owner_name,kind,text,context,version,created_at,image,image_mime)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (feedback_id,user['id'],user['display_name'],payload.kind,payload.text,
                payload.context,payload.version,datetime.now(UTC).isoformat(),image,mime))
        return next(item for item in store.listing(user) if item['id'] == feedback_id)

    @router.get("/{feedback_id}/image")
    def image(feedback_id: str, request: Request):
        user = current_user(request)
        with transaction(store.database_url) as connection, connection.cursor(row_factory=dict_row) as db:
            row = store.accessible(db, feedback_id, user)
            if row['image'] is None:
                raise HTTPException(404, "没有截图")
            return Response(row['image'], media_type=row['image_mime'], headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    @router.post("/{feedback_id}/read")
    def read(feedback_id: str, payload: FeedbackRead, request: Request):
        with transaction(store.database_url, write=True) as connection, connection.cursor(row_factory=dict_row) as db:
            user = writer(request)
            row = store.accessible(db, feedback_id, user)
            if payload.revision > row['revision']:
                raise HTTPException(409, "反馈版本已变化，请刷新")
            db.execute("""INSERT INTO feedback_reads (feedback_id,user_id,revision) VALUES (%s,%s,%s) ON CONFLICT(feedback_id,user_id)
                DO UPDATE SET revision=GREATEST(feedback_reads.revision,excluded.revision)""", (feedback_id,user['id'],payload.revision))
        return {"ok": True}

    @router.patch("/{feedback_id}")
    def update(feedback_id: str, payload: FeedbackUpdate, request: Request):
        with transaction(store.database_url, write=True) as connection, connection.cursor(row_factory=dict_row) as db:
            user = writer(request)
            if not user['is_system_admin']:
                raise HTTPException(403, "仅管理员可处理反馈")
            if payload.status == '已处理' and not payload.result:
                raise HTTPException(422, "请填写处理结果")
            if payload.status != '已处理' and payload.result:
                raise HTTPException(422, "填写处理结果后，请将状态设为已处理")
            row = store.accessible(db, feedback_id, user)
            if row['revision'] != payload.revision:
                raise HTTPException(409, "反馈已被其他管理员更新，请刷新后再处理")
            if row['status'] != payload.status or row['result'] != payload.result:
                revision = row['revision'] + 1
                complete = payload.status == '已处理'
                db.execute("""UPDATE feedback SET status=%s,result=%s,revision=%s,result_at=%s,result_revision=%s WHERE id=%s""",
                    (payload.status,payload.result,revision,datetime.now(UTC).isoformat() if complete else row['result_at'],
                     revision if complete and user['id'] != row['owner_id'] else row['result_revision'],feedback_id))
        return next(item for item in store.listing(user) if item['id'] == feedback_id)

    return router
