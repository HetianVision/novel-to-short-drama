export function parseJsonlLine(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { type: 'error', error: 'Codex JSONL event must be an object', raw: text };
    }
    return value;
  } catch (error) {
    return { type: 'error', error: `Malformed Codex JSONL: ${error.message}`, raw: text };
  }
}

export function eventThreadId(event) {
  return event?.thread_id ?? event?.threadId ?? event?.thread?.id ?? null;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((item) => typeof item === 'string' ? item : item?.text ?? '')
    .join('')
    .trim() || null;
}

export function eventFinalMessage(event) {
  if (typeof event?.message === 'string') return event.message;
  if (typeof event?.text === 'string' && event.type?.includes('completed')) return event.text;
  if (event?.item?.type === 'agent_message') return textFromContent(event.item.text ?? event.item.content);
  if (event?.item?.type === 'message') return textFromContent(event.item.content ?? event.item.text);
  return null;
}
