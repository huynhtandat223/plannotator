import { useCallback, useEffect, useRef, useState } from 'react';

export type ExAIIdentity = { paneId: string; sessionId: string };
type History = { kind: 'user'; text: string } | { kind: 'assistant'; text: string; messageId: string } | { kind: 'activity'; text: 'Companion activity occurred in Herdr' };
export type ExAIChatState = {
  status: 'setup' | 'ready' | 'closed' | 'retired' | 'recovering';
  pair?: { main: ExAIIdentity; companion: ExAIIdentity; model: string; instruction: string };
  history: History[];
  defaults?: { model: string; instruction: string };
  models?: Array<{ id: string; label: string }>;
};

async function request(path: string, method: string, body?: unknown): Promise<ExAIChatState> {
  const response = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json() as ExAIChatState & { error?: string };
  if (!response.ok) throw new Error(value.error ?? 'Ex AI Chat request failed');
  return value;
}

/** Separate persistent-pane controller. It intentionally never touches Ask AI's transport or state. */
export function useExAIChat(main: ExAIIdentity | null) {
  const [state, setState] = useState<ExAIChatState>({ status: 'setup', history: [], defaults: { model: '', instruction: '' } });
  const [error, setError] = useState<string | null>(null);
  const identity = main ? `${main.paneId}:${main.sessionId}` : '';
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const refresh = useCallback(async () => {
    if (!main) return setState({ status: 'setup', history: [], defaults: { model: '', instruction: '' } });
    const requestIdentity = `${main.paneId}:${main.sessionId}`;
    try {
      const next = await request(`/api/ex-ai-companion?paneId=${encodeURIComponent(main.paneId)}&sessionId=${encodeURIComponent(main.sessionId)}`, 'GET');
      if (latestIdentity.current === requestIdentity) setState(next);
      if (latestIdentity.current === requestIdentity) setError(null);
    } catch (reason) { if (latestIdentity.current === requestIdentity) setError(reason instanceof Error ? reason.message : 'Could not load Ex AI Chat'); }
  }, [main]);
  useEffect(() => { void refresh(); }, [refresh]);
  const start = useCallback(async (model: string, instruction: string) => {
    if (!main) return;
    try { setState(await request('/api/ex-ai-companion/start', 'POST', { ...main, model, instruction })); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not start Ex AI Chat'); throw reason; }
  }, [main]);
  const stop = useCallback(async () => {
    if (!main) return;
    try { setState(await request('/api/ex-ai-companion/stop', 'POST', main)); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not stop Ex AI Chat'); throw reason; }
  }, [main]);
  const send = useCallback(async (text: string) => {
    if (!main) return;
    try { setState(await request('/api/ex-ai-companion/turn', 'POST', { ...main, text })); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not send to Ex AI Chat'); throw reason; }
  }, [main]);
  const handoff = useCallback(async (requestId: string, text: string) => {
    if (!main) throw new Error('The paired main session is unavailable');
    try { const next = await request('/api/ex-ai-companion/handoff', 'POST', { ...main, requestId, text }); setState(next); setError(null); return next; }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not send to the main session'); throw reason; }
  }, [main]);
  return { state, error, refresh, start, stop, send, handoff };
}
