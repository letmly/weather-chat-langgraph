import asyncio
import json
import logging
import os
import time
import uuid
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

os.makedirs("logs", exist_ok=True)
_fmt = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s", "%H:%M:%S")
_stream_h = logging.StreamHandler()
_stream_h.setFormatter(_fmt)
_file_h = logging.FileHandler("logs/agent.log", encoding="utf-8")
_file_h.setFormatter(_fmt)
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    handlers=[_stream_h, _file_h],
    force=True,
)
logger = logging.getLogger("api")

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .agent import stream_chat, load_history, delete_history


# ---------------------------------------------------------------------------
# Run buffer: события генерации живут в памяти процесса независимо от HTTP.
# Клиент может отконнектиться и переподключиться к тому же run_id, докачав
# события с последнего offset'а (SSE-поле "id").
# ---------------------------------------------------------------------------

RUN_TTL_AFTER_DONE = 300  # сек


class RunBuffer:
    def __init__(self, thread_id: str) -> None:
        self.thread_id = thread_id
        self.events: list[dict] = []
        self.done: bool = False
        self.completed_at: float | None = None
        self._signal = asyncio.Event()

    def push(self, ev: dict) -> None:
        self.events.append(ev)
        old = self._signal
        self._signal = asyncio.Event()
        old.set()

    def finish(self) -> None:
        self.done = True
        self.completed_at = time.time()
        self._signal.set()

    @property
    def signal(self) -> asyncio.Event:
        return self._signal


RUNS: dict[str, RunBuffer] = {}


async def _gc_loop() -> None:
    while True:
        try:
            await asyncio.sleep(60)
            now = time.time()
            dead = [
                rid for rid, rb in RUNS.items()
                if rb.done and rb.completed_at and now - rb.completed_at > RUN_TTL_AFTER_DONE
            ]
            for rid in dead:
                RUNS.pop(rid, None)
            if dead:
                logger.info("[gc] удалено %d завершённых run'ов", len(dead))
        except Exception:
            logger.exception("[gc] loop error")


async def _run(run_id: str, message: str, thread_id: str) -> None:
    """Фоновая таска: крутит агента, складывает события в RunBuffer."""
    rb = RUNS[run_id]
    try:
        async for ev in stream_chat(message, thread_id):
            rb.push(ev)
    except Exception as e:
        logger.exception("[run %s] failure", run_id)
        rb.push({"type": "error", "data": str(e)})
    finally:
        rb.finish()
        logger.info("[run %s] finished (%d events)", run_id, len(rb.events))


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Weather Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(_gc_loop())


class ChatRequest(BaseModel):
    message: str
    thread_id: Optional[str] = None


@app.get("/health")
async def health():
    return {"ok": True, "runs_in_memory": len(RUNS)}


@app.get("/history/{thread_id}")
async def history(thread_id: str):
    logger.info("GET /history thread=%s", thread_id)
    msgs = await load_history(thread_id)
    return {"thread_id": thread_id, "messages": msgs}


@app.delete("/history/{thread_id}")
async def history_delete(thread_id: str):
    logger.info("DELETE /history thread=%s", thread_id)
    await delete_history(thread_id)
    return {"ok": True}


@app.post("/chat")
async def chat(req: ChatRequest):
    """Стартует ран агента в фоне. Возвращает {run_id, thread_id} сразу —
    НЕ ждёт ответа LLM и НЕ привязывается к жизни HTTP-коннекшена."""
    thread_id = req.thread_id or str(uuid.uuid4())
    run_id = str(uuid.uuid4())
    RUNS[run_id] = RunBuffer(thread_id)
    asyncio.create_task(_run(run_id, req.message, thread_id))
    logger.info("POST /chat → run=%s thread=%s msg=%r", run_id, thread_id, req.message[:200])
    return {"run_id": run_id, "thread_id": thread_id}


@app.get("/stream/{run_id}")
async def stream(run_id: str, request: Request):
    """SSE-стрим событий рана с поддержкой переподключения по offset'у
    (query `?from=N`). Каждое событие содержит `id: N` для синхронизации."""
    rb = RUNS.get(run_id)
    if rb is None:
        raise HTTPException(status_code=404, detail="run not found or expired")

    try:
        start_from = int(request.query_params.get("from", "0"))
    except ValueError:
        start_from = 0

    def fmt(offset: int, ev: dict) -> str:
        payload = ev.get("data", "")
        if not isinstance(payload, str):
            payload = json.dumps(payload, ensure_ascii=False)
        return f"id: {offset}\nevent: {ev['type']}\ndata: {payload}\n\n"

    async def gen():
        # сразу отдадим meta с thread_id — чтобы фронт (или curl) мог сразу узнать
        yield f"event: meta\ndata: {json.dumps({'thread_id': rb.thread_id, 'run_id': run_id})}\n\n"

        offset = max(0, start_from)
        while True:
            # Захватываем текущий signal ПЕРЕД чтением событий (TOCTOU-safe).
            signal = rb.signal
            while offset < len(rb.events):
                yield fmt(offset + 1, rb.events[offset])
                offset += 1
            if rb.done:
                return
            await signal.wait()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
