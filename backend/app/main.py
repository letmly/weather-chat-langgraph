import json
import logging
import os
import uuid
from typing import Optional

from dotenv import load_dotenv
from pathlib import Path

# Единый источник: корневой /task/.env. Раньше был дубликат backend/.env —
# расходился с корневым. Ищем .env относительно этого файла: app/main.py →
# /task/.env = parents[2].
_ROOT_ENV = Path(__file__).resolve().parents[2] / ".env"
if _ROOT_ENV.exists():
    load_dotenv(_ROOT_ENV)
else:
    load_dotenv()  # fallback (например, в докере cwd=/app)

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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .agent import stream_chat, load_history, delete_history

app = FastAPI(title="Weather Agent")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str
    thread_id: Optional[str] = None


@app.get("/health")
async def health():
    return {"ok": True}


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
    thread_id = req.thread_id or str(uuid.uuid4())
    logger.info("POST /chat thread=%s msg=%r", thread_id, req.message[:200])

    def sse(event: str, data) -> str:
        # Всегда JSON-кодируем, иначе \n внутри токена (абзацы markdown,
        # list items) ломает SSE-формат и теряется на клиенте.
        payload = json.dumps(data, ensure_ascii=False)
        return f"event: {event}\ndata: {payload}\n\n"

    async def event_gen():
        yield sse("meta", {"thread_id": thread_id})
        try:
            async for ev in stream_chat(req.message, thread_id):
                logger.debug("SSE yield %s", ev["type"])
                yield sse(ev["type"], ev.get("data", ""))
        except Exception as e:
            logger.exception("stream_chat failed")
            yield sse("error", str(e))

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
