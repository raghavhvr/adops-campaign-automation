/**
 * lib/stream.js
 * NDJSON streaming helpers for real-time push progress.
 * Each event is one line of JSON flushed immediately to the browser.
 */

/**
 * Sets up a streaming NDJSON response and returns a writer.
 * @param {object} res — Vercel/Node ServerResponse
 * @returns {{ write: (type: string, data: object) => void, end: () => void }}
 */
export function createStream(res) {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering on Vercel
  res.flushHeaders?.();

  return {
    /** Writes one event line immediately to the browser */
    write(type, data = {}) {
      const line = JSON.stringify({ type, ts: new Date().toISOString(), ...data });
      res.write(line + '\n');
      // Force flush if available (Node 16+ http.ServerResponse)
      res.socket?.flush?.();
    },
    /** Ends the stream */
    end() {
      res.end();
    },
  };
}

/**
 * Reads a full NDJSON stream response on the client side.
 * Call this in the browser to process push progress events.
 * Returns an async generator yielding parsed event objects.
 *
 * Usage:
 *   for await (const event of readStream(response)) {
 *     if (event.type === 'ad') console.log('Ad created:', event.name);
 *   }
 *
 * @param {Response} response — fetch Response object
 */
export async function* readStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // Last incomplete line stays in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Skip malformed lines — stream continues
      }
    }
  }

  // Flush any remaining buffer
  if (buffer.trim()) {
    try { yield JSON.parse(buffer.trim()); } catch { /* ignore */ }
  }
}
