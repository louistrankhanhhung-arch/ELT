from pathlib import Path
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from random import randint
from datetime import datetime, timezone, timedelta
from typing import List, Literal, Optional
import hashlib
import hmac
import json
import os
from contextlib import closing
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import urlopen
from uuid import uuid4
import sqlite3

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:
    psycopg = None
    dict_row = None

DB_PATH = "elt_runtime.db"
DATABASE_URL = os.getenv("DATABASE_URL")
USE_POSTGRES = bool(DATABASE_URL)
SESSION_TTL_HOURS = 2
TEACHER_ACCESS_TOKEN = os.getenv("TEACHER_ACCESS_TOKEN", "")
ROSTER = json.loads(os.getenv("CLASS_ROSTER_JSON", "{}"))


teacher_bearer = HTTPBearer(auto_error=False)


def require_teacher(credentials: Optional[HTTPAuthorizationCredentials] = Depends(teacher_bearer)):
    if not TEACHER_ACCESS_TOKEN:
        return
    supplied = credentials.credentials if credentials else ""
    if not hmac.compare_digest(supplied.encode(), TEACHER_ACCESS_TOKEN.encode()):
        raise HTTPException(status_code=401, detail="Teacher authentication required")


app = FastAPI(title="ELT Runtime API v0.3 DB")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://rootenglishhouse.com",
        "https://www.rootenglishhouse.com",
        "https://louistrankhanhhung-arch.github.io",
        "http://localhost:5500",
        "http://127.0.0.1:5500",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StartSessionRequest(BaseModel):
    lesson_id: str
    lesson_path: str
    total_blocks: int
    current_block_index: int = 0


class JoinSessionRequest(BaseModel):
    student_name: str = ""
    roster_code: Optional[str] = None

class EventRequest(BaseModel):
    student_id: str
    block_index: int
    block_id: str
    event_type: str


class MediaConfig(BaseModel):
    type: Literal["youtube", "audio", "image", "text"]
    src: Optional[str] = None
    content: Optional[str] = None
    title: Optional[str] = None
    alt: Optional[str] = None
    caption: Optional[str] = None
    start: Optional[int] = None
    captions: bool = False
    autoplay: bool = False
    loop: bool = False
    preload: Optional[str] = "metadata"


class H5PActivityConfig(BaseModel):
    embed_url: str
    title: Optional[str] = None
    aria_label: Optional[str] = None
    height: int = 720
    allow_fullscreen: bool = True
    allow: Optional[str] = None


class MediaActivityLayout(BaseModel):
    media_width: int = 44
    gap: int = 24
    sticky_top: int = 16
    max_width: int = 1500


class MediaActivityConfig(BaseModel):
    title: Optional[str] = None
    instructions: Optional[str] = None
    media: Optional[MediaConfig] = None
    activity: Optional[H5PActivityConfig] = None
    layout: MediaActivityLayout = MediaActivityLayout()

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def parse_iso(value: str):
    if not value:
        return None

    return datetime.fromisoformat(value)

def db():
    if USE_POSTGRES:
        if psycopg is None:
            raise RuntimeError("psycopg is not installed")

        return psycopg.connect(
            DATABASE_URL,
            row_factory=dict_row,
        )

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def sql(query: str) -> str:
    if USE_POSTGRES:
        return query.replace("?", "%s")

    return query

def init_db():
    conn = db()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            pin TEXT PRIMARY KEY,
            lesson_id TEXT NOT NULL,
            lesson_path TEXT NOT NULL,
            total_blocks INTEGER NOT NULL,
            current_block_index INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            expires_at TEXT,
            ended_at TEXT
        )
    """)

    # Migration for existing DBs created before auto-expiry existed.
    if USE_POSTGRES:
        cur.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at TEXT")
        cur.execute("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ended_at TEXT")
    else:
        cur.execute("PRAGMA table_info(sessions)")
        columns = {row["name"] for row in cur.fetchall()}

        if "expires_at" not in columns:
            cur.execute("ALTER TABLE sessions ADD COLUMN expires_at TEXT")

        if "ended_at" not in columns:
            cur.execute("ALTER TABLE sessions ADD COLUMN ended_at TEXT")

    cur.execute("""
    CREATE TABLE IF NOT EXISTS session_students (
            student_id TEXT PRIMARY KEY,
            pin TEXT NOT NULL,
            student_name TEXT NOT NULL,
            joined_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            FOREIGN KEY(pin) REFERENCES sessions(pin)
        )
    """)

    if USE_POSTGRES:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id SERIAL PRIMARY KEY,
                pin TEXT NOT NULL,
                student_id TEXT NOT NULL,
                block_index INTEGER NOT NULL,
                block_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(pin) REFERENCES sessions(pin)
            )
        """)
    else:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pin TEXT NOT NULL,
                student_id TEXT NOT NULL,
                block_index INTEGER NOT NULL,
                block_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(pin) REFERENCES sessions(pin)
            )
        """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS session_display_modes (
            pin TEXT PRIMARY KEY REFERENCES sessions(pin),
            mode TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS imported_slide_pages (
            deck_id TEXT NOT NULL,
            page_number INTEGER NOT NULL,
            image BYTEA NOT NULL,
            PRIMARY KEY (deck_id, page_number)
        )
    """)
    conn.commit()
    conn.close()


@app.on_event("startup")
def startup():
    init_db()


def generate_pin() -> str:
    conn = db()
    cur = conn.cursor()

    for _ in range(20):
        pin = str(randint(1000, 9999))
        cur.execute(sql("SELECT pin FROM sessions WHERE pin = ?"), (pin,))
        if not cur.fetchone():
            conn.close()
            return pin

    conn.close()
    raise RuntimeError("Could not generate unique PIN")


def get_session(pin: str):
    conn = db()
    cur = conn.cursor()

    cur.execute(sql("SELECT * FROM sessions WHERE pin = ?"), (pin,))
    session = cur.fetchone()

    if not session:
        conn.close()
        return None

    cur.execute(
        sql("SELECT * FROM session_students WHERE pin = ? ORDER BY joined_at ASC"),
        (pin,)
    )
    students = [dict(row) for row in cur.fetchall()]

    cur.execute(
        sql("SELECT * FROM events WHERE pin = ? ORDER BY created_at ASC"),
        (pin,)
    )
    events = [dict(row) for row in cur.fetchall()]
    cur.execute(sql("SELECT mode FROM session_display_modes WHERE pin = ?"), (pin,))
    display = cur.fetchone()

    conn.close()

    data = dict(session)
    data["students"] = students
    data["events"] = events
    data["display_mode"] = display["mode"] if display else "follow"
    return data

def update_session_status(pin: str, status: str):
    conn = db()
    cur = conn.cursor()

    cur.execute(
        sql("UPDATE sessions SET status = ?, ended_at = ? WHERE pin = ?"),
        (status, now_iso(), pin)
    )

    conn.commit()
    conn.close()


def apply_session_expiry(session):
    if not session:
        return None

    if session["status"] != "active":
        return session

    expires_at = session.get("expires_at")

    # Backward compatibility for old rows without expires_at.
    if not expires_at:
        created_at = parse_iso(session["created_at"])
        expires_at_dt = created_at + timedelta(hours=SESSION_TTL_HOURS)
    else:
        expires_at_dt = parse_iso(expires_at)

    if datetime.now(timezone.utc) >= expires_at_dt:
        update_session_status(session["pin"], "expired")
        session = get_session(session["pin"])

    return session


def require_active_session(pin: str):
    session = get_session(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session = apply_session_expiry(session)

    if session["status"] != "active":
        raise HTTPException(
            status_code=409,
            detail=f"Session is {session['status']}"
        )

    return session


@app.post("/api/media-activity/validate")
def validate_media_activity(payload: MediaActivityConfig):
    """
    Validate a media-activity JSON config before publishing it.
    The player itself remains static and fetches the JSON through ?data=...
    """
    if payload.media:
        if payload.media.type in {"youtube", "audio", "image"} and not payload.media.src:
            raise HTTPException(
                status_code=422,
                detail=f"media.src is required for media.type={payload.media.type}",
            )

        if payload.media.type == "text" and payload.media.content is None:
            raise HTTPException(
                status_code=422,
                detail="media.content is required for media.type=text",
            )

    if not payload.media and not payload.activity:
        raise HTTPException(
            status_code=422,
            detail="At least one of media or activity is required",
        )

    return {
        "ok": True,
        "config": payload.model_dump(),
    }


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "ELT Runtime API",
        "db": "postgres" if USE_POSTGRES else "sqlite",
    }


@app.post("/api/sessions/start", dependencies=[Depends(require_teacher)])
def start_session(payload: StartSessionRequest):
    pin = generate_pin()
    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(hours=SESSION_TTL_HOURS)

    conn = db()
    cur = conn.cursor()

    cur.execute(sql("""
        INSERT INTO sessions (
            pin, lesson_id, lesson_path, total_blocks,
            current_block_index, status, created_at, expires_at, ended_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """), (
        pin,
        payload.lesson_id,
        payload.lesson_path,
        payload.total_blocks,
        payload.current_block_index,
        "active",
        created_at.isoformat(),
        expires_at.isoformat(),
        None,
    ))

    conn.commit()
    conn.close()

    return get_session(pin)


@app.get("/api/sessions/{pin}/state")
def get_session_state(pin: str, credentials: Optional[HTTPAuthorizationCredentials] = Depends(teacher_bearer)):
    session = get_session(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session = apply_session_expiry(session)
    if TEACHER_ACCESS_TOKEN:
        try:
            require_teacher(credentials)
        except HTTPException:
            session.pop("students", None)
            session.pop("events", None)
    return session


@app.post("/api/sessions/{pin}/join")
def join_session(pin: str, payload: JoinSessionRequest):
    require_active_session(pin)
    student_name = payload.student_name.strip()
    student_id = f"{pin}-{uuid4().hex}"
    if TEACHER_ACCESS_TOKEN:
        member = ROSTER.get(payload.roster_code or "")
        if not member:
            raise HTTPException(status_code=403, detail="Invalid roster code")
        student_name = member["name"]
        member_key = f"{pin}:{member['id']}".encode()
        student_id = f"{pin}-{hmac.new(TEACHER_ACCESS_TOKEN.encode(), member_key, hashlib.sha256).hexdigest()}"
    if not student_name:
        raise HTTPException(status_code=422, detail="Student name required")

    conn = db()
    cur = conn.cursor()

    student = {
        "student_id": student_id,
        "pin": pin,
        "student_name": student_name,
        "joined_at": now_iso(),
        "last_seen_at": now_iso(),
    }

    cur.execute(sql("""
        INSERT INTO session_students (
            student_id, pin, student_name, joined_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(student_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    """), (
        student["student_id"],
        student["pin"],
        student["student_name"],
        student["joined_at"],
        student["last_seen_at"],
    ))

    conn.commit()
    conn.close()

    return {
        "pin": pin,
        "student": student,
        "session": get_session_state(pin, None),
    }


class DisplayModeRequest(BaseModel):
    mode: Literal["focus", "follow", "interact"]


@app.post("/api/sessions/{pin}/mode", dependencies=[Depends(require_teacher)])
def set_display_mode(pin: str, payload: DisplayModeRequest):
    require_active_session(pin)
    with closing(db()) as conn:
        conn.cursor().execute(sql("""
            INSERT INTO session_display_modes (pin, mode) VALUES (?, ?)
            ON CONFLICT(pin) DO UPDATE SET mode = excluded.mode
        """), (pin, payload.mode))
        conn.commit()
    return {"display_mode": payload.mode}


@app.post("/api/sessions/{pin}/next", dependencies=[Depends(require_teacher)])
def next_block(pin: str):
    session = require_active_session(pin)

    next_index = min(
        session["current_block_index"] + 1,
        session["total_blocks"] - 1
    )

    conn = db()
    cur = conn.cursor()
    cur.execute(
        sql("UPDATE sessions SET current_block_index = ? WHERE pin = ?"),
        (next_index, pin)
    )
    conn.commit()
    conn.close()

    return get_session(pin)


@app.post("/api/sessions/{pin}/previous", dependencies=[Depends(require_teacher)])
def previous_block(pin: str):
    session = require_active_session(pin)

    prev_index = max(session["current_block_index"] - 1, 0)

    conn = db()
    cur = conn.cursor()
    cur.execute(
        sql("UPDATE sessions SET current_block_index = ? WHERE pin = ?"),
        (prev_index, pin)
    )
    conn.commit()
    conn.close()

    return get_session(pin)


@app.post("/api/sessions/{pin}/block/{index}", dependencies=[Depends(require_teacher)])
def set_block(pin: str, index: int):
    session = require_active_session(pin)

    if index < 0 or index >= session["total_blocks"]:
        raise HTTPException(status_code=400, detail="Invalid block index")

    conn = db()
    cur = conn.cursor()
    cur.execute(
        sql("UPDATE sessions SET current_block_index = ? WHERE pin = ?"),
        (index, pin)
    )
    conn.commit()
    conn.close()

    return get_session(pin)

@app.post("/api/sessions/{pin}/events")
def log_event(pin: str, payload: EventRequest):
    session = require_active_session(pin)
    if TEACHER_ACCESS_TOKEN and not any(
        student["student_id"] == payload.student_id for student in session["students"]
    ):
        raise HTTPException(status_code=403, detail="Student is not in this session")

    conn = db()
    cur = conn.cursor()

    cur.execute(sql("""
        INSERT INTO events (
            pin, student_id, block_index, block_id, event_type, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
    """), (
        pin,
        payload.student_id,
        payload.block_index,
        payload.block_id,
        payload.event_type,
        now_iso(),
    ))

    conn.commit()
    conn.close()

    return {"ok": True}


@app.post("/api/sessions/{pin}/end", dependencies=[Depends(require_teacher)])
def end_session(pin: str):
    session = get_session(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    conn = db()
    cur = conn.cursor()
    cur.execute(
        sql("UPDATE sessions SET status = ?, ended_at = ? WHERE pin = ?"),
        ("ended", now_iso(), pin)
    )
    conn.commit()
    conn.close()

    return get_session(pin)




class SlidesImportRequest(BaseModel):
    url: str


@app.post("/api/slides/import", dependencies=[Depends(require_teacher)])
def import_google_slides(payload: SlidesImportRequest):
    import pymupdf

    url = urlsplit(payload.url.strip())
    match = re.fullmatch(r"/presentation/d/([\w-]{10,150})(?:/[^/]+)?/?", url.path, re.ASCII)
    if url.scheme != "https" or url.netloc != "docs.google.com" or not match:
        raise HTTPException(422, "Use a Google Slides sharing link")

    limit = 12 * 1024 * 1024
    export_url = f"https://docs.google.com/presentation/d/{match[1]}/export/pdf"
    try:
        with urlopen(export_url, timeout=20) as response:
            pdf = response.read(limit + 1)
    except (HTTPError, URLError, TimeoutError):
        raise HTTPException(422, "Google could not export this deck. Check sharing and download permissions.")

    if len(pdf) > limit:
        raise HTTPException(413, "Deck exceeds the 12 MB PDF limit")
    if not pdf.startswith(b"%PDF-"):
        raise HTTPException(422, "Google did not return a PDF. Check sharing and download permissions.")

    pages = []
    try:
        with pymupdf.open(stream=pdf, filetype="pdf") as document:
            if not 1 <= len(document) <= 60:
                raise HTTPException(422, "Deck must have between 1 and 60 slides")
            for page in document:
                scale = 1280 / max(page.rect.width, page.rect.height)
                image = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                pages.append(image.tobytes("jpeg", jpg_quality=85))
    except (pymupdf.FileDataError, ValueError, RuntimeError):
        raise HTTPException(422, "Could not render this deck")

    deck_id = uuid4().hex
    with closing(db()) as conn:
        conn.cursor().executemany(
            sql("INSERT INTO imported_slide_pages (deck_id, page_number, image) VALUES (?, ?, ?)"),
            [(deck_id, number, image) for number, image in enumerate(pages, 1)],
        )
        conn.commit()
    return {"lesson_path": f"imports/{deck_id}", "slide_count": len(pages)}


@app.get("/api/imports/{deck_id}")
def imported_lesson(deck_id: str):
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("SELECT page_number FROM imported_slide_pages WHERE deck_id = ? ORDER BY page_number"), (deck_id,))
        pages = cur.fetchall()
    if not pages:
        raise HTTPException(404, "Imported lesson not found")
    return {
        "lesson_id": f"slides-{deck_id}",
        "title": "Google Slides",
        "version": "1",
        "blocks": [
            {
                "id": f"slide-{row['page_number']}",
                "type": "activity",
                "activity_kind": "google-slide",
                "title": f"Slide {row['page_number']}",
                "image_path": f"imports/{deck_id}/pages/{row['page_number']}",
                "completion": {"mode": "teacher_next"},
            }
            for row in pages
        ],
    }


@app.get("/api/imports/{deck_id}/pages/{number}")
def imported_slide(deck_id: str, number: int):
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("SELECT image FROM imported_slide_pages WHERE deck_id = ? AND page_number = ?"), (deck_id, number))
        page = cur.fetchone()
    if page is None:
        raise HTTPException(404, "Slide not found")
    return Response(bytes(page["image"]), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})

app.mount("/studio", StaticFiles(directory=Path(__file__).parent / "studio"), name="studio")
