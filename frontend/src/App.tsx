import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { streamSSE } from "./sse";
import { WeatherCard } from "./WeatherCard";
import type { Message, UiEvent } from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "";
const CHAT_URL = API_BASE + "/chat";
const THREAD_KEY = "weather-chat.thread_id";

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const threadIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(THREAD_KEY);
    if (!saved) return;
    threadIdRef.current = saved;
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/history/${saved}`);
        if (!r.ok) return;
        const { messages: hist } = await r.json();
        if (Array.isArray(hist) && hist.length) {
          setMessages(
            hist.map((m: any, i: number) => ({
              id: m.id ?? `h-${i}`,
              role: m.role,
              text: m.text ?? "",
              uiEvents: m.uiEvents ?? [],
              createdAt: m.createdAt ?? Date.now() - (hist.length - i) * 1000,
            }))
          );
        }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);

    const now = Date.now();
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      uiEvents: [],
      createdAt: now,
    };
    const asstId = crypto.randomUUID();
    const asstMsg: Message = {
      id: asstId,
      role: "assistant",
      text: "",
      uiEvents: [],
      pending: true,
      createdAt: now,
    };
    setMessages((m) => [...m, userMsg, asstMsg]);

    const patchAsst = (fn: (m: Message) => Message) =>
      setMessages((msgs) => msgs.map((m) => (m.id === asstId ? fn(m) : m)));

    try {
      await streamSSE(
        CHAT_URL,
        { message: text, thread_id: threadIdRef.current },
        (event, data) => {
          if (event === "meta") {
            try {
              const parsed = JSON.parse(data);
              if (parsed.thread_id) {
                threadIdRef.current = parsed.thread_id;
                localStorage.setItem(THREAD_KEY, parsed.thread_id);
              }
            } catch {}
            return;
          }
          if (event === "status") {
            let s = data;
            try { s = JSON.parse(data); } catch {}
            patchAsst((m) => ({ ...m, status: s }));
          } else if (event === "token") {
            let chunk = "";
            try {
              chunk = JSON.parse(data);
            } catch {
              chunk = data;
            }
            patchAsst((m) => ({
              ...m,
              pending: false,
              status: undefined,
              text: m.text + chunk,
              createdAt: m.text ? m.createdAt : Date.now(),
            }));
          } else if (event === "ui_event") {
            try {
              const parsed = JSON.parse(data) as UiEvent;
              patchAsst((m) => ({ ...m, uiEvents: [...m.uiEvents, parsed] }));
            } catch {}
          } else if (event === "done") {
            patchAsst((m) => ({ ...m, pending: false }));
          }
        }
      );
    } catch (e) {
      patchAsst((m) => ({
        ...m,
        pending: false,
        text: m.text || `Ошибка: ${(e as Error).message}`,
      }));
    } finally {
      setSending(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col px-4">
      <header className="flex items-center justify-between py-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Weather Chat</h1>
          <p className="text-xs text-slate-500">LangGraph · FastAPI · SSE</p>
        </div>
        <button
          onClick={async () => {
            const tid = threadIdRef.current;
            if (tid) {
              try {
                await fetch(`${API_BASE}/history/${tid}`, { method: "DELETE" });
              } catch {}
            }
            localStorage.removeItem(THREAD_KEY);
            threadIdRef.current = null;
            setMessages([]);
          }}
          className="rounded-lg px-3 py-1.5 text-xs text-slate-400 ring-1 ring-white/10 transition hover:bg-white/5 hover:text-slate-200"
        >
          Новый чат
        </button>
      </header>

      <div
        ref={listRef}
        className="chat-scroll flex-1 space-y-6 overflow-y-auto rounded-2xl bg-[#17181d] p-5 ring-1 ring-white/5"
      >
        {messages.length === 0 && (
          <div className="pt-16 text-center text-sm text-slate-500">
            Спроси, например: «Какая погода в Берлине?»
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} msg={m} />
        ))}
      </div>

      <div className="flex items-end gap-2 py-4">
        <div className="flex flex-1 items-end rounded-2xl bg-[#17181d] px-4 py-2.5 ring-1 ring-white/10 focus-within:ring-sky-500">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            rows={1}
            placeholder="Напиши сообщение..."
            className="chat-scroll flex-1 resize-none bg-transparent text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500"
            style={{ maxHeight: 200 }}
          />
        </div>
        <button
          onClick={send}
          disabled={sending || !input.trim()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-500 text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700"
          aria-label="Отправить"
        >
          {sending ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 -translate-x-[1px]">
              <path d="M3.4 20.4 20.85 12.92a1 1 0 0 0 0-1.84L3.4 3.6a1 1 0 0 0-1.38 1.2L4.5 11 12 12l-7.5 1-2.48 6.2a1 1 0 0 0 1.38 1.2Z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[75%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={
            "text-sm leading-relaxed " +
            (isUser
              ? "rounded-2xl rounded-tr-md bg-sky-500 px-4 py-2.5 text-white shadow-sm"
              : "rounded-2xl rounded-tl-md bg-white/[0.04] px-4 py-2.5 text-slate-100 ring-1 ring-white/10 backdrop-blur")
          }
        >
          {msg.pending && !msg.text ? (
            <div className="flex items-center gap-2 text-slate-400">
              <TypingDots />
              {msg.status && <span className="text-xs italic">{msg.status}…</span>}
            </div>
          ) : isUser ? (
            <div className="whitespace-pre-wrap">{msg.text}</div>
          ) : (
            <MarkdownBody text={msg.text} />
          )}
        </div>

        <div className={`px-1 text-[11px] text-slate-500 ${isUser ? "text-right" : "text-left"}`}>
          {formatTime(msg.createdAt)}
        </div>

        {msg.uiEvents.map((ev, i) =>
          ev.type === "weather_card" ? <WeatherCard key={i} data={ev.payload} /> : null
        )}
      </div>
    </div>
  );
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1">
      <Dot delay="0s" />
      <Dot delay="0.15s" />
      <Dot delay="0.3s" />
    </span>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-2 w-2 animate-bounce rounded-full bg-slate-400"
      style={{ animationDelay: delay }}
    />
  );
}
