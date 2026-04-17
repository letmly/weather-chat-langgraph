import os
import json
import logging
from typing import Annotated, TypedDict, AsyncIterator

logger = logging.getLogger("agent")

from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
    trim_messages,
)
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from .weather import fetch_weather

DB_PATH = os.getenv("CHAT_DB_PATH", "chat.db")


SYSTEM_PROMPT = (
    "Ты — дружелюбный ассистент. Отвечай кратко и по-русски. "
    "Когда у тебя есть данные от инструмента, дай короткий человеческий ответ "
    "в одно-два предложения, не перечисляя все цифры — подробности покажет UI."
)


@tool
async def get_weather(city: str) -> str:
    """Получить актуальную погоду в указанном городе прямо сейчас.

    Используй этот инструмент всегда, когда пользователь спрашивает про текущую
    погоду, температуру, осадки, ветер или влажность в каком-либо городе.
    Не угадывай и не придумывай данные — всегда вызывай инструмент.

    Args:
        city: Название города (например, "Berlin", "Москва", "Tokyo").

    Returns:
        JSON-строка с полями: city, country, temp (°C), feels_like, condition,
        icon, humidity (%), wind (м/с).
    """
    data = await fetch_weather(city)
    return json.dumps(data, ensure_ascii=False)


class State(TypedDict):
    messages: Annotated[list, add_messages]


def _build_llm():
    return ChatOpenAI(
        model=os.getenv("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
        api_key=os.getenv("OPENROUTER_API_KEY"),
        base_url=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
        temperature=0.3,
    )


TOOLS = [get_weather]


_CHECKPOINTER_CM = None
_CHECKPOINTER = None


async def _get_checkpointer() -> AsyncSqliteSaver:
    """Ленивая инициализация SQLite-чекпоинтера (один раз на процесс)."""
    global _CHECKPOINTER_CM, _CHECKPOINTER
    if _CHECKPOINTER is None:
        _CHECKPOINTER_CM = AsyncSqliteSaver.from_conn_string(DB_PATH)
        _CHECKPOINTER = await _CHECKPOINTER_CM.__aenter__()
        logger.info("[checkpointer] SQLite %s", DB_PATH)
    return _CHECKPOINTER


_GRAPH_CACHE = None


async def _get_graph():
    global _GRAPH_CACHE
    if _GRAPH_CACHE is None:
        checkpointer = await _get_checkpointer()
        _GRAPH_CACHE = _build_graph(checkpointer)
    return _GRAPH_CACHE


def _build_graph(checkpointer):
    llm = _build_llm().bind_tools(TOOLS)

    async def call_model(state: State):
        msgs = state["messages"]
        if not msgs or not isinstance(msgs[0], SystemMessage):
            msgs = [SystemMessage(content=SYSTEM_PROMPT)] + list(msgs)
        # Обрезаем историю, чтоб не раздувать контекст:
        # strategy="last" — берём хвост, start_on="human" + include_system=True
        # гарантируют корректный ai/tool-баланс и сохранение system-промпта.
        trimmed = trim_messages(
            msgs,
            max_tokens=int(os.getenv("MAX_HISTORY_MESSAGES", "20")),
            strategy="last",
            token_counter=len,
            include_system=True,
            start_on="human",
            allow_partial=False,
        )
        if len(trimmed) < len(msgs):
            logger.info("[model] триммер: %d → %d сообщений", len(msgs), len(trimmed))
        msgs = trimmed
        logger.info("[model] вход: %d сообщений", len(msgs))
        full = None
        async for chunk in llm.astream(msgs):
            full = chunk if full is None else full + chunk
        tc = getattr(full, "tool_calls", []) or []
        if tc:
            logger.info("[model] tool_calls: %s", [(t["name"], t["args"]) for t in tc])
        else:
            preview = (full.content or "")[:120].replace("\n", " ")
            logger.info("[model] ответ: %r", preview)
        return {"messages": [full]}

    async def call_tools(state: State):
        last = state["messages"][-1]
        outputs = []
        for tc in last.tool_calls:
            logger.info("[tool] вызов %s(%s)", tc["name"], tc["args"])
            if tc["name"] == "get_weather":
                try:
                    result = await get_weather.ainvoke(tc["args"])
                    logger.info("[tool] результат: %s", result[:200])
                except Exception as e:
                    logger.exception("[tool] ошибка")
                    result = json.dumps({"error": str(e)}, ensure_ascii=False)
                outputs.append(
                    ToolMessage(content=result, tool_call_id=tc["id"], name=tc["name"])
                )
        return {"messages": outputs}

    def should_continue(state: State):
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tools"
        return END

    graph = StateGraph(State)
    graph.add_node("model", call_model)
    graph.add_node("tools", call_tools)
    graph.set_entry_point("model")
    graph.add_conditional_edges("model", should_continue, {"tools": "tools", END: END})
    graph.add_edge("tools", "model")
    return graph.compile(checkpointer=checkpointer)


async def stream_chat(message: str, thread_id: str) -> AsyncIterator[dict]:
    """Стримит SSE-события:
    - {type: "token", data: "..."} — кусочек текста ответа
    - {type: "ui_event", data: {...}} — structured UI payload (weather card)
    - {type: "done"}
    """
    logger.info("[chat] thread=%s msg=%r", thread_id, message[:200])
    graph = await _get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    inputs = {"messages": [HumanMessage(content=message)]}

    async for event in graph.astream_events(inputs, config=config, version="v2"):
        kind = event["event"]

        if kind == "on_chat_model_stream":
            chunk: AIMessageChunk = event["data"]["chunk"]
            if chunk.content:
                yield {"type": "token", "data": chunk.content}

        elif kind == "on_tool_end" and event.get("name") == "get_weather":
            raw = event["data"].get("output")
            payload = raw.content if hasattr(raw, "content") else raw
            try:
                parsed = json.loads(payload) if isinstance(payload, str) else payload
            except Exception:
                parsed = {"raw": str(payload)}
            if "error" not in parsed:
                yield {
                    "type": "ui_event",
                    "data": {"type": "weather_card", "payload": parsed},
                }

    yield {"type": "done"}


async def delete_history(thread_id: str) -> None:
    """Удаляет все чекпоинты треда из SQLite."""
    cp = await _get_checkpointer()
    await cp.adelete_thread(thread_id)


async def load_history(thread_id: str) -> list[dict]:
    """Достаёт сообщения треда из чекпоинтера и приводит к формату фронта.

    Возвращает список {id, role, text, uiEvents, createdAt}.
    UI-события для погоды восстанавливаем из ToolMessage.content
    (там лежит тот же JSON, что мы кидали через ui_event).
    """
    graph = await _get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    state = await graph.aget_state(config)
    if not state or not state.values:
        return []

    result: list[dict] = []
    pending_cards: list[dict] = []

    for m in state.values.get("messages", []):
        cls = m.__class__.__name__
        if cls == "SystemMessage":
            continue

        if cls == "ToolMessage" and getattr(m, "name", None) == "get_weather":
            try:
                parsed = json.loads(m.content)
                if "error" not in parsed:
                    pending_cards.append({"type": "weather_card", "payload": parsed})
            except Exception:
                pass
            continue

        if cls == "HumanMessage":
            result.append({
                "id": getattr(m, "id", None) or f"h-{len(result)}",
                "role": "user",
                "text": m.content or "",
                "uiEvents": [],
            })
        elif cls == "AIMessage":
            content = m.content or ""
            if not content and not pending_cards:
                continue
            result.append({
                "id": getattr(m, "id", None) or f"a-{len(result)}",
                "role": "assistant",
                "text": content,
                "uiEvents": pending_cards,
            })
            pending_cards = []

    return result
