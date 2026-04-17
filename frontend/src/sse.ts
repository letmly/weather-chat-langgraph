export type SSEHandler = (event: string, data: string) => void;

/**
 * POST + стриминг SSE через fetch/ReadableStream.
 * EventSource не умеет POST, поэтому парсим SSE-формат вручную.
 */
export async function streamSSE(
  url: string,
  body: unknown,
  onEvent: SSEHandler,
  signal?: AbortSignal
): Promise<void> {
  console.log("[sse] POST", url, body);
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal,
  });

  console.log("[sse] headers", resp.status, resp.headers.get("content-type"));

  if (!resp.ok || !resp.body) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      console.log("[sse] stream closed");
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    console.log("[sse] chunk", JSON.stringify(chunk));
    buffer += chunk;

    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawBlock = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of rawBlock.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      if (dataLines.length) {
        console.log("[sse] event", eventName, dataLines.join("\n"));
        onEvent(eventName, dataLines.join("\n"));
      }
    }
  }
}
