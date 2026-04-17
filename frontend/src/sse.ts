export type SSEHandler = (event: string, data: string, id?: string) => void;

export type SSEOpts = {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  onEvent: SSEHandler;
  signal?: AbortSignal;
};

/**
 * POST/GET + стриминг SSE через fetch/ReadableStream.
 * Парсит event:/data:/id: поля (id используется для offset-reconnect).
 */
export async function openSSE(opts: SSEOpts): Promise<void> {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  const init: RequestInit = { method, headers, signal: opts.signal };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body ?? {});
  }

  const resp = await fetch(opts.url, init);
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawBlock = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let eventName = "message";
      let eventId: string | undefined;
      const dataLines: string[] = [];

      for (const line of rawBlock.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("id:")) eventId = line.slice(3).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length) opts.onEvent(eventName, dataLines.join("\n"), eventId);
    }
  }
}
