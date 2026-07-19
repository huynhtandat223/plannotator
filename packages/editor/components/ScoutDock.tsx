import React, { useState } from 'react';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import { toast } from 'sonner';
import type { PickerMessage } from '@plannotator/ui/components/sidebar/MessagesBrowser';


export type ScoutState = {
  workspaceKey: string;
  workspaceId: string;
  cwd: string;
  paneId: string;
  status: 'awaiting-registration' | 'running' | 'ready' | 'failed';
  error?: string;
};

type ScoutDockProps = {
  isOpen: boolean;
  onClose: () => void;
  width: string | number;
  selectedMessage: PickerMessage | null;
  currentScout: ScoutState | null;
};

export const ScoutDock: React.FC<ScoutDockProps> = ({
  isOpen,
  onClose,
  width,
  selectedMessage,
  currentScout,
}) => {
  const [question, setQuestion] = useState(
    'Inspect this live work. What is the ideal direction, what needs correction, and what should the agent propose next?'
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleLaunch = async () => {
    if (!selectedMessage) {
      toast.error('No selected response to scout.');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/scout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourcePaneId: selectedMessage.paneId,
          sourceMessageId: selectedMessage.messageId,
          question: question.trim(),
          selectedText: window.getSelection()?.toString() || undefined,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Scout could not be started.');
      }
      toast.success(data.reused ? 'Scout reused!' : 'Scout started!');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scout could not be started.';
      setError(message);
      toast.error('Failed to launch Scout', { description: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Determine active status/error to show
  const isAwaiting = currentScout?.status === 'awaiting-registration';
  const isRunning = currentScout?.status === 'running' || isSubmitting;
  const isReady = currentScout?.status === 'ready';
  const isFailed = currentScout?.status === 'failed';

  const sourceLabel = selectedMessage
    ? `${selectedMessage.paneLabel} · ${selectedMessage.paneDescription}`
    : 'No active response';

  return (
    <aside
      className="border-l border-border/50 bg-card flex flex-col flex-shrink-0 h-full overflow-hidden"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex h-10 items-center justify-between border-b border-border/50 px-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            {isRunning && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
            )}
            {isAwaiting && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
            )}
            <span className={`relative inline-flex rounded-full h-2 w-2 ${
              isRunning ? 'bg-sky-500' : isAwaiting ? 'bg-amber-500' : isReady ? 'bg-emerald-500' : isFailed ? 'bg-rose-500' : 'bg-muted-foreground'
            }`}></span>
          </span>
          <h2 className="text-xs font-semibold tracking-wide uppercase text-foreground">
            Scout Dock
          </h2>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          title="Close Scout dock"
          aria-label="Close Scout dock"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Main Content Area */}
      <OverlayScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-5">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Workspace Companion
            </span>
            <h1 className="text-lg font-bold tracking-tight text-foreground">
              Inspect with a fresh pair of eyes
            </h1>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
              Keep the source response visible while a dedicated agent scouts the same live workspace.
            </p>
          </div>

          {/* Context box */}
          <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block mb-1">
              Reviewing Now
            </span>
            <div className="text-xs font-medium text-foreground truncate" title={sourceLabel}>
              {sourceLabel}
            </div>
            {selectedMessage?.cwd && (
              <div className="text-[10px] text-muted-foreground font-mono mt-1 truncate" title={selectedMessage.cwd}>
                {selectedMessage.cwd}
              </div>
            )}
          </div>

          {/* Features cards */}
          <div className="grid gap-2.5">
            <div className="rounded-lg border border-border/40 bg-card p-3 shadow-sm hover:border-border/80 transition-colors">
              <strong className="text-xs font-semibold text-foreground">Ideal direction</strong>
              <p className="mt-1 text-xs text-muted-foreground leading-normal">
                Compare response intent with workspace reality.
              </p>
            </div>
            <div className="rounded-lg border border-border/40 bg-card p-3 shadow-sm hover:border-border/80 transition-colors">
              <strong className="text-xs font-semibold text-foreground">Corrections & risks</strong>
              <p className="mt-1 text-xs text-muted-foreground leading-normal">
                Surface wrong assumptions and missing constraints.
              </p>
            </div>
            <div className="rounded-lg border border-border/40 bg-card p-3 shadow-sm hover:border-border/80 transition-colors">
              <strong className="text-xs font-semibold text-foreground">Proposals</strong>
              <p className="mt-1 text-xs text-muted-foreground leading-normal">
                Return practical next steps for the reviewer.
              </p>
            </div>
          </div>

          {/* Input field */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground block" htmlFor="scout-prompt">
              Scout Briefing Prompt
            </label>
            <textarea
              id="scout-prompt"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={isRunning}
              className="w-full min-h-[96px] rounded-lg border border-border/80 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 disabled:opacity-50 resize-y"
              placeholder="What should Scout check?"
            />
          </div>

          {/* Status feedback */}
          {(error || (isFailed && currentScout?.error)) && (
            <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex gap-2">
              <svg className="w-4 h-4 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{error || currentScout?.error || 'Scout run failed.'}</span>
            </div>
          )}

          {isAwaiting && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-600 dark:text-amber-400 flex gap-2">
              <span className="relative flex h-2 w-2 mt-1.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
              </span>
              <span>
                <strong>Awaiting registration.</strong> Waiting for the Pi session to connect. The briefing will run automatically.
              </span>
            </div>
          )}

          {isRunning && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-primary flex gap-2">
              <span className="relative flex h-2 w-2 mt-1.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-sky-500"></span>
              </span>
              <span>
                <strong>Scout is running.</strong> Inspecting live workspace context...
              </span>
            </div>
          )}

          {isReady && !isRunning && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-600 dark:text-emerald-400 flex gap-2">
              <svg className="w-4 h-4 shrink-0 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>
                <strong>Scout ready.</strong> Select its response from Messages to review or give it follow-up feedback.
              </span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={handleLaunch}
              disabled={isRunning || !selectedMessage?.assistantMessageId}
              className="flex-1 rounded-lg bg-primary hover:bg-primary/95 text-primary-foreground font-semibold px-3 py-2 text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
            >
              {isSubmitting ? (
                <>Launching...</>
              ) : isRunning ? (
                <>Scouting...</>
              ) : (
                <>
                  Launch workspace Scout
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-lg border border-border/80 hover:bg-muted text-foreground px-3 py-2 text-xs transition-colors"
            >
              Not now
            </button>
          </div>
        </div>
      </OverlayScrollArea>
    </aside>
  );
};
