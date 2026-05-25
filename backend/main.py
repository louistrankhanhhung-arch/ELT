from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from random import randint
from datetime import datetime, timezone
from typing import Dict, List, Optional


app = FastAPI(title="ELT Runtime API v0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
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


class JoinSessionRequest(BaseModel):
    student_name: str


class Session(BaseModel):
    pin: str
    lesson_id: str
    lesson_path: str
    total_blocks: int
    current_block_index: int = 0
    status: str = "active"
    students: List[dict] = []
    created_at: str


sessions: Dict[str, Session] = {}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def generate_pin() -> str:
    for _ in range(20):
        pin = str(randint(1000, 9999))
        if pin not in sessions:
            return pin
    raise RuntimeError("Could not generate unique PIN")


@app.get("/api/health")
def health():
    return {"ok": True, "service": "ELT Runtime API"}


@app.post("/api/sessions/start")
def start_session(payload: StartSessionRequest):
    pin = generate_pin()

    session = Session(
        pin=pin,
        lesson_id=payload.lesson_id,
        lesson_path=payload.lesson_path,
        total_blocks=payload.total_blocks,
        created_at=now_iso(),
    )

    sessions[pin] = session

    return session


@app.get("/api/sessions/{pin}/state")
def get_session_state(pin: str):
    session = sessions.get(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return session


@app.post("/api/sessions/{pin}/join")
def join_session(pin: str, payload: JoinSessionRequest):
    session = sessions.get(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    student_id = f"s{len(session.students) + 1}"

    student = {
        "student_id": student_id,
        "student_name": payload.student_name,
        "joined_at": now_iso(),
        "last_seen_at": now_iso(),
    }

    session.students.append(student)

    return {
        "pin": pin,
        "student": student,
        "session": session,
    }


@app.post("/api/sessions/{pin}/next")
def next_block(pin: str):
    session = sessions.get(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.current_block_index < session.total_blocks - 1:
        session.current_block_index += 1

    return session


@app.post("/api/sessions/{pin}/previous")
def previous_block(pin: str):
    session = sessions.get(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.current_block_index > 0:
        session.current_block_index -= 1

    return session

@app.post("/api/sessions/{pin}/block/{index}")
def set_block(pin: str, index: int):
    session = sessions.get(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if index < 0 or index >= session.total_blocks:
        raise HTTPException(status_code=400, detail="Invalid block index")

    session.current_block_index = index

    return session

@app.post("/api/sessions/{pin}/end")
def end_session(pin: str):
    session = sessions.get(pin)

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    session.status = "ended"

    return session
