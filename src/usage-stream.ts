/** SSE framing only. Authority and operation identity are validated by UsageClient. */
export async function* usageFrames(response: Response): AsyncGenerator<unknown> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid usage stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) { buffer += decoder.decode(); break; }
      size += part.value.byteLength;
      // Escaping plus the durable copy can expand a bounded 4 MiB provider body.
      if (size > 64 * 1024 * 1024) throw new Error('Usage stream limit.');
      buffer += decoder.decode(part.value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!line) { if (data.length) { const frame = JSON.parse(data.join('\n')); data = []; yield frame; } }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (buffer.trim() || data.length) throw new Error('Incomplete usage frame.');
  } finally { await reader.cancel().catch(() => {}); }
}
