import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AnimatePresence, motion } from "framer-motion";
import { openSSE } from "./sse";
import { WeatherCard } from "./WeatherCard";
import type { Message, UiEvent } from "./types";

const API_BASE = import.meta.env.VITE_API_URL || "";
const CHAT_URL = API_BASE + "/chat";
const STREAM_URL = (runId: string, from: number) =>
  `${API_BASE}/stream/${runId}?from=${from}`;
const THREAD_KEY = "weather-chat.thread_id";
const RUN_KEY = "weather-chat.active_run";  // { run_id, asst_id, offset }

type ActiveRun = { run_id: string; asst_id: string; offset: number };

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const threadIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const savedThread = localStorage.getItem(THREAD_KEY);
    const savedRun = readActiveRun();
    if (savedThread) threadIdRef.current = savedThread;

    (async () => {
      // 1) Подтянем историю треда (чекпоинты из SQLite).
      let hist: any[] = [];
      if (savedThread) {
        try {
          const r = await fetch(`${API_BASE}/history/${savedThread}`);
          if (r.ok) {
            const body = await r.json();
            hist = Array.isArray(body.messages) ? body.messages : [];
          }
        } catch {}
      }

      // 2) Решаем, нужно ли резумить активный ран, ДО рендера истории.
      const last = hist[hist.length - 1];
      const alreadyFinalized =
        !!savedRun && last && last.role === "assistant" && (last.text ?? "").length > 0;

      if (hist.length) {
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

      if (savedRun) {
        if (alreadyFinalized) {
          clearActiveRun();
        } else {
          try { await resumeRun(savedRun); }
          catch { clearActiveRun(); }
        }
      }
    })();
  }, []);

  async function resumeRun(run: ActiveRun) {
    // Добавим плейсхолдер ассистента (если его ещё нет среди восстановленных
    // из истории — в большинстве случаев финального AI ещё не случилось).
    const exists = await new Promise<boolean>((res) => {
      setMessages((m) => {
        const has = m.some((x) => x.id === run.asst_id);
        res(has);
        return m;
      });
    });
    if (!exists) {
      setMessages((m) => [
        ...m,
        {
          id: run.asst_id,
          role: "assistant",
          text: "",
          uiEvents: [],
          pending: true,
          createdAt: Date.now(),
          status: "продолжаю…",
        },
      ]);
    }
    setSending(true);
    try {
      await consume(run);
    } finally {
      setSending(false);
      clearActiveRun();
    }
  }

  function readActiveRun(): ActiveRun | null {
    const raw = localStorage.getItem(RUN_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function writeActiveRun(r: ActiveRun) {
    localStorage.setItem(RUN_KEY, JSON.stringify(r));
  }
  function clearActiveRun() {
    localStorage.removeItem(RUN_KEY);
  }

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }, [input]);

  async function consume(run: ActiveRun) {
    const patchAsst = (fn: (m: Message) => Message) =>
      setMessages((msgs) => msgs.map((m) => (m.id === run.asst_id ? fn(m) : m)));

    try {
      await openSSE({
        url: STREAM_URL(run.run_id, run.offset),
        method: "GET",
        onEvent: (event, data, id) => {
          if (id) run.offset = parseInt(id, 10);

          if (event === "meta") {
            try {
              const parsed = JSON.parse(data);
              if (parsed.thread_id) {
                threadIdRef.current = parsed.thread_id;
                localStorage.setItem(THREAD_KEY, parsed.thread_id);
              }
            } catch {}
          } else if (event === "status") {
            let s = data;
            try { s = JSON.parse(data); } catch {}
            patchAsst((m) => ({ ...m, status: s }));
          } else if (event === "token") {
            let chunk = "";
            try { chunk = JSON.parse(data); } catch { chunk = data; }
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
            patchAsst((m) => ({ ...m, pending: false, status: undefined }));
            clearActiveRun();
          }

          // Сохраняем offset на каждом событии, чтобы переподцепиться с него.
          writeActiveRun(run);
        },
      });
    } catch (e) {
      patchAsst((m) => ({
        ...m,
        pending: false,
        text: m.text || `Ошибка соединения: ${(e as Error).message}`,
      }));
    }
  }

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

    try {
      // Фаза 1: POST /chat — стартуем фоновый run, получаем run_id.
      const r = await fetch(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, thread_id: threadIdRef.current }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { run_id, thread_id } = await r.json();
      threadIdRef.current = thread_id;
      localStorage.setItem(THREAD_KEY, thread_id);

      const run: ActiveRun = { run_id, asst_id: asstId, offset: 0 };
      writeActiveRun(run);

      // Фаза 2: GET /stream/{run_id} — подписываемся, получаем события.
      await consume(run);
    } catch (e) {
      setMessages((msgs) =>
        msgs.map((m) =>
          m.id === asstId
            ? { ...m, pending: false, text: m.text || `Ошибка: ${(e as Error).message}` }
            : m
        )
      );
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
        <h1 className="text-lg font-semibold tracking-tight">Weather Chat</h1>
        <button
          onClick={async () => {
            const tid = threadIdRef.current;
            if (tid) {
              try {
                await fetch(`${API_BASE}/history/${tid}`, { method: "DELETE" });
              } catch {}
            }
            localStorage.removeItem(THREAD_KEY);
            clearActiveRun();
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
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-5 w-5"
            >
              <path d="M3 20.5 21 12 3 3.5v7L14 12 3 13.5v7Z" />
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
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={`flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`flex flex-col gap-1 ${
          isUser ? "max-w-[75%] items-end" : "w-full max-w-md items-start"
        }`}
      >
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
              <AnimatePresence mode="wait">
                {msg.status && (
                  <motion.span
                    key={msg.status}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18 }}
                    className="text-xs italic"
                  >
                    {msg.status}…
                  </motion.span>
                )}
              </AnimatePresence>
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
          ev.type === "weather_card" ? (
            <motion.div
              key={i}
              initial={{ opacity: 0, scale: 0.96, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.25, ease: "easeOut" }}
              className="w-full"
            >
              <WeatherCard data={ev.payload} />
            </motion.div>
          ) : null
        )}
      </div>
    </motion.div>
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
