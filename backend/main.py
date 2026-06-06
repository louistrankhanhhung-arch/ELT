from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from random import randint
from datetime import datetime, timezone, timedelta
from typing import List
import os
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
SESSION_TTL_HOURS = 4

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
    student_name: str

class EventRequest(BaseModel):
    student_id: str
    block_index: int
    block_id: str
    event_type: str

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

    conn.close()

    data = dict(session)
    data["students"] = students
    data["events"] = events
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

@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "ELT Runtime API",
        "db": "postgres" if USE_POSTGRES else "sqlite",
    }


@app.post("/api/sessions/start")
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
def get_session_state(pin: str):
    session = get_session(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return apply_session_expiry(session)


@app.post("/api/sessions/{pin}/join")
def join_session(pin: str, payload: JoinSessionRequest):
    session = require_active_session(pin)
    
    conn = db()
    cur = conn.cursor()

    cur.execute(
        sql("SELECT COUNT(*) AS count FROM session_students WHERE pin = ?"),
        (pin,)
    )
    count = cur.fetchone()["count"]

    student_id = f"{pin}-s{count + 1}"

    student = {
        "student_id": student_id,
        "pin": pin,
        "student_name": payload.student_name,
        "joined_at": now_iso(),
        "last_seen_at": now_iso(),
    }

    cur.execute(sql("""
        INSERT INTO session_students (
            student_id, pin, student_name, joined_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?)
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
        "session": get_session(pin),
    }


@app.post("/api/sessions/{pin}/next")
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


@app.post("/api/sessions/{pin}/previous")
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


@app.post("/api/sessions/{pin}/block/{index}")
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


@app.post("/api/sessions/{pin}/end")
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
