from pathlib import Path
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from random import randint
from datetime import datetime, timezone, timedelta
from typing import List, Literal, Optional
import csv
import hashlib
import io
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
    cur.execute(sql("SELECT prompt, assigned_at FROM writing_assignments WHERE pin = ?"), (pin,))
    writing = cur.fetchone()
    cur.execute(sql("""
        SELECT t.task_id, t.block_id, t.prompt, t.assigned_at, q.definition FROM active_writing_tasks a
        JOIN writing_tasks t ON t.task_id = a.task_id
        LEFT JOIN writing_task_quizzes q ON q.task_id = t.task_id WHERE a.pin = ?
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
        task = block.get("task")
        if task and task.get("type") == "multiple_choice":
            task.pop("correct_option", None)
            for question in task.get("questions", []):
                question.pop("correct_option", None)
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


class QuizQuestion(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)
    options: List[str] = Field(min_length=2, max_length=8)
    correct_option: int = Field(ge=0, le=7)

    def normalized(self):
        options = [option.strip() for option in self.options]
        if not self.prompt.strip() or any(not option or len(option) > 1000 for option in options):
            raise HTTPException(422, "Enter a question and options of up to 1000 characters each")
        if len(set(options)) != len(options) or self.correct_option >= len(options):
            raise HTTPException(422, "Use distinct options and select an existing correct option")
        return {"prompt": self.prompt.strip(), "options": options, "correct_option": self.correct_option}


class QuizDefinition(BaseModel):
    questions: Optional[List[QuizQuestion]] = Field(default=None, min_length=1, max_length=30)
    shuffle: bool = False
    options: Optional[List[str]] = None
    correct_option: Optional[int] = None

    def normalized(self, prompt):
        if self.questions is not None:
            return {"questions": [question.normalized() for question in self.questions], "shuffle": self.shuffle}
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


def grade_quiz(raw, quiz, prompt):
    questions = quiz_questions(quiz, prompt)
    answers = quiz_answers(raw, questions)
    selected = [question["options"][answer] for answer, question in zip(answers, questions)]
    score = sum(answer == question["correct_option"] for answer, question in zip(answers, questions))
    return {"selected_option": selected[0] if len(selected) == 1 else json.dumps(selected, ensure_ascii=False),
            "score": score, "max_score": len(questions)}


def task_description(row):
    definition = row.pop("definition", None)
    task = {"schema_version": 1, "type": "multiple_choice" if definition else "writing", **row}
    if definition:
        quiz = json.loads(definition)
        task["questions"] = [{"prompt": q["prompt"], "options": q["options"]} for q in quiz_questions(quiz, task["prompt"])]
        task["shuffle"] = quiz.get("shuffle", False)
        if len(task["questions"]) == 1:
            task["options"] = task["questions"][0]["options"]
    return task


class PreparedWritingRequest(WritingAssignmentRequest):
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
    blocks.insert(payload.after_block + 1, {
        "id": block_id, "type": "activity", "activity_kind": "writing-task",
        "title": "Multiple-choice task" if quiz else "Writing task",
        "task": {"schema_version": 1, "type": "multiple_choice" if quiz else "writing", "prompt": prompt, **(quiz or {})},
        "completion": {"mode": "teacher_next"},
    })
    manifest["lesson_id"] = f"slides-{revision_id}"
    manifest["version"] = str(int(manifest["version"]) + 1)
    with closing(db()) as conn:
        conn.cursor().execute(sql("INSERT INTO lesson_revisions VALUES (?, ?)"), (revision_id, json.dumps(manifest)))
        conn.commit()
    return {"lesson_path": f"imports/{revision_id}", "block_index": payload.after_block + 1}


class SessionWritingRequest(BaseModel):
    quiz: Optional[QuizDefinition] = None
    prompt: Optional[str] = Field(default=None, max_length=4000)
    block_id: Optional[str] = None


@app.post("/api/sessions/{pin}/tasks/writing", dependencies=[Depends(require_teacher)])
def assign_session_writing(pin: str, payload: SessionWritingRequest):
    session = require_active_session(pin)
    prompt = (payload.prompt or "").strip()
    quiz = payload.quiz.normalized(prompt) if payload.quiz else None
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
        quiz = ({key: block["task"][key] for key in ("questions", "shuffle", "options", "correct_option") if key in block["task"]}
                if block["task"]["type"] == "multiple_choice" else None)
    if not prompt:
        raise HTTPException(422, "Enter a writing prompt")
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
        elif quiz:
            cur.execute(sql("INSERT INTO writing_task_quizzes VALUES (?, ?)"), (task_id, json.dumps(quiz)))
        cur.execute(sql("""
            INSERT INTO active_writing_tasks VALUES (?, ?)
            ON CONFLICT(pin) DO UPDATE SET task_id = excluded.task_id
        """), (pin, task_id))
        conn.commit()
    return {"task_id": task_id}


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
            active = session["active_writing_task"]
            if not active or active["task_id"] != task_id or session["display_mode"] != "interact":
                raise HTTPException(409, "This task is not open for submissions")
            if active["type"] == "multiple_choice":
                quiz_answers(payload.response, active["questions"])
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
def session_task_results(pin: str):
    session = get_session(pin)
    if not session:
        raise HTTPException(404, "Session not found")
    with closing(db()) as conn:
        cur = conn.cursor()
        cur.execute(sql("""
            SELECT t.task_id, t.block_id, t.prompt, t.assigned_at, q.definition
            FROM writing_tasks t LEFT JOIN writing_task_quizzes q ON q.task_id = t.task_id
            WHERE t.pin = ? ORDER BY t.assigned_at, t.task_id
        """), (pin,))
        tasks = [dict(row) for row in cur.fetchall()]
        cur.execute(sql("""
            SELECT r.task_id, r.student_id, s.student_name, r.response, r.submitted_at
            FROM writing_task_responses r JOIN writing_tasks t ON t.task_id = r.task_id
            JOIN session_students s ON s.student_id = r.student_id
            WHERE t.pin = ? ORDER BY r.submitted_at, r.student_id
        """), (pin,))
        responses = [dict(row) for row in cur.fetchall()]
    for task in tasks:
        definition = task.pop("definition")
        quiz = json.loads(definition) if definition else None
        task["type"] = "multiple_choice" if quiz else "writing"
        task["scores_published"] = task["task_id"] in session["published_score_ids"]
        task["submissions"] = [row for row in responses if row["task_id"] == task["task_id"]]
        if quiz:
            task.update(quiz)
            task["questions"] = quiz_questions(quiz, task["prompt"])
            for row in task["submissions"]:
                row.update(grade_quiz(row["response"], quiz, task["prompt"]))
    return {"joined": len(session["students"]), "tasks": tasks}


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
        grade = grade_quiz(row["response"], json.loads(row["definition"]), row["prompt"])
        scores.append({"task_id": row["task_id"], "title": row["prompt"],
                       "score": grade["score"], "max_score": grade["max_score"]})
    return {"scores": scores}


class WorkBlock(BaseModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_-]+$")
    phase: Literal["diagnosis", "teach", "practice", "retrieve", "production", "verify"]
    kind: Literal["slide", "writing", "multiple_choice"]
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(default="", max_length=4000)
    notes: str = Field(default="", max_length=4000)
    media_type: Optional[Literal["image", "audio", "video"]] = None
    media_url: Optional[str] = Field(default=None, max_length=2000)
    prompt: str = Field(default="", max_length=4000)
    quiz: Optional[QuizDefinition] = None


class WorkLesson(BaseModel):
    schema_version: Literal[1]
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
                 "completion": {"mode": "teacher_next"}}
        if block.kind == "slide":
            media = block.media_url
            if bool(media) != bool(block.media_type):
                raise HTTPException(422, f"Block {block.id}: enter both a media type and URL")
            if media:
                url = urlsplit(media)
                if url.scheme != "https" or not url.hostname or url.username or url.password:
                    raise HTTPException(422, f"Block {block.id}: use a direct HTTPS media URL")
            entry.update(activity_kind="native-slide", body=block.body,
                         media_type=block.media_type, media_url=media, native_revision=revision)
        else:
            prompt = block.prompt.strip()
            if not prompt or (block.kind == "multiple_choice") != bool(block.quiz):
                raise HTTPException(422, f"Block {block.id}: enter a prompt and the required task options")
            quiz = block.quiz.normalized(prompt) if block.quiz else {}
            entry.update(activity_kind="writing-task",
                         task={"schema_version": 1, "type": block.kind, "prompt": prompt, **quiz})
        blocks.append(entry)
    manifest = {"lesson_id": f"work-{revision}", "title": lesson.title.strip(), "version": str(version),
                "origin": "work", "objective": lesson.objective, "blocks": blocks,
                "work_source": lesson.model_dump(exclude_none=True)}
    with closing(db()) as conn:
        conn.cursor().execute(sql("INSERT INTO lesson_revisions VALUES (?, ?)"), (revision, json.dumps(manifest)))
        conn.commit()
    return {"revision": revision, "version": version, "lesson_path": f"imports/{revision}"}
