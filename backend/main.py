from pathlib import Path
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from random import randint, shuffle
from datetime import datetime, timezone, timedelta
from typing import List, Literal, Optional
import base64
import binascii
import csv
import hashlib
import io
import tempfile
import zipfile
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
import unicodedata
import qrcode
from qrcode.image.svg import SvgPathImage

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
    reh_student_id: Optional[str] = Field(default=None, max_length=120)

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
        CREATE TABLE IF NOT EXISTS lesson_catalogue (
            catalogue_id TEXT PRIMARY KEY,
            revision_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            level TEXT NOT NULL,
            cluster TEXT NOT NULL,
            version TEXT NOT NULL,
            origin TEXT NOT NULL,
            published_at TEXT NOT NULL
        )
    """)
    if USE_POSTGRES:
        cur.execute("ALTER TABLE lesson_catalogue ADD COLUMN IF NOT EXISTS course TEXT NOT NULL DEFAULT 'Unassigned course'")
    else:
        cur.execute("PRAGMA table_info(lesson_catalogue)")
        if not any(row["name"] == "course" for row in cur.fetchall()):
            cur.execute("ALTER TABLE lesson_catalogue ADD COLUMN course TEXT NOT NULL DEFAULT 'Unassigned course'")
    cur.execute("""
        CREATE TABLE IF NOT EXISTS lesson_revisions (
            revision_id TEXT PRIMARY KEY,
            manifest TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS writing_tasks (
            task_id TEXT PRIMARY KEY,
            pin TEXT NOT NULL REFERENCES sessions(pin),
            block_id TEXT,
            prompt TEXT NOT NULL,
            assigned_at TEXT NOT NULL,
            UNIQUE (pin, block_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS writing_task_quizzes (
            task_id TEXT PRIMARY KEY REFERENCES writing_tasks(task_id),
            definition TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS speaking_tasks (
            task_id TEXT PRIMARY KEY REFERENCES writing_tasks(task_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS published_quiz_scores (
            task_id TEXT PRIMARY KEY REFERENCES writing_tasks(task_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS active_writing_tasks (
            pin TEXT PRIMARY KEY REFERENCES sessions(pin),
            task_id TEXT NOT NULL REFERENCES writing_tasks(task_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS writing_task_responses (
            task_id TEXT NOT NULL REFERENCES writing_tasks(task_id),
            student_id TEXT NOT NULL REFERENCES session_students(student_id),
            response TEXT NOT NULL,
            submitted_at TEXT NOT NULL,
            PRIMARY KEY (task_id, student_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS speaking_audio (
            task_id TEXT NOT NULL,
            student_id TEXT NOT NULL,
            media_type TEXT NOT NULL,
            audio BYTEA NOT NULL,
            PRIMARY KEY (task_id, student_id),
            FOREIGN KEY (task_id, student_id) REFERENCES writing_task_responses(task_id, student_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS reh_roster (
            student_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            status TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS learning_targets (
            learning_target_id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            skill TEXT NOT NULL,
            level TEXT NOT NULL,
            status TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS evidence_roster_ids (
            roster_id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL UNIQUE
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS evidence_student_links (
            student_id TEXT PRIMARY KEY REFERENCES session_students(student_id),
            evidence_id TEXT NOT NULL REFERENCES evidence_roster_ids(evidence_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS task_evidence_context (
            task_id TEXT PRIMARY KEY REFERENCES writing_tasks(task_id),
            phase TEXT,
            learning_target_id TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS task_reviews (
            task_id TEXT NOT NULL, student_id TEXT NOT NULL, score INTEGER, max_score INTEGER,
            feedback TEXT NOT NULL, reviewed_at TEXT NOT NULL, PRIMARY KEY (task_id, student_id),
            FOREIGN KEY (task_id, student_id) REFERENCES writing_task_responses(task_id, student_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS session_audio_archives (
            pin TEXT PRIMARY KEY REFERENCES sessions(pin), fingerprint TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS writing_assignments (
            pin TEXT PRIMARY KEY REFERENCES sessions(pin),
            prompt TEXT NOT NULL,
            assigned_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS writing_submissions (
            pin TEXT NOT NULL REFERENCES writing_assignments(pin),
            student_id TEXT NOT NULL REFERENCES session_students(student_id),
            response TEXT NOT NULL,
            submitted_at TEXT NOT NULL,
            PRIMARY KEY (pin, student_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS session_slide_steps (
            pin TEXT PRIMARY KEY REFERENCES sessions(pin),
            block_index INTEGER NOT NULL, step INTEGER NOT NULL
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
    cur.execute("""
        CREATE TABLE IF NOT EXISTS task_materials (
            task_id TEXT PRIMARY KEY REFERENCES writing_tasks(task_id),
            definition TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS page_task_instances (
            task_id TEXT PRIMARY KEY REFERENCES writing_tasks(task_id),
            block_index INTEGER NOT NULL,
            title TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS page_task_recipients (
            task_id TEXT NOT NULL REFERENCES page_task_instances(task_id),
            student_id TEXT NOT NULL REFERENCES session_students(student_id),
            PRIMARY KEY (task_id, student_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS session_student_labels (
            student_id TEXT NOT NULL REFERENCES session_students(student_id),
            label TEXT NOT NULL,
            PRIMARY KEY (student_id, label)
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
    cur.execute(sql("SELECT step FROM session_slide_steps WHERE pin = ? AND block_index = ?"), (pin, session["current_block_index"]))
    slide_step = cur.fetchone()
    cur.execute(sql("SELECT prompt, assigned_at FROM writing_assignments WHERE pin = ?"), (pin,))
    writing = cur.fetchone()
    cur.execute(sql("""
        SELECT t.task_id, t.block_id, t.prompt, t.assigned_at, q.definition, sp.task_id AS speaking_id, m.definition AS materials_json FROM active_writing_tasks a
        JOIN writing_tasks t ON t.task_id = a.task_id
        LEFT JOIN writing_task_quizzes q ON q.task_id = t.task_id
        LEFT JOIN speaking_tasks sp ON sp.task_id = t.task_id
        LEFT JOIN task_materials m ON m.task_id = t.task_id WHERE a.pin = ?
    """), (pin,))
    active_writing = cur.fetchone()
    cur.execute(sql("""
        SELECT p.task_id FROM published_quiz_scores p JOIN writing_tasks t ON t.task_id = p.task_id
        WHERE t.pin = ? ORDER BY p.task_id
    """), (pin,))
    published_scores = [row["task_id"] for row in cur.fetchall()]

    conn.close()

    data = dict(session)
    data["students"] = students
    data["events"] = events
    data["slide_step"] = slide_step["step"] if slide_step else 0
    data["display_mode"] = display["mode"] if display else "follow"
    data["published_score_ids"] = published_scores
    data["active_writing_task"] = task_description(dict(active_writing)) if active_writing else None
    data["writing_task"] = {"schema_version": 1, "type": "writing", **dict(writing)} if writing else None
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
def get_session_state(pin: str, credentials: Optional[HTTPAuthorizationCredentials] = Depends(teacher_bearer),
                      student_id: Optional[str] = None):
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
    if student_id and session["status"] == "active":
        with closing(db()) as conn:
            cur = conn.cursor()
            cur.execute(sql("""
                SELECT t.task_id, t.prompt, p.title, q.definition, sp.task_id AS speaking_id, m.definition AS materials_json,
                       CASE WHEN response.student_id IS NULL THEN 0 ELSE 1 END AS submitted
                FROM page_task_recipients r
                JOIN page_task_instances p ON p.task_id = r.task_id
                JOIN writing_tasks t ON t.task_id = p.task_id
                LEFT JOIN writing_task_quizzes q ON q.task_id = t.task_id
                LEFT JOIN speaking_tasks sp ON sp.task_id = t.task_id
                LEFT JOIN task_materials m ON m.task_id = t.task_id
                LEFT JOIN writing_task_responses response ON response.task_id = t.task_id
                    AND response.student_id = r.student_id
                WHERE t.pin = ? AND p.block_index = ? AND r.student_id = ?
                ORDER BY t.assigned_at, t.block_id
            """), (pin, session["current_block_index"], student_id))
            session["page_tasks"] = [task_description(dict(row)) for row in cur.fetchall()]
    if "students" in session:
        if session["lesson_path"].startswith("imports/"):
            try:
                block = load_imported_lesson(session["lesson_path"].split("/")[1])["blocks"][session["current_block_index"]]
            except (HTTPException, IndexError):
                block = {}
            session["page_audience"] = [{key: task[key] for key in ("id", "title", "audience_label")}
                                        for task in block.get("page_tasks", [])]
        with closing(db()) as conn:
            cur = conn.cursor()
            cur.execute(sql("""
                SELECT l.student_id, l.label FROM session_student_labels l
                JOIN session_students s ON s.student_id = l.student_id WHERE s.pin = ?
                ORDER BY l.label
            """), (pin,))
            labels = {}
            for row in cur.fetchall():
                labels.setdefault(row["student_id"], []).append(row["label"])
            for student in session["students"]:
                student["labels"] = labels.get(student["student_id"], [])
    return session


@app.post("/api/sessions/{pin}/join")
def join_session(pin: str, payload: JoinSessionRequest):
    require_active_session(pin)
    student_name = payload.student_name.strip()
    roster_id = None
    student_id = f"{pin}-{uuid4().hex}"
    if TEACHER_ACCESS_TOKEN:
        entered_id = (payload.reh_student_id or payload.roster_code or "").strip()
        with closing(db()) as conn:
            cur = conn.cursor()
            cur.execute(sql("SELECT * FROM reh_roster WHERE student_id = ?"), (entered_id.upper(),))
            registered = cur.fetchone()
        if registered:
            if registered["status"] != "active":
                raise HTTPException(status_code=403, detail="Student ID is not active")
            member = {"id": registered["student_id"], "name": registered["display_name"]}
        else:
            member = ROSTER.get(entered_id)
        if not member:
            raise HTTPException(status_code=403, detail="Student ID was not found")
        student_name = member["name"]
        roster_id = str(member["id"])
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

    if roster_id is not None:
        cur.execute(sql("INSERT INTO evidence_roster_ids VALUES (?, ?) ON CONFLICT(roster_id) DO NOTHING"),
                    (roster_id, uuid4().hex))
        cur.execute(sql("SELECT evidence_id FROM evidence_roster_ids WHERE roster_id = ?"), (roster_id,))
        evidence_id = cur.fetchone()["evidence_id"]
        cur.execute(sql("INSERT INTO evidence_student_links VALUES (?, ?) ON CONFLICT(student_id) DO NOTHING"),
                    (student_id, evidence_id))

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
        sql("UPDATE sessions SET current_block_index = ? WHERE pin = ? AND current_block_index <> ?"),
        (next_index, pin, next_index)
    )
    if cur.rowcount:
        cur.execute(sql("DELETE FROM session_slide_steps WHERE pin = ?"), (pin,))
        cur.execute(sql("DELETE FROM active_writing_tasks WHERE pin = ?"), (pin,))
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
        sql("UPDATE sessions SET current_block_index = ? WHERE pin = ? AND current_block_index <> ?"),
        (prev_index, pin, prev_index)
    )
    if cur.rowcount:
        cur.execute(sql("DELETE FROM session_slide_steps WHERE pin = ?"), (pin,))
        cur.execute(sql("DELETE FROM active_writing_tasks WHERE pin = ?"), (pin,))
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
        sql("UPDATE sessions SET current_block_index = ? WHERE pin = ? AND current_block_index <> ?"),
        (index, pin, index)
    )
    if cur.rowcount:
        cur.execute(sql("DELETE FROM session_slide_steps WHERE pin = ?"), (pin,))
        cur.execute(sql("DELETE FROM active_writing_tasks WHERE pin = ?"), (pin,))
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


def load_imported_lesson(deck_id: str):
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("SELECT manifest FROM lesson_revisions WHERE revision_id = ?"), (deck_id,))
        revision = cur.fetchone()
        if revision:
            return json.loads(revision["manifest"])
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


@app.get("/api/imports/{deck_id}")
def imported_lesson(deck_id: str):
    manifest = load_imported_lesson(deck_id)
    manifest.pop("work_source", None)
    for block in manifest["blocks"]:
        if "page_tasks" in block:
            block["page_tasks"] = [{key: task[key] for key in ("id", "title")}
                                   for task in block["page_tasks"]]
        task = block.get("task")
        if task and task.get("type") in ("multiple_choice", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph"):
            task.pop("correct_option", None)
            for question in task.get("questions", []):
                question.pop("correct_option", None)
                question.pop("accepted_answers", None)
                question.pop("correct_order", None)
    return manifest


@app.get("/api/imports/{deck_id}/pages/{number}")
def imported_slide(deck_id: str, number: int):
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("SELECT image FROM imported_slide_pages WHERE deck_id = ? AND page_number = ?"), (deck_id, number))
        page = cur.fetchone()
    if page is None:
        raise HTTPException(404, "Slide not found")
    return Response(bytes(page["image"]), media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})

@app.get("/j/{pin}")
def short_join_link(pin: str):
    if not re.fullmatch(r"[0-9]{4}", pin):
        raise HTTPException(404, "Invalid session PIN")
    return RedirectResponse(f"/studio/join.html?pin={pin}", headers={"Cache-Control": "no-store"})


@app.get("/j/{pin}/qr.svg")
def session_join_qr(pin: str, request: Request):
    if not re.fullmatch(r"[0-9]{4}", pin):
        raise HTTPException(404, "Invalid session PIN")
    url = request.url_for("short_join_link", pin=pin)
    if url.hostname not in ("localhost", "127.0.0.1", "::1"):
        url = url.replace(scheme="https")
    image = qrcode.make(str(url), image_factory=SvgPathImage)
    output = io.BytesIO()
    image.save(output)
    return Response(output.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})


app.mount("/studio", StaticFiles(directory=Path(__file__).parent / "studio"), name="studio")


class WritingAssignmentRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)


class WritingSubmissionRequest(BaseModel):
    student_id: str
    response: str = Field(min_length=1, max_length=20000)


@app.post("/api/sessions/{pin}/writing", dependencies=[Depends(require_teacher)])
def assign_writing(pin: str, payload: WritingAssignmentRequest):
    require_active_session(pin)
    prompt = payload.prompt.strip()
    if not prompt:
        raise HTTPException(422, "Enter a writing prompt")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            INSERT INTO writing_assignments (pin, prompt, assigned_at) VALUES (?, ?, ?)
            ON CONFLICT(pin) DO NOTHING
        """), (pin, prompt, now_iso()))
        if cur.rowcount != 1:
            raise HTTPException(409, "This session already has a writing task")
        conn.commit()
    return {"ok": True}


@app.post("/api/sessions/{pin}/writing/submissions")
def submit_writing(pin: str, payload: WritingSubmissionRequest):
    session = require_active_session(pin)
    if not any(student["student_id"] == payload.student_id for student in session["students"]):
        raise HTTPException(403, "Join the session before submitting")
    if not session["writing_task"]:
        raise HTTPException(404, "No writing task assigned")
    if not payload.response.strip():
        raise HTTPException(422, "Enter a response before submitting")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT response FROM writing_submissions WHERE pin = ? AND student_id = ?
        """), (pin, payload.student_id))
        prior = cur.fetchone()
        if not prior:
            if session["display_mode"] != "interact":
                raise HTTPException(409, "The teacher must enable Interact")
            cur.execute(sql("""
                INSERT INTO writing_submissions (pin, student_id, response, submitted_at)
                VALUES (?, ?, ?, ?) ON CONFLICT(pin, student_id) DO NOTHING
            """), (pin, payload.student_id, payload.response, now_iso()))
            conn.commit()
            cur.execute(sql("""
                SELECT response FROM writing_submissions WHERE pin = ? AND student_id = ?
            """), (pin, payload.student_id))
            prior = cur.fetchone()
    if prior["response"] != payload.response:
        raise HTTPException(409, "A different response was already submitted")
    return {"ok": True}


def writing_results(pin: str):
    session = get_session(pin)
    if not session or not session["writing_task"]:
        raise HTTPException(404, "Writing task not found")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT sub.student_id, student.student_name, sub.response, sub.submitted_at
            FROM writing_submissions AS sub
            JOIN session_students AS student ON student.student_id = sub.student_id
            WHERE sub.pin = ? ORDER BY sub.submitted_at, sub.student_id
        """), (pin,))
        submissions = [dict(row) for row in cur.fetchall()]
    return {"task": session["writing_task"], "joined": len(session["students"]), "submissions": submissions}


@app.get("/api/sessions/{pin}/writing/results", dependencies=[Depends(require_teacher)])
def get_writing_results(pin: str):
    return writing_results(pin)


@app.get("/api/sessions/{pin}/writing/export", dependencies=[Depends(require_teacher)])
def export_writing(pin: str):
    results = writing_results(pin)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["schema_version", "pin", "prompt", "student_id", "student_name", "response", "submitted_at"])
    for row in results["submissions"]:
        values = [1, pin, results["task"]["prompt"], row["student_id"], row["student_name"], row["response"], row["submitted_at"]]
        writer.writerow([
            "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")) else value
            for value in values
        ])
    return Response(
        output.getvalue().encode("utf-8-sig"),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="writing-{pin}.csv"'},
    )


class TaskMaterial(BaseModel):
    kind: Literal["text", "image", "audio", "video"]
    text: str = Field(default="", max_length=4000)
    url: Optional[str] = Field(default=None, max_length=2000)

    def normalized(self):
        text = self.text.strip()
        if self.kind == "text":
            if not text:
                raise HTTPException(422, "Enter text for the task material")
            return {"kind": self.kind, "text": text}
        url = (self.url or "").strip()
        try:
            parsed = urlsplit(url)
            valid = parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(422, "Use an HTTPS link for task media")
        return {"kind": self.kind, "text": text, "url": url}


class QuizQuestion(BaseModel):
    materials: List[TaskMaterial] = Field(default_factory=list, max_length=8)
    learning_target_id: Optional[str] = Field(default=None, max_length=120)
    question_id: Optional[str] = Field(default=None, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    prompt: str = Field(min_length=1, max_length=4000)
    options: List[str] = Field(min_length=2, max_length=8)
    correct_option: int = Field(ge=0, le=7)

    def normalized(self):
        options = [option.strip() for option in self.options]
        if not self.prompt.strip() or any(not option or len(option) > 1000 for option in options):
            raise HTTPException(422, "Enter a question and options of up to 1000 characters each")
        if len(set(options)) != len(options) or self.correct_option >= len(options):
            raise HTTPException(422, "Use distinct options and select an existing correct option")
        return {"prompt": self.prompt.strip(), "options": options, "correct_option": self.correct_option,
                **({"materials": [item.normalized() for item in self.materials]} if self.materials else {}),
                **({"question_id": self.question_id} if self.question_id else {}),
                **({"learning_target_id": self.learning_target_id.strip()} if self.learning_target_id and self.learning_target_id.strip() else {})}


class OrderingQuestion(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    parts: List[str] = Field(min_length=2, max_length=16)
    question_id: Optional[str] = Field(default=None, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    learning_target_id: Optional[str] = Field(default=None, max_length=120)
    materials: List[TaskMaterial] = Field(default_factory=list, max_length=8)


class TextQuestion(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    accepted_answers: List[str] = Field(min_length=1, max_length=20)
    question_id: Optional[str] = Field(default=None, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    learning_target_id: Optional[str] = Field(default=None, max_length=120)
    materials: List[TaskMaterial] = Field(default_factory=list, max_length=8)


def normalize_answer(value):
    return " ".join(unicodedata.normalize("NFC", value).casefold().split())


def work_assessment(block):
    if block.kind in ("ordering_sentence", "ordering_paragraph"):
        if not block.ordering_questions or block.quiz or block.text_questions:
            raise HTTPException(422, "Add ordering items that match the task type")
        questions = []
        ids = set()
        for index, item in enumerate(block.ordering_questions, 1):
            prompt = item.prompt.strip()
            parts = [part.strip() for part in item.parts]
            question_id = item.question_id or f"q{index}"
            if not prompt or question_id in ids or len(set(parts)) < 2 or any(not part or len(part) > 500 for part in parts):
                raise HTTPException(422, "Use unique question IDs and at least two different, non-empty parts")
            ids.add(question_id)
            order = list(range(len(parts)))
            shuffle(order)
            if [parts[position] for position in order] == parts:
                swap = next(position for position in range(1, len(parts)) if parts[order[position]] != parts[order[0]])
                order[0], order[swap] = order[swap], order[0]
            questions.append({
                "prompt": prompt, "question_id": question_id, "parts": [parts[position] for position in order],
                "correct_order": [order.index(position) for position in range(len(parts))],
                "separator": " " if block.kind == "ordering_sentence" else "\n",
                "learning_target_id": item.learning_target_id,
                "materials": [material.normalized() for material in item.materials],
            })
        return {"kind": block.kind, "questions": questions}
    if block.ordering_questions:
        raise HTTPException(422, "Ordering items require an ordering task")
    if block.kind == "multiple_choice" and block.quiz and not block.text_questions:
        return block.quiz.normalized(block.prompt.strip())
    if block.kind in ("cloze", "short_answer") and block.text_questions and not block.quiz:
        questions = []
        ids = set()
        for index, item in enumerate(block.text_questions, 1):
            prompt = item.prompt.strip()
            answers = [answer.strip() for answer in item.accepted_answers]
            question_id = item.question_id or f"q{index}"
            if (not prompt or question_id in ids or any(not answer or len(answer) > 500 for answer in answers)
                    or (block.kind == "cloze" and prompt.count("___") != 1)):
                raise HTTPException(422, "Use unique question IDs, valid answers and one ___ per Cloze item")
            ids.add(question_id)
            questions.append({"prompt": prompt, "question_id": question_id, "accepted_answers": answers,
                              "learning_target_id": item.learning_target_id,
                              "materials": [material.normalized() for material in item.materials]})
        return {"kind": block.kind, "questions": questions}
    if block.kind in ("multiple_choice", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph") or block.quiz or block.text_questions:
        raise HTTPException(422, "Add questions that match the task type")
    return {}


class QuizDefinition(BaseModel):
    questions: Optional[List[QuizQuestion]] = Field(default=None, min_length=1, max_length=30)
    shuffle: bool = False
    options: Optional[List[str]] = None
    correct_option: Optional[int] = None

    def normalized(self, prompt):
        if self.questions is not None:
            questions = [question.normalized() for question in self.questions]
            ids = [question.get("question_id", f"q{index + 1}") for index, question in enumerate(questions)]
            if len(set(ids)) != len(ids):
                raise HTTPException(422, "Use unique question IDs within each task")
            return {"questions": questions, "shuffle": self.shuffle}
        if self.options is None or self.correct_option is None:
            raise HTTPException(422, "Add at least one question")
        if not 2 <= len(self.options) <= 8 or not 0 <= self.correct_option < len(self.options):
            raise HTTPException(422, "Use 2 to 8 options and select an existing correct option")
        return QuizQuestion(prompt=prompt, options=self.options, correct_option=self.correct_option).normalized()


def quiz_questions(quiz, prompt):
    return quiz["questions"] if "questions" in quiz else [{
        "prompt": prompt, "options": quiz["options"], "correct_option": quiz["correct_option"]
    }]


def quiz_answers(raw, questions):
    try:
        answers = json.loads(raw)
    except ValueError:
        raise HTTPException(422, "Answer every question before submitting")
    if type(answers) is int and len(questions) == 1:
        answers = [answers]
    if not isinstance(answers, list) or len(answers) != len(questions) or any(
        type(answer) is not int or not 0 <= answer < len(question["options"])
        for answer, question in zip(answers, questions)
    ):
        raise HTTPException(422, "Select one valid option for every question")
    return answers


def assessment_items(raw, questions):
    if questions and "correct_order" in questions[0]:
        try:
            responses = json.loads(raw)
        except ValueError:
            raise HTTPException(422, "Order all parts before submitting")
        if not isinstance(responses, list) or len(responses) != len(questions):
            raise HTTPException(422, "Submit one order for every item")
        items = []
        for answer, question in zip(responses, questions):
            parts = question["parts"]
            if (not isinstance(answer, list) or len(answer) != len(parts)
                    or any(type(position) is not int for position in answer)
                    or sorted(answer) != list(range(len(parts)))):
                raise HTTPException(422, "Use each part exactly once")
            selected = [parts[position] for position in answer]
            expected = [parts[position] for position in question["correct_order"]]
            separator = question["separator"]
            items.append({"selected_option": separator.join(selected), "correct_option": separator.join(expected),
                          "is_correct": selected == expected})
        return items
    if questions and "accepted_answers" in questions[0]:
        try:
            answers = json.loads(raw)
        except ValueError:
            raise HTTPException(422, "Answer every question before submitting")
        if not isinstance(answers, list) or len(answers) != len(questions) or any(
            not isinstance(answer, str) or not answer.strip() or len(answer) > 500 for answer in answers
        ):
            raise HTTPException(422, "Enter an answer of up to 500 characters for each item")
        return [{"selected_option": answer, "correct_option": " / ".join(question["accepted_answers"]),
                 "is_correct": any(normalize_answer(answer) == normalize_answer(accepted)
                                   for accepted in question["accepted_answers"])}
                for answer, question in zip(answers, questions)]
    return [{"selected_index": answer, "selected_option": question["options"][answer],
             "correct_index": question["correct_option"], "correct_option": question["options"][question["correct_option"]],
             "is_correct": answer == question["correct_option"]}
            for answer, question in zip(quiz_answers(raw, questions), questions)]


def grade_quiz(raw, quiz, prompt):
    items = assessment_items(raw, quiz_questions(quiz, prompt))
    selected = [item["selected_option"] for item in items]
    return {"selected_option": selected[0] if len(selected) == 1 else json.dumps(selected, ensure_ascii=False),
            "score": sum(item["is_correct"] for item in items), "max_score": len(items)}


def task_description(row):
    definition = row.pop("definition", None)
    speaking = row.pop("speaking_id", None)
    materials = row.pop("materials_json", None)
    task = {"schema_version": 1, "type": "speaking" if speaking else "multiple_choice" if definition else "writing", **row}
    if materials:
        task["materials"] = json.loads(materials)
    if definition:
        quiz = json.loads(definition)
        task["type"] = quiz.get("kind", "multiple_choice")
        task["questions"] = [{key: q[key] for key in ("prompt", "options", "materials", "parts") if key in q}
                             for q in quiz_questions(quiz, task["prompt"])]
        task["shuffle"] = quiz.get("shuffle", False)
        if len(task["questions"]) == 1 and task["type"] == "multiple_choice":
            task["options"] = task["questions"][0]["options"]
    return task


EvidencePhase = Literal["diagnosis", "teach", "practice", "retrieve", "production", "verify"]


class PreparedWritingRequest(WritingAssignmentRequest):
    phase: Optional[EvidencePhase] = None
    learning_target_id: Optional[str] = Field(default=None, max_length=120)
    speaking: bool = False
    quiz: Optional[QuizDefinition] = None
    after_block: int = Field(ge=0)


@app.post("/api/imports/{deck_id}/writing-blocks", dependencies=[Depends(require_teacher)])
def prepare_writing(deck_id: str, payload: PreparedWritingRequest):
    manifest = load_imported_lesson(deck_id)
    if manifest.get("origin") == "work":
        raise HTTPException(409, "Edit Work lessons in Studio")
    blocks = manifest["blocks"]
    prompt = payload.prompt.strip()
    if not prompt or payload.after_block >= len(blocks):
        raise HTTPException(422, "Enter a prompt and select a valid insertion point")
    revision_id = uuid4().hex
    block_id = f"writing-{revision_id}"
    quiz = payload.quiz.normalized(prompt) if payload.quiz else None
    if payload.speaking and quiz:
        raise HTTPException(422, "Choose one task type")
    blocks.insert(payload.after_block + 1, {
        "id": block_id, "type": "activity", "activity_kind": "writing-task",
        "phase": payload.phase, "learning_target_id": (payload.learning_target_id or "").strip() or None,
        "title": "Speaking task" if payload.speaking else "Multiple-choice task" if quiz else "Writing task",
        "task": {"schema_version": 1, "type": "speaking" if payload.speaking else "multiple_choice" if quiz else "writing", "prompt": prompt, **(quiz or {})},
        "completion": {"mode": "teacher_next"},
    })
    manifest["lesson_id"] = f"slides-{revision_id}"
    manifest["version"] = str(int(manifest["version"]) + 1)
    manifest["parent_revision"] = deck_id
    with closing(db()) as conn:
        conn.cursor().execute(sql("INSERT INTO lesson_revisions VALUES (?, ?)"), (revision_id, json.dumps(manifest)))
        conn.commit()
    return {"lesson_path": f"imports/{revision_id}", "block_index": payload.after_block + 1}


class SessionWritingRequest(BaseModel):
    phase: Optional[EvidencePhase] = None
    learning_target_id: Optional[str] = Field(default=None, max_length=120)
    speaking: bool = False
    quiz: Optional[QuizDefinition] = None
    prompt: Optional[str] = Field(default=None, max_length=4000)
    block_id: Optional[str] = None


@app.post("/api/sessions/{pin}/tasks/writing", dependencies=[Depends(require_teacher)])
def assign_session_writing(pin: str, payload: SessionWritingRequest):
    session = require_active_session(pin)
    prompt = (payload.prompt or "").strip()
    quiz = payload.quiz.normalized(prompt) if payload.quiz else None
    speaking = payload.speaking
    phase = payload.phase
    target = (payload.learning_target_id or "").strip() or None
    materials = []
    if payload.block_id:
        if not session["lesson_path"].startswith("imports/"):
            raise HTTPException(422, "This lesson has no prepared task blocks")
        blocks = load_imported_lesson(session["lesson_path"].split("/", 1)[1])["blocks"]
        if not 0 <= session["current_block_index"] < len(blocks):
            raise HTTPException(409, "Move to the prepared task block before assigning it")
        block = blocks[session["current_block_index"]]
        if block["id"] != payload.block_id or block.get("activity_kind") != "writing-task":
            raise HTTPException(409, "Move to the prepared task block before assigning it")
        prompt = block["task"]["prompt"]
        materials = block["task"].get("materials", [])
        speaking = block["task"]["type"] == "speaking"
        phase = block.get("phase")
        target = block.get("learning_target_id")
        quiz = ({key: block["task"][key] for key in ("questions", "shuffle", "options", "correct_option", "kind") if key in block["task"]}
                if block["task"]["type"] in ("multiple_choice", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph") else None)
    if not prompt:
        raise HTTPException(422, "Enter a writing prompt")
    if speaking and quiz:
        raise HTTPException(422, "Choose one task type")
    task_id = uuid4().hex
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            INSERT INTO writing_tasks VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(pin, block_id) DO NOTHING
        """), (task_id, pin, payload.block_id, prompt, now_iso()))
        if cur.rowcount != 1:
            cur.execute(sql("SELECT task_id FROM writing_tasks WHERE pin = ? AND block_id = ?"), (pin, payload.block_id))
            task_id = cur.fetchone()["task_id"]
        elif speaking:
            cur.execute(sql("INSERT INTO speaking_tasks VALUES (?)"), (task_id,))
        elif quiz:
            cur.execute(sql("INSERT INTO writing_task_quizzes VALUES (?, ?)"), (task_id, json.dumps(quiz)))
        if materials:
            cur.execute(sql("INSERT INTO task_materials VALUES (?, ?) ON CONFLICT DO NOTHING"), (task_id, json.dumps(materials)))
        cur.execute(sql("INSERT INTO task_evidence_context VALUES (?, ?, ?) ON CONFLICT(task_id) DO NOTHING"),
                    (task_id, phase, target))
        cur.execute(sql("""
            INSERT INTO active_writing_tasks VALUES (?, ?)
            ON CONFLICT(pin) DO UPDATE SET task_id = excluded.task_id
        """), (pin, task_id))
        cur.execute(sql("""
            INSERT INTO session_display_modes (pin, mode) VALUES (?, 'interact')
            ON CONFLICT(pin) DO UPDATE SET mode = excluded.mode
        """), (pin,))
        conn.commit()
    return {"task_id": task_id, "display_mode": "interact"}


class PageLabelsRequest(BaseModel):
    student_ids: List[str] = Field(min_length=1, max_length=200)
    label: str = Field(min_length=1, max_length=60)
    remove: bool = False


@app.post("/api/sessions/{pin}/page-labels", dependencies=[Depends(require_teacher)])
def update_page_labels(pin: str, payload: PageLabelsRequest):
    session = require_active_session(pin)
    ids = set(payload.student_ids)
    label = payload.label.strip().casefold()
    if not label or not ids.issubset({student["student_id"] for student in session["students"]}):
        raise HTTPException(422, "Choose a label and students in this session")
    with closing(db()) as conn:
        cur = conn.cursor()
        if payload.remove:
            cur.executemany(sql("DELETE FROM session_student_labels WHERE student_id = ? AND label = ?"),
                            [(student_id, label) for student_id in ids])
        else:
            cur.executemany(sql("INSERT INTO session_student_labels VALUES (?, ?) ON CONFLICT DO NOTHING"),
                            [(student_id, label) for student_id in ids])
        conn.commit()
    return {"ok": True}


class AssignPageRequest(BaseModel):
    block_id: str


@app.post("/api/sessions/{pin}/assign-page", dependencies=[Depends(require_teacher)])
def assign_page(pin: str, payload: AssignPageRequest):
    session = require_active_session(pin)
    index = session["current_block_index"]
    if not re.fullmatch(r"imports/[a-f0-9]{32}", session["lesson_path"]):
        raise HTTPException(422, "This lesson has no Pages")
    block = load_imported_lesson(session["lesson_path"].split("/")[1])["blocks"][index]
    if block["id"] != payload.block_id or not block.get("page_tasks"):
        raise HTTPException(409, "Open the Page before assigning it")
    counts = []
    with closing(db()) as conn:
        cur = conn.cursor()
        if not USE_POSTGRES:
            cur.execute("BEGIN IMMEDIATE")
        lock = " FOR UPDATE" if USE_POSTGRES else ""
        cur.execute(sql("SELECT current_block_index, status FROM sessions WHERE pin = ?" + lock), (pin,))
        locked = cur.fetchone()
        if not locked or locked["status"] != "active" or locked["current_block_index"] != index:
            raise HTTPException(409, "The Page is no longer open")
        for order, task in enumerate(block["page_tasks"]):
            label = task["audience_label"]
            cur.execute(sql("""
                SELECT s.student_id FROM session_students s WHERE s.pin = ? AND
                (? = '' OR EXISTS (SELECT 1 FROM session_student_labels l
                    WHERE l.student_id = s.student_id AND l.label = ?))
            """), (pin, label or "", label or ""))
            recipients = cur.fetchall()
            if not recipients:
                counts.append({"title": task["title"], "added": 0})
                continue
            block_key = f"page:{block['id']}:{order:02d}:{task['id']}"
            cur.execute(sql("SELECT task_id FROM writing_tasks WHERE pin = ? AND block_id = ?"), (pin, block_key))
            existing = cur.fetchone()
            task_id = existing["task_id"] if existing else uuid4().hex
            if not existing:
                cur.execute(sql("INSERT INTO writing_tasks VALUES (?, ?, ?, ?, ?)"),
                            (task_id, pin, block_key, task["prompt"], now_iso()))
                cur.execute(sql("INSERT INTO page_task_instances VALUES (?, ?, ?)"), (task_id, index, task["title"]))
                cur.execute(sql("INSERT INTO task_evidence_context VALUES (?, ?, ?)"),
                            (task_id, block.get("phase"), task["learning_target_id"]))
                if task.get("materials"):
                    cur.execute(sql("INSERT INTO task_materials VALUES (?, ?)"), (task_id, json.dumps(task["materials"])))
                if task["type"] == "speaking":
                    cur.execute(sql("INSERT INTO speaking_tasks VALUES (?)"), (task_id,))
                elif task["type"] in ("multiple_choice", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph"):
                    quiz = {key: task[key] for key in ("questions", "options", "correct_option", "shuffle", "kind") if key in task}
                    cur.execute(sql("INSERT INTO writing_task_quizzes VALUES (?, ?)"), (task_id, json.dumps(quiz)))
            cur.executemany(sql("INSERT INTO page_task_recipients VALUES (?, ?) ON CONFLICT DO NOTHING"),
                            [(task_id, row["student_id"]) for row in recipients])
            counts.append({"title": task["title"], "added": cur.rowcount})
        conn.commit()
    return {"tasks": counts}


def available_task(cur, session, task_id, student_id):
    active = session["active_writing_task"]
    if active and active["task_id"] == task_id and session["display_mode"] == "interact":
        return active
    cur.execute(sql("""
        SELECT t.task_id, q.definition, sp.task_id AS speaking_id, t.prompt
        FROM page_task_recipients r JOIN page_task_instances p ON p.task_id = r.task_id
        JOIN writing_tasks t ON t.task_id = p.task_id JOIN sessions s ON s.pin = t.pin
        LEFT JOIN writing_task_quizzes q ON q.task_id = t.task_id
        LEFT JOIN speaking_tasks sp ON sp.task_id = t.task_id
        WHERE t.pin = ? AND t.task_id = ? AND r.student_id = ?
            AND s.status = 'active' AND p.block_index = s.current_block_index
    """), (session["pin"], task_id, student_id))
    row = cur.fetchone()
    return task_description(dict(row)) if row else None


@app.post("/api/sessions/{pin}/tasks/{task_id}/submissions")
def submit_task_response(pin: str, task_id: str, payload: WritingSubmissionRequest):
    session = require_active_session(pin)
    if not any(student["student_id"] == payload.student_id for student in session["students"]):
        raise HTTPException(403, "Join the session before submitting")
    if not payload.response.strip():
        raise HTTPException(422, "Enter a response before submitting")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT r.response FROM writing_task_responses r JOIN writing_tasks t ON t.task_id = r.task_id
            WHERE t.pin = ? AND r.task_id = ? AND r.student_id = ?
        """), (pin, task_id, payload.student_id))
        prior = cur.fetchone()
        if prior is None:
            active = available_task(cur, session, task_id, payload.student_id)
            if not active:
                raise HTTPException(409, "This task is not open for submissions")
            if active["type"] == "speaking":
                raise HTTPException(422, "Submit an audio recording for this task")
            if active["type"] in ("multiple_choice", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph"):
                cur.execute(sql("SELECT definition FROM writing_task_quizzes WHERE task_id = ?"), (task_id,))
                definition = json.loads(cur.fetchone()["definition"])
                assessment_items(payload.response, quiz_questions(definition, active["prompt"]))
            cur.execute(sql("""
                INSERT INTO writing_task_responses VALUES (?, ?, ?, ?)
                ON CONFLICT(task_id, student_id) DO NOTHING
            """), (task_id, payload.student_id, payload.response, now_iso()))
            conn.commit()
            cur.execute(sql("SELECT response FROM writing_task_responses WHERE task_id = ? AND student_id = ?"), (task_id, payload.student_id))
            prior = cur.fetchone()
    if prior["response"] != payload.response:
        raise HTTPException(409, "A different response was already submitted")
    return {"ok": True}


@app.get("/api/sessions/{pin}/tasks/results", dependencies=[Depends(require_teacher)])
def session_task_results(pin: str, include_roster: bool = False):
    session = get_session(pin)
    if not session:
        raise HTTPException(404, "Session not found")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT t.task_id, t.block_id, t.prompt, t.assigned_at, q.definition, sp.task_id AS speaking_id,
                   p.title AS page_task_title, p.block_index AS page_index, m.definition AS materials_json,
                   (SELECT COUNT(*) FROM page_task_recipients r WHERE r.task_id = p.task_id) AS recipient_count
            FROM writing_tasks t LEFT JOIN writing_task_quizzes q ON q.task_id = t.task_id
            LEFT JOIN speaking_tasks sp ON sp.task_id = t.task_id
            LEFT JOIN page_task_instances p ON p.task_id = t.task_id
            LEFT JOIN task_materials m ON m.task_id = t.task_id
            WHERE t.pin = ? ORDER BY t.assigned_at, t.task_id
        """), (pin,))
        tasks = [dict(row) for row in cur.fetchall()]
        cur.execute(sql("""
            SELECT r.task_id, r.student_id, s.student_name, r.response, r.submitted_at,
                   v.score AS review_score, v.max_score AS review_max_score, v.feedback, v.reviewed_at,
                   a.media_type AS audio_type, LENGTH(a.audio) AS audio_bytes
            FROM writing_task_responses r JOIN writing_tasks t ON t.task_id = r.task_id
            JOIN session_students s ON s.student_id = r.student_id
            LEFT JOIN task_reviews v ON v.task_id = r.task_id AND v.student_id = r.student_id
            LEFT JOIN speaking_audio a ON a.task_id = r.task_id AND a.student_id = r.student_id
            WHERE t.pin = ? ORDER BY r.submitted_at, r.student_id
        """), (pin,))
        responses = [dict(row) for row in cur.fetchall()]
        recipients = {}
        if include_roster:
            cur.execute(sql("""
                SELECT r.task_id, r.student_id FROM page_task_recipients r
                JOIN writing_tasks t ON t.task_id = r.task_id WHERE t.pin = ?
            """), (pin,))
            for row in cur.fetchall():
                recipients.setdefault(row["task_id"], []).append(row["student_id"])
    for task in tasks:
        definition = task.pop("definition")
        materials = task.pop("materials_json", None)
        if materials:
            task["materials"] = json.loads(materials)
        quiz = json.loads(definition) if definition else None
        speaking = task.pop("speaking_id")
        task["type"] = "speaking" if speaking else quiz.get("kind", "multiple_choice") if quiz else "writing"
        task["scores_published"] = task["task_id"] in session["published_score_ids"]
        task["submissions"] = [row for row in responses if row["task_id"] == task["task_id"]]
        if include_roster and task["page_index"] is not None:
            task["recipient_ids"] = recipients.get(task["task_id"], [])
        if quiz:
            task.update(quiz)
            task["questions"] = quiz_questions(quiz, task["prompt"])
            for row in task["submissions"]:
                row.update(grade_quiz(row["response"], quiz, task["prompt"]))
                if include_roster:
                    questions = task["questions"]
                    row["items"] = [{"prompt": question["prompt"], **item}
                                    for question, item in zip(questions, assessment_items(row["response"], questions))]
    result = {"joined": len(session["students"]), "tasks": tasks}
    if include_roster:
        result["students"] = [{key: student[key] for key in ("student_id", "student_name")}
                              for student in session["students"]]
    return result


@app.get("/api/sessions/{pin}/tasks/export", dependencies=[Depends(require_teacher)])
def export_session_tasks(pin: str):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["schema_version", "pin", "task_id", "source", "prompt", "student_id", "student_name", "response", "submitted_at", "task_type", "selected_option", "score", "max_score"])
    for task in session_task_results(pin)["tasks"]:
        for row in task["submissions"]:
            values = [1, pin, task["task_id"], "prepared" if task["block_id"] else "quick",
                      task["prompt"], row["student_id"], row["student_name"], row["response"], row["submitted_at"],
                      task["type"], row.get("selected_option", ""), row.get("score", ""), row.get("max_score", "")]
            writer.writerow(["'" + v if isinstance(v, str) and v.lstrip().startswith(("=", "+", "-", "@")) else v for v in values])
    return Response(output.getvalue().encode("utf-8-sig"), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="writing-{pin}.csv"'})


@app.post("/api/sessions/{pin}/tasks/{task_id}/publish-scores", dependencies=[Depends(require_teacher)])
def publish_scores(pin: str, task_id: str):
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT 1 FROM writing_tasks t JOIN writing_task_quizzes q ON q.task_id = t.task_id
            WHERE t.pin = ? AND t.task_id = ?
        """), (pin, task_id))
        if not cur.fetchone():
            raise HTTPException(404, "Quiz not found")
        cur.execute(sql("INSERT INTO published_quiz_scores VALUES (?) ON CONFLICT(task_id) DO NOTHING"), (task_id,))
        conn.commit()
    return {"ok": True}


class StudentScoresRequest(BaseModel):
    student_id: str


@app.post("/api/sessions/{pin}/published-scores")
def student_scores(pin: str, payload: StudentScoresRequest):
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT t.task_id, t.prompt, q.definition, r.response
            FROM published_quiz_scores p JOIN writing_tasks t ON t.task_id = p.task_id
            JOIN writing_task_quizzes q ON q.task_id = t.task_id
            JOIN writing_task_responses r ON r.task_id = t.task_id
            WHERE t.pin = ? AND r.student_id = ? ORDER BY t.assigned_at, t.task_id
        """), (pin, payload.student_id))
        rows = cur.fetchall()
    scores = []
    for row in rows:
        questions = quiz_questions(json.loads(row["definition"]), row["prompt"])
        items = [{"prompt": question["prompt"], **item}
                 for question, item in zip(questions, assessment_items(row["response"], questions))]
        scores.append({"task_id": row["task_id"], "title": row["prompt"],
                       "score": sum(item["is_correct"] for item in items),
                       "max_score": len(items), "items": items})
    return {"scores": scores}


class SlideElement(BaseModel):
    kind: Literal["text", "image", "audio", "shape", "icon", "table"]
    text: str = Field(default="", max_length=500)
    url: Optional[str] = Field(default=None, max_length=2000)
    shape: Literal["rectangle", "circle", "arrow", "line"] = "rectangle"
    font_family: Optional[Literal["Arial", "Verdana", "Georgia", "Trebuchet MS", "Courier New", "system-ui"]] = None
    font_size: Optional[int] = Field(default=None, ge=12, le=120)
    text_color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    fill_color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    border_color: Optional[str] = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    fill_opacity: int = Field(default=100, ge=0, le=100)
    border_opacity: int = Field(default=100, ge=0, le=100)
    border_width: int = Field(default=2, ge=1, le=20)
    cells: Optional[List[List[str]]] = Field(default=None, max_length=12)
    header_row: bool = True
    x: float = Field(ge=0, le=99)
    y: float = Field(ge=0, le=99)
    width: float = Field(gt=0, le=100)
    height: float = Field(gt=0, le=100)
    appear: int = Field(default=0, ge=0, le=30)
    disappear: Optional[int] = Field(default=None, ge=1, le=30)

    def checked(self, block_id):
        if self.x + self.width > 100 or self.y + self.height > 100:
            raise HTTPException(422, f"Block {block_id}: slide element must fit within the canvas")
        if self.disappear is not None and self.disappear <= self.appear:
            raise HTTPException(422, f"Block {block_id}: disappear must follow appear")
        if self.kind in {"image", "audio"}:
            url = urlsplit(self.url or "")
            if url.scheme != "https" or not url.hostname or url.username or url.password:
                raise HTTPException(422, f"Block {block_id}: image and audio elements require a direct HTTPS URL")
        elif self.url:
            raise HTTPException(422, f"Block {block_id}: only image and audio elements accept a URL")
        if self.kind == "table":
            rows = self.cells or []
            columns = len(rows[0]) if rows else 0
            if not 1 <= columns <= 8 or any(len(row) != columns or any(len(cell) > 300 for cell in row) for row in rows):
                raise HTTPException(422, f"Block {block_id}: use a rectangular table with 1–12 rows and 1–8 columns")
        return self.model_dump(exclude_none=True)


class WorkPageTask(BaseModel):
    ordering_questions: List[OrderingQuestion] = Field(default_factory=list, max_length=30)
    text_questions: List[TextQuestion] = Field(default_factory=list, max_length=30)
    materials: List[TaskMaterial] = Field(default_factory=list, max_length=12)
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    title: str = Field(min_length=1, max_length=160)
    kind: Literal["writing", "multiple_choice", "speaking", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph"]
    prompt: str = Field(min_length=1, max_length=4000)
    audience_label: Optional[str] = Field(default=None, max_length=60)
    learning_target_id: Optional[str] = Field(default=None, max_length=120)
    quiz: Optional[QuizDefinition] = None


class WorkBlock(BaseModel):
    ordering_questions: List[OrderingQuestion] = Field(default_factory=list, max_length=30)
    text_questions: List[TextQuestion] = Field(default_factory=list, max_length=30)
    materials: List[TaskMaterial] = Field(default_factory=list, max_length=12)
    tasks: List[WorkPageTask] = Field(default_factory=list, max_length=20)
    elements: List[SlideElement] = Field(default_factory=list, max_length=60)
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    phase: EvidencePhase
    learning_target_id: Optional[str] = Field(default=None, max_length=120)
    kind: Literal["slide", "page", "writing", "multiple_choice", "speaking", "cloze", "short_answer", "ordering_sentence", "ordering_paragraph"]
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(default="", max_length=4000)
    notes: str = Field(default="", max_length=4000)
    media_type: Optional[Literal["image", "audio", "video"]] = None
    media_url: Optional[str] = Field(default=None, max_length=2000)
    prompt: str = Field(default="", max_length=4000)
    quiz: Optional[QuizDefinition] = None


class WorkLesson(BaseModel):
    schema_version: Literal[1]
    course: Literal["Recovery", "Foundation", "Bridge"] | None = None
    level: int | None = Field(default=None, ge=1, le=12)
    title: str = Field(min_length=1, max_length=160)
    objective: str = Field(default="", max_length=1000)
    blocks: List[WorkBlock] = Field(min_length=1, max_length=100)


class SaveWorkLesson(BaseModel):
    lesson: WorkLesson
    parent_revision: Optional[str] = None


@app.get("/api/work-lessons/schema")
def work_lesson_schema():
    return WorkLesson.model_json_schema()


@app.get("/api/work-lessons/{revision}")
def read_work_lesson(revision: str, credentials: Optional[HTTPAuthorizationCredentials] = Depends(teacher_bearer)):
    require_teacher(credentials)
    manifest = load_imported_lesson(revision)
    if "work_source" not in manifest:
        raise HTTPException(404, "Work lesson not found")
    return {"lesson": manifest["work_source"], "version": manifest["version"]}


@app.post("/api/work-lessons", dependencies=[Depends(require_teacher)])
def save_work_lesson(payload: SaveWorkLesson):
    lesson = payload.lesson
    if not lesson.title.strip() or len({block.id for block in lesson.blocks}) != len(lesson.blocks):
        raise HTTPException(422, "Enter a lesson title and use unique block IDs")
    version = 1
    if payload.parent_revision:
        parent = load_imported_lesson(payload.parent_revision)
        if "work_source" not in parent:
            raise HTTPException(422, "This revision is not a Work lesson")
        version = int(parent["version"]) + 1
    revision = uuid4().hex
    blocks = []
    for block in lesson.blocks:
        title = block.title.strip()
        if not title:
            raise HTTPException(422, f"Block {block.id}: enter a title")
        entry = {"id": block.id, "title": title, "type": "activity", "phase": block.phase,
                 "learning_target_id": (block.learning_target_id or "").strip() or None,
                 "completion": {"mode": "teacher_next"}}
        if block.kind in ("slide", "page"):
            media = block.media_url
            if bool(media) != bool(block.media_type):
                raise HTTPException(422, f"Block {block.id}: enter both a media type and URL")
            if media:
                url = urlsplit(media)
                if url.scheme != "https" or not url.hostname or url.username or url.password:
                    raise HTTPException(422, f"Block {block.id}: use a direct HTTPS media URL")
            entry.update(activity_kind="native-slide", body=block.body,
                         media_type=block.media_type, media_url=media, native_revision=revision,
                         elements=[element.checked(block.id) for element in block.elements])
            if block.kind == "page":
                if not block.tasks or len({task.id for task in block.tasks}) != len(block.tasks):
                    raise HTTPException(422, f"Page {block.id}: add tasks with unique IDs")
                entry["page_tasks"] = []
                for task in block.tasks:
                    prompt = task.prompt.strip()
                    if not prompt or not task.title.strip():
                        raise HTTPException(422, f"Task {task.id}: enter a title, prompt and required quiz options")
                    entry["page_tasks"].append({
                        "id": task.id, "title": task.title.strip(), "type": task.kind, "prompt": prompt,
                        "audience_label": (task.audience_label or "").strip().casefold() or None,
                        "learning_target_id": (task.learning_target_id or "").strip() or None,
                        "materials": [item.normalized() for item in task.materials],
                        **work_assessment(task),
                    })
        else:
            prompt = block.prompt.strip()
            if not prompt:
                raise HTTPException(422, f"Block {block.id}: enter a prompt and the required task options")
            quiz = work_assessment(block)
            entry.update(activity_kind="writing-task",
                         task={"schema_version": 1, "type": block.kind, "prompt": prompt,
                               "materials": [item.normalized() for item in block.materials], **quiz})
        blocks.append(entry)
    manifest = {"lesson_id": f"work-{revision}", "title": lesson.title.strip(), "version": str(version),
                "origin": "work", "objective": lesson.objective, "blocks": blocks,
                "parent_revision": payload.parent_revision,
                "work_source": lesson.model_dump(exclude_none=True)}
    if lesson.course is not None:
        manifest["course"] = lesson.course
    if lesson.level is not None:
        manifest["level"] = lesson.level
    with closing(db()) as conn:
        conn.cursor().execute(sql("INSERT INTO lesson_revisions VALUES (?, ?)"), (revision, json.dumps(manifest)))
        conn.commit()
    return {"revision": revision, "version": version, "lesson_path": f"imports/{revision}"}


class SpeakingSubmissionRequest(BaseModel):
    student_id: str
    media_type: Literal["audio/webm", "audio/mp4", "audio/ogg"]
    audio_base64: str = Field(min_length=1, max_length=6_990_508)


@app.post("/api/sessions/{pin}/tasks/{task_id}/speaking")
def submit_speaking(pin: str, task_id: str, payload: SpeakingSubmissionRequest):
    session = require_active_session(pin)
    if not any(student["student_id"] == payload.student_id for student in session["students"]):
        raise HTTPException(403, "Join the session before submitting")
    try:
        audio = base64.b64decode(payload.audio_base64, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(422, "Invalid recording")
    signatures = {"audio/webm": audio.startswith(b"\x1a\x45\xdf\xa3"),
                  "audio/mp4": audio[4:8] == b"ftyp",
                  "audio/ogg": audio.startswith(b"OggS")}
    if len(audio) > 5 * 1024 * 1024 or not signatures[payload.media_type]:
        raise HTTPException(422, "Use a supported audio recording under 5 MB")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT a.audio, a.media_type FROM speaking_audio a
            JOIN writing_tasks t ON t.task_id = a.task_id
            WHERE t.pin = ? AND a.task_id = ? AND a.student_id = ?
        """), (pin, task_id, payload.student_id))
        prior = cur.fetchone()
        if prior is None:
            active = available_task(cur, session, task_id, payload.student_id)
            if not active or active["type"] != "speaking":
                raise HTTPException(409, "This speaking task is not open for submissions")
            cur.execute(sql("""
                INSERT INTO writing_task_responses VALUES (?, ?, ?, ?)
                ON CONFLICT(task_id, student_id) DO NOTHING
            """), (task_id, payload.student_id, "[Audio recording]", now_iso()))
            if cur.rowcount == 1:
                cur.execute(sql("INSERT INTO speaking_audio VALUES (?, ?, ?, ?)"),
                            (task_id, payload.student_id, payload.media_type, audio))
            conn.commit()
            cur.execute(sql("SELECT audio, media_type FROM speaking_audio WHERE task_id = ? AND student_id = ?"),
                        (task_id, payload.student_id))
            prior = cur.fetchone()
    if not prior or bytes(prior["audio"]) != audio or prior["media_type"] != payload.media_type:
        raise HTTPException(409, "A different recording was already submitted")
    return {"ok": True}


@app.get("/api/sessions/{pin}/tasks/{task_id}/speaking/{student_id}", dependencies=[Depends(require_teacher)])
def read_speaking(pin: str, task_id: str, student_id: str):
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT a.audio, a.media_type FROM speaking_audio a
            JOIN writing_tasks t ON t.task_id = a.task_id
            WHERE t.pin = ? AND a.task_id = ? AND a.student_id = ?
        """), (pin, task_id, student_id))
        row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Recording not found")
    return Response(bytes(row["audio"]), media_type=row["media_type"],
                    headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@app.get("/api/session-history", dependencies=[Depends(require_teacher)])
def session_history(offset: int = 0, query: str = "", status: Literal["active", "ended", "expired"] | None = None):
    title = "r.manifest::json ->> 'title'" if USE_POSTGRES else "json_extract(r.manifest, '$.title')"
    search = query.strip().lower()[:160]
    page_size = 20
    offset = max(offset, 0)
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql(f"""
            WITH history AS (
                SELECT s.pin, s.lesson_id, s.created_at, s.ended_at, s.expires_at,
                       COALESCE({title}, s.lesson_id) AS title,
                       CASE WHEN s.status = 'active' AND (s.expires_at <= ? OR (s.expires_at IS NULL AND s.created_at <= ?))
                            THEN 'expired' ELSE s.status END AS status
                FROM sessions s LEFT JOIN lesson_revisions r ON r.revision_id = SUBSTR(s.lesson_path, 9)
            )
            SELECT *, COUNT(*) OVER () AS total FROM history
            WHERE status = COALESCE(?, status)
              AND (LOWER(title) LIKE ? OR LOWER(lesson_id) LIKE ? OR pin LIKE ?)
            ORDER BY created_at DESC, pin DESC LIMIT ? OFFSET ?
        """), (now_iso(), (datetime.now(timezone.utc) - timedelta(hours=SESSION_TTL_HOURS)).isoformat(),
               status, *([f"%{search}%"] * 3), page_size, offset))
        sessions = [dict(row) for row in cur.fetchall()]
    total = sessions[0]["total"] if sessions else 0
    for session in sessions:
        del session["total"]
    return {"sessions": sessions, "has_more": offset + page_size < total,
            "total_pages": (total + page_size - 1) // page_size, "page_size": page_size}


class DeleteSessionsRequest(BaseModel):
    pins: List[str] = Field(min_length=1, max_length=50)
    confirmation: Literal["DELETE SESSIONS"]


@app.post("/api/session-history/delete", dependencies=[Depends(require_teacher)])
def delete_sessions(payload: DeleteSessionsRequest):
    pins = sorted(set(payload.pins))
    if any(not re.fullmatch(r"[0-9]{4}", pin) for pin in pins):
        raise HTTPException(422, "Invalid session PIN")
    placeholders = ", ".join("?" for _ in pins)
    with closing(db()) as conn:
        cur = conn.cursor()
        if not USE_POSTGRES:
            cur.execute("BEGIN IMMEDIATE")
        lock = " FOR UPDATE" if USE_POSTGRES else ""
        cur.execute(sql(f"SELECT pin, status, created_at, expires_at FROM sessions WHERE pin IN ({placeholders}) ORDER BY pin{lock}"), pins)
        sessions = cur.fetchall()
        if len(sessions) != len(pins):
            raise HTTPException(409, "Some sessions no longer exist. Refresh session history.")
        for session in sessions:
            expires_at = (parse_iso(session["expires_at"]) if session["expires_at"]
                          else parse_iso(session["created_at"]) + timedelta(hours=SESSION_TTL_HOURS))
            if session["status"] == "active" and expires_at > datetime.now(timezone.utc):
                raise HTTPException(409, "End active sessions before deleting them.")

        task_ids = f"SELECT task_id FROM writing_tasks WHERE pin IN ({placeholders})"
        for table in ("speaking_audio", "task_reviews", "writing_task_responses", "task_evidence_context", "task_materials",
                      "published_quiz_scores", "speaking_tasks", "writing_task_quizzes"):
            cur.execute(sql(f"DELETE FROM {table} WHERE task_id IN ({task_ids})"), pins)
        cur.execute(sql(f"""
            DELETE FROM evidence_student_links
            WHERE student_id IN (SELECT student_id FROM session_students WHERE pin IN ({placeholders}))
        """), pins)
        cur.execute(sql(f"DELETE FROM page_task_recipients WHERE task_id IN ({task_ids})"), pins)
        cur.execute(sql(f"DELETE FROM page_task_instances WHERE task_id IN ({task_ids})"), pins)
        cur.execute(sql(f"""
            DELETE FROM session_student_labels
            WHERE student_id IN (SELECT student_id FROM session_students WHERE pin IN ({placeholders}))
        """), pins)
        for table in ("active_writing_tasks", "writing_tasks", "writing_submissions", "writing_assignments",
                      "session_audio_archives", "session_slide_steps", "session_display_modes",
                      "events", "session_students", "sessions"):
            cur.execute(sql(f"DELETE FROM {table} WHERE pin IN ({placeholders})"), pins)
        conn.commit()
    return {"deleted": len(pins)}


def session_evidence(pin):
    session = get_session(pin)
    if not session:
        raise HTTPException(404, "Session not found")
    session = apply_session_expiry(session)
    results = session_task_results(pin)
    if session["writing_task"]:
        legacy = writing_results(pin)
        results["tasks"].insert(0, {"task_id": "legacy-writing", "block_id": None, **legacy["task"],
                                    "submissions": legacy["submissions"]})
    title, version, objective, blocks = session["lesson_id"], None, None, {}
    if session["lesson_path"].startswith("imports/"):
        try:
            lesson = load_imported_lesson(session["lesson_path"].split("/", 1)[1])
            title, version = lesson["title"], lesson["version"]
            objective = lesson.get("objective") or None
            blocks = {block["id"]: block for block in lesson["blocks"]}
        except HTTPException as error:
            if error.status_code != 404:
                raise
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT l.student_id, l.evidence_id, roster.student_id AS reh_student_id FROM evidence_student_links l
            JOIN session_students s ON s.student_id = l.student_id
            JOIN evidence_roster_ids ids ON ids.evidence_id = l.evidence_id
            LEFT JOIN reh_roster roster ON roster.student_id = ids.roster_id
            WHERE s.pin = ?
        """), (pin,))
        students = {row["student_id"]: dict(row) for row in cur.fetchall()}
        cur.execute(sql("""
            SELECT c.task_id, c.phase, c.learning_target_id FROM task_evidence_context c
            JOIN writing_tasks t ON t.task_id = c.task_id WHERE t.pin = ?
        """), (pin,))
        context = {row["task_id"]: dict(row) for row in cur.fetchall()}
    for task in results["tasks"]:
        block = blocks.get(task["block_id"], {})
        saved = context.get(task["task_id"], {})
        task["phase"] = saved.get("phase") or block.get("phase")
        task["learning_target_id"] = saved.get("learning_target_id") or block.get("learning_target_id")
        questions = task.get("questions", [])
        for index, question in enumerate(questions, 1):
            question["question_id"] = question.get("question_id") or f"q{index}"
        for row in task["submissions"]:
            identity = students.get(row["student_id"], {})
            row["learner_id"] = identity.get("evidence_id")
            row["reh_student_id"] = identity.get("reh_student_id")
            if questions:
                row["items"] = [{
                    "question_id": question["question_id"],
                    "learning_target_id": question.get("learning_target_id") or task["learning_target_id"],
                    **item,
                } for question, item in zip(questions, assessment_items(row["response"], questions))]
    audio = [row for task in results["tasks"] for row in task["submissions"] if row.get("audio_bytes")]
    return {"schema_version": 1, "session": {key: session[key] for key in
            ("pin", "lesson_id", "lesson_path", "created_at", "ended_at", "status")},
            "lesson_title": title, "lesson_version": version, "lesson_objective": objective, **results,
            "audio_count": len(audio), "audio_bytes": sum(row["audio_bytes"] for row in audio)}


@app.get("/api/session-history/{pin}", dependencies=[Depends(require_teacher)])
def get_session_evidence(pin: str):
    return session_evidence(pin)


class ManualReview(BaseModel):
    score: Optional[int] = Field(default=None, ge=0, le=100)
    max_score: Optional[int] = Field(default=None, ge=1, le=100)
    feedback: str = Field(default="", max_length=4000)


@app.put("/api/session-history/{pin}/tasks/{task_id}/reviews/{student_id}", dependencies=[Depends(require_teacher)])
def save_review(pin: str, task_id: str, student_id: str, payload: ManualReview):
    if (payload.score is None) != (payload.max_score is None) or (
        payload.score is not None and payload.score > payload.max_score
    ):
        raise HTTPException(422, "Enter a score and maximum, with score no higher than maximum")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT 1 FROM writing_task_responses r JOIN writing_tasks t ON t.task_id = r.task_id
            LEFT JOIN writing_task_quizzes q ON q.task_id = t.task_id
            WHERE t.pin = ? AND r.task_id = ? AND r.student_id = ? AND q.task_id IS NULL
        """), (pin, task_id, student_id))
        if not cur.fetchone():
            raise HTTPException(404, "Writing or Speaking submission not found")
        cur.execute(sql("""
            INSERT INTO task_reviews VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(task_id, student_id) DO UPDATE SET score = excluded.score, max_score = excluded.max_score,
            feedback = excluded.feedback, reviewed_at = excluded.reviewed_at
        """), (task_id, student_id, payload.score, payload.max_score, payload.feedback, now_iso()))
        conn.commit()
    return {"ok": True}


def audio_fingerprint(evidence):
    rows = sorted((task["task_id"], row["student_id"], row["audio_bytes"])
                  for task in evidence["tasks"] for row in task["submissions"] if row.get("audio_bytes"))
    return hashlib.sha256(json.dumps(rows).encode()).hexdigest()


def evidence_csv(evidence):
    output = io.StringIO()
    writer = csv.writer(output)
    columns = ("student_id", "reh_student_id", "learner_id", "student_name", "response", "selected_option", "score", "max_score",
               "review_score", "review_max_score", "feedback", "submitted_at", "reviewed_at", "audio_file")
    writer.writerow(("pin", "lesson_id", "lesson_version", "task_id", "phase", "learning_target_id", "type", "prompt", *columns))
    for task in evidence["tasks"]:
        for row in task["submissions"]:
            values = [evidence["session"]["pin"], evidence["session"]["lesson_id"], evidence["lesson_version"],
                      task["task_id"], task["phase"], task["learning_target_id"], task["type"], task["prompt"], *(row.get(key) for key in columns)]
            writer.writerow(["'" + v if isinstance(v, str) and v.lstrip().startswith(("=", "+", "-", "@")) else v for v in values])
    return output.getvalue().encode("utf-8-sig")


@app.get("/api/session-history/{pin}/archive", dependencies=[Depends(require_teacher)])
def download_session_archive(pin: str):
    evidence = session_evidence(pin)
    archive = tempfile.SpooledTemporaryFile(max_size=4 * 1024 * 1024)
    try:
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle, closing(db()) as conn:
            cur = conn.cursor()
            for task in evidence["tasks"]:
                for row in task["submissions"]:
                    if not row.get("audio_bytes"):
                        continue
                    cur.execute(sql("SELECT audio, media_type FROM speaking_audio WHERE task_id = ? AND student_id = ?"),
                                (task["task_id"], row["student_id"]))
                    recording = cur.fetchone()
                    if not recording:
                        raise HTTPException(409, "Recordings changed. Download the archive again.")
                    extension = {"audio/webm": "webm", "audio/mp4": "m4a", "audio/ogg": "ogg"}[recording["media_type"]]
                    row["audio_file"] = f'audio/{task["task_id"]}_{row["student_id"]}.{extension}'
                    bundle.writestr(row["audio_file"], bytes(recording["audio"]))
            bundle.writestr("evidence.json", json.dumps(evidence, ensure_ascii=False, indent=2))
            bundle.writestr("responses.csv", evidence_csv(evidence))
        if evidence["session"]["status"] != "active" and evidence["audio_count"]:
            with closing(db()) as conn:
                conn.cursor().execute(sql("""
                    INSERT INTO session_audio_archives VALUES (?, ?)
                    ON CONFLICT(pin) DO UPDATE SET fingerprint = excluded.fingerprint
                """), (pin, audio_fingerprint(evidence)))
                conn.commit()
        archive.seek(0)
    except Exception:
        archive.close()
        raise

    def chunks():
        with archive:
            while chunk := archive.read(65536):
                yield chunk

    return StreamingResponse(chunks(), media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="session-{pin}-evidence.zip"',
        "Cache-Control": "private, no-store",
    })


class DeleteSessionAudio(BaseModel):
    confirmation: Literal["DELETE AUDIO"]


@app.post("/api/session-history/{pin}/delete-audio", dependencies=[Depends(require_teacher)])
def delete_session_audio(pin: str, payload: DeleteSessionAudio):
    evidence = session_evidence(pin)
    if evidence["session"]["status"] == "active":
        raise HTTPException(409, "End the session before deleting audio")
    if not evidence["audio_count"]:
        return {"deleted": 0, "audio_bytes": 0}
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("SELECT fingerprint FROM session_audio_archives WHERE pin = ?"), (pin,))
        archive = cur.fetchone()
        if not archive or archive["fingerprint"] != audio_fingerprint(evidence):
            raise HTTPException(409, "Download and verify an archive for this session first")
        deleted = 0
        for task in evidence["tasks"]:
            for row in task["submissions"]:
                if not row.get("audio_bytes"):
                    continue
                cur.execute(sql("DELETE FROM speaking_audio WHERE task_id = ? AND student_id = ? AND LENGTH(audio) = ?"),
                            (task["task_id"], row["student_id"], row["audio_bytes"]))
                deleted += cur.rowcount
        if deleted != evidence["audio_count"]:
            raise HTTPException(409, "Recordings changed. Download the archive again.")
        conn.commit()
    return {"deleted": deleted, "audio_bytes": evidence["audio_bytes"] if deleted else 0}


class CatalogImport(BaseModel):
    csv_text: str = Field(min_length=1, max_length=500000)


CATALOG_COLUMNS = {
    "students": ("student_id", "display_name", "status"),
    "targets": ("learning_target_id", "label", "skill", "level", "status"),
}


def parse_catalog_csv(kind, content):
    columns = CATALOG_COLUMNS[kind]
    reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")), strict=True)
    try:
        headers = reader.fieldnames
    except csv.Error:
        raise HTTPException(422, "Could not parse the CSV header")
    if not headers or len(headers) != len(columns) or set(headers) != set(columns):
        raise HTTPException(422, "CSV headers must be: " + ",".join(columns))
    rows, seen = [], set()
    try:
        for row in reader:
            line = reader.line_num
            if len(rows) >= 5000 or None in row or any(row[key] is None for key in columns):
                raise HTTPException(422, f"Row {line}: check the columns and the 5,000-row limit")
            values = [row[key].strip() for key in columns]
            if not any(values):
                continue
            values[0] = values[0].upper() if kind == "students" else values[0]
            values[-1] = values[-1].lower()
            if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", values[0])
                    or not values[1] or any(len(value) > 300 for value in values)
                    or values[-1] not in {"active", "inactive"}):
                raise HTTPException(422, f"Row {line}: provide a valid ID, name or label, and active/inactive status")
            if values[0] in seen:
                raise HTTPException(422, f"Row {line}: duplicate ID {values[0]}")
            seen.add(values[0])
            rows.append(values)
    except csv.Error:
        raise HTTPException(422, "Could not parse the CSV")
    if not rows:
        raise HTTPException(422, "Include at least one data row")
    return rows


@app.post("/api/catalogs/{kind}/import", dependencies=[Depends(require_teacher)])
def import_catalog(kind: Literal["students", "targets"], payload: CatalogImport):
    rows = parse_catalog_csv(kind, payload.csv_text)
    statements = {
        "students": """INSERT INTO reh_roster VALUES (?, ?, ?)
            ON CONFLICT(student_id) DO UPDATE SET display_name = excluded.display_name, status = excluded.status""",
        "targets": """INSERT INTO learning_targets VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(learning_target_id) DO UPDATE SET label = excluded.label, skill = excluded.skill,
            level = excluded.level, status = excluded.status""",
    }
    with closing(db()) as conn:
        conn.cursor().executemany(sql(statements[kind]), rows)
        conn.commit()
    return {"imported": len(rows)}


@app.get("/api/catalogs/{kind}", dependencies=[Depends(require_teacher)])
def read_catalog(kind: Literal["students", "targets"], active_only: bool = False, offset: int = 0):
    statements = {
        "students": "SELECT * FROM reh_roster",
        "targets": "SELECT * FROM learning_targets",
    }
    column = CATALOG_COLUMNS[kind][0]
    query = statements[kind] + (" WHERE status = 'active'" if active_only else "")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql(query + f" ORDER BY {column} LIMIT 501 OFFSET ?"), (max(offset, 0),))
        rows = [dict(row) for row in cur.fetchall()]
    return {"rows": rows[:500], "has_more": len(rows) > 500}


class CatalogueMetadata(BaseModel):
    course: Optional[str] = Field(default=None, max_length=160)
    title: str = Field(min_length=1, max_length=160)
    level: str = Field(min_length=1, max_length=80)
    cluster: str = Field(min_length=1, max_length=120)


class CatalogueEntryRequest(CatalogueMetadata):
    revision_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class PublishCatalogueRequest(CatalogueEntryRequest):
    expected_revision: str = Field(pattern=r"^[a-f0-9]{32}$")


def catalogue_metadata(payload, default_course="Unassigned course"):
    course = payload.course if payload.course is not None else default_course
    fields = tuple(value.strip() for value in (payload.title, payload.level, payload.cluster, course))
    if not all(fields):
        raise HTTPException(422, "Enter a course, title, level and cluster")
    return fields


def is_newer_lesson_revision(candidate, previous):
    for _ in range(100):
        parent = candidate.get("parent_revision")
        if not parent:
            return False
        if parent == previous:
            return True
        candidate = load_imported_lesson(parent)
    return False


@app.get("/api/lesson-catalogue", dependencies=[Depends(require_teacher)])
def list_catalogue(search: str = "", offset: int = 0):
    search = search.strip().lower()[:160].replace("!", "!!").replace("%", "!%").replace("_", "!_")
    pattern = f"%{search}%"
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT * FROM lesson_catalogue
            WHERE LOWER(title) LIKE ? ESCAPE '!' OR LOWER(level) LIKE ? ESCAPE '!'
               OR LOWER(cluster) LIKE ? ESCAPE '!' OR LOWER(course) LIKE ? ESCAPE '!'
            ORDER BY LOWER(course), LOWER(level), LOWER(title), catalogue_id LIMIT 51 OFFSET ?
        """), (pattern, pattern, pattern, pattern, max(0, offset)))
        entries = [dict(row) for row in cur.fetchall()]
    return {"entries": entries[:50], "has_more": len(entries) > 50}


@app.get("/api/lesson-catalogue/{catalogue_id}", dependencies=[Depends(require_teacher)])
def catalogue_entry(catalogue_id: str):
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("SELECT * FROM lesson_catalogue WHERE catalogue_id = ?"), (catalogue_id,))
        entry = cur.fetchone()
    if not entry:
        raise HTTPException(404, "Catalogue entry not found")
    return dict(entry)


@app.post("/api/lesson-catalogue", dependencies=[Depends(require_teacher)])
def create_catalogue_entry(payload: CatalogueEntryRequest):
    manifest = load_imported_lesson(payload.revision_id)
    title, level, cluster, course = catalogue_metadata(payload)
    catalogue_id = uuid4().hex
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            INSERT INTO lesson_catalogue (catalogue_id, revision_id, title, level, cluster, version, origin, published_at, course)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(revision_id) DO NOTHING
        """), (catalogue_id, payload.revision_id, title, level, cluster, manifest["version"],
               manifest.get("origin", "google_slides"), now_iso(), course))
        if cur.rowcount != 1:
            raise HTTPException(409, "This lesson version is already in the catalogue")
        conn.commit()
    return catalogue_entry(catalogue_id)


@app.put("/api/lesson-catalogue/{catalogue_id}", dependencies=[Depends(require_teacher)])
def publish_catalogue_version(catalogue_id: str, payload: PublishCatalogueRequest):
    entry = catalogue_entry(catalogue_id)
    if entry["revision_id"] != payload.expected_revision:
        raise HTTPException(409, "The published version changed. Reload the catalogue.")
    manifest = load_imported_lesson(payload.revision_id)
    if (manifest.get("origin", "google_slides") != entry["origin"]
            or not is_newer_lesson_revision(manifest, entry["revision_id"])):
        raise HTTPException(422, "Open the published lesson, save a newer version, then publish that version")
    title, level, cluster, course = catalogue_metadata(payload, entry["course"])
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT 1 FROM lesson_catalogue WHERE revision_id = ?
        """), (payload.revision_id,))
        if cur.fetchone():
            raise HTTPException(409, "This lesson version is already in the catalogue")
        cur.execute(sql("""
            UPDATE lesson_catalogue SET revision_id = ?, title = ?, level = ?, cluster = ?, course = ?, version = ?, published_at = ?
            WHERE catalogue_id = ? AND revision_id = ?
        """), (payload.revision_id, title, level, cluster, course, manifest["version"], now_iso(),
               catalogue_id, payload.expected_revision))
        if cur.rowcount != 1:
            raise HTTPException(409, "The published version changed. Reload the catalogue.")
        conn.commit()
    return catalogue_entry(catalogue_id)


class SlideStepRequest(BaseModel):
    block_index: int = Field(ge=0)
    step: int = Field(ge=0, le=30)


@app.post("/api/sessions/{pin}/slide-step", dependencies=[Depends(require_teacher)])
def update_slide_step(pin: str, payload: SlideStepRequest):
    session = require_active_session(pin)
    if not session["lesson_path"].startswith("imports/"):
        raise HTTPException(422, "This lesson has no animated slides")
    blocks = load_imported_lesson(session["lesson_path"].split("/", 1)[1])["blocks"]
    if payload.block_index >= len(blocks):
        raise HTTPException(422, "Invalid block")
    elements = blocks[payload.block_index].get("elements", [])
    steps = {0, *(step for element in elements for step in (element.get("appear"), element.get("disappear")) if step is not None)}
    if not elements or payload.step not in steps:
        raise HTTPException(422, "Invalid slide step")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            INSERT INTO session_slide_steps (pin, block_index, step)
            SELECT pin, current_block_index, ? FROM sessions
            WHERE pin = ? AND current_block_index = ? AND status = 'active'
            ON CONFLICT(pin) DO UPDATE SET block_index = excluded.block_index, step = excluded.step
        """), (payload.step, pin, payload.block_index))
        if cur.rowcount != 1:
            raise HTTPException(409, "The current slide has changed")
        conn.commit()
    return {"slide_step": payload.step}


@app.patch("/api/lesson-catalogue/{catalogue_id}", dependencies=[Depends(require_teacher)])
def edit_catalogue_metadata(catalogue_id: str, payload: CatalogueMetadata):
    entry = catalogue_entry(catalogue_id)
    title, level, cluster, course = catalogue_metadata(payload, entry["course"])
    with closing(db()) as conn:
        conn.cursor().execute(sql("""
            UPDATE lesson_catalogue SET title = ?, level = ?, cluster = ?, course = ? WHERE catalogue_id = ?
        """), (title, level, cluster, course, catalogue_id))
        conn.commit()
    return catalogue_entry(catalogue_id)
