import React, { useEffect, useState } from 'react';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { submitHint } from '@plannotator/ui/utils/platform';
import type { ExAIChatState } from '../useExAIChat';

export const ExAIChatPanel: React.FC<{
  state: ExAIChatState;
  error: string | null;
  onStart: (model: string, instruction: string) => Promise<void>;
  onSend: (text: string) => Promise<void>;
  onHandoff: (requestId: string, text: string) => Promise<void>;
}> = ({ state, error, onStart, onSend, onHandoff }) => {
  const [model, setModel] = useState(state.defaults?.model ?? state.pair?.model ?? '');
  const [instruction, setInstruction] = useState(state.defaults?.instruction ?? state.pair?.instruction ?? '');
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { setModel(state.defaults?.model ?? state.pair?.model ?? ''); setInstruction(state.defaults?.instruction ?? state.pair?.instruction ?? ''); }, [state.pair?.main.paneId, state.pair?.main.sessionId, state.defaults?.model, state.defaults?.instruction]);
  const submit = async () => {
    if (!input.trim() || pending) return;
    setPending(true);
    try { await onSend(input.trim()); setInput(''); } finally { setPending(false); }
  };
  if (state.status === 'setup' || state.status === 'closed') return <div className="flex h-full flex-col gap-3 p-4 text-xs">
    <div><strong>Ex AI Chat</strong><p className="mt-1 text-muted-foreground">Start a normal Pi companion for this live session.</p></div>
    {state.status === 'closed' && <p className="rounded border border-border p-2 text-muted-foreground">The companion was closed in Herdr. Start explicitly to create a replacement.</p>}
    <label>Model<select aria-label="Ex AI model" value={model} onChange={(event) => setModel(event.target.value)} className="mt-1 w-full rounded border border-border bg-background p-2">
      {state.models?.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select></label>
    <label>Base instruction<textarea aria-label="Ex AI base instruction" value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={6} className="mt-1 w-full rounded border border-border bg-transparent p-2" /></label>
    <button disabled={!model.trim() || pending} onClick={() => void (async () => { setPending(true); try { await onStart(model, instruction); } finally { setPending(false); } })()} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">{pending ? 'Starting…' : 'Start'}</button>
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
  if (state.status === 'retired') return <div className="p-4 text-xs text-muted-foreground">The paired main Pi session changed or closed.</div>;
  if (state.status === 'recovering') return <div className="p-4 text-xs text-muted-foreground">Reconnecting to the companion Pi session…</div>;
  return <div className="flex h-full flex-col">
    <OverlayScrollArea className="min-h-0 flex-1"><div className="space-y-3 p-3">
      {state.history.map((entry, index) => entry.kind === 'activity'
        ? <details key={index} className="rounded border border-border p-2 text-xs text-muted-foreground"><summary>{entry.text}</summary></details>
        : <div key={index} className="rounded border border-border/50 p-2.5 text-xs"><p className="whitespace-pre-wrap">{entry.text}</p>{entry.kind === 'assistant' && <button className="mt-2 text-primary" onClick={() => { setDraft(entry.text); setHandoffId(crypto.randomUUID()); }}>Send to main session</button>}</div>)}
    </div></OverlayScrollArea>
    {draft !== null && <div className="border-t border-border p-2"><textarea aria-label="Send to main session" value={draft} onChange={(event) => setDraft(event.target.value)} className="w-full rounded border border-border bg-transparent p-2 text-xs" /><button disabled={pending} onClick={() => void (async () => { if (!handoffId) return; setPending(true); try { await onHandoff(handoffId, draft); setDraft(null); setHandoffId(null); } finally { setPending(false); } })()} className="mt-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">Confirm send</button></div>}
    <div className="border-t border-border p-2"><div className="flex gap-2"><textarea aria-label="Ask Ex AI Chat" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} className="min-h-10 flex-1 rounded border border-border bg-transparent p-2 text-xs" placeholder="Ask the companion…" /><button disabled={!input.trim() || pending} onClick={() => void submit()} className="rounded bg-primary px-3 text-xs text-primary-foreground disabled:opacity-50">Send</button></div><p className="mt-1 text-[10px] text-muted-foreground">{submitHint}</p>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</div>
  </div>;
};
