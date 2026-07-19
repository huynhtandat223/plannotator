import React, { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@plannotator/ui/components/ui/dialog';

type HerdrPanel = {
  id: string;
  workspaceId: string;
  workspace: string;
  tab: string;
  panel: string;
  cwd: string;
};

type HerdrProcessPanelLauncherProps = {
  onCreated: (panel: { paneId: string; panelName: string }) => void;
};

const fieldClassName = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

export const HerdrProcessPanelLauncher: React.FC<HerdrProcessPanelLauncherProps> = ({ onCreated }) => {
  const [open, setOpen] = useState(false);
  const [panels, setPanels] = useState<HerdrPanel[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [cwd, setCwd] = useState('');
  const [panelName, setPanelName] = useState('');
  const [command, setCommand] = useState('pi');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const workspaces = useMemo(() => {
    const unique = new Map<string, string>();
    panels.forEach((panel) => unique.set(panel.workspaceId, panel.workspace));
    return [...unique].map(([id, label]) => ({ id, label }));
  }, [panels]);
  const workspacePanels = useMemo(
    () => panels.filter((panel) => panel.workspaceId === workspaceId),
    [panels, workspaceId],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetch('/api/panels')
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? 'Could not load Herdr workspaces');
        return response.json() as Promise<HerdrPanel[]>;
      })
      .then((nextPanels) => {
        if (cancelled) return;
        setPanels(nextPanels);
        const first = nextPanels[0];
        if (!first) return;
        setWorkspaceId((current) => nextPanels.some((panel) => panel.workspaceId === current) ? current : first.workspaceId);
        setCwd((current) => current || first.cwd);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load Herdr workspaces');
      });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!workspacePanels.some((panel) => panel.cwd === cwd)) {
      setCwd(workspacePanels[0]?.cwd ?? '');
    }
  }, [cwd, workspacePanels]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch('/api/process-panels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, cwd, panelName, command }),
      });
      const body = await response.json().catch(() => null) as { paneId?: string; panelName?: string; error?: string } | null;
      if (!response.ok || !body?.paneId || !body.panelName) throw new Error(body?.error ?? 'Could not create the Pi panel');
      setOpen(false);
      onCreated({ paneId: body.paneId, panelName: body.panelName });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the Pi panel');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="New Pi panel"
        title="New Pi panel"
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m-7-7h14" />
        </svg>
      </button>
      <DialogContent className="max-w-md" hideClose={isSubmitting}>
        <DialogHeader>
          <DialogTitle>New Pi panel</DialogTitle>
          <DialogDescription>Starts a background Pi panel in the selected live Herdr workspace.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4 overflow-y-auto px-5 py-4" onSubmit={submit}>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Workspace</span>
            <select className={fieldClassName} value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} required>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Working directory</span>
            <input className={fieldClassName} list="herdr-live-panel-paths" value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/absolute/path" required />
            <datalist id="herdr-live-panel-paths">
              {workspacePanels.map((panel) => <option key={panel.id} value={panel.cwd}>{[panel.tab, panel.panel].filter(Boolean).join(' · ')}</option>)}
            </datalist>
            <span className="block text-xs text-muted-foreground">Choose a live panel path or enter an existing absolute path.</span>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Panel name</span>
            <input className={fieldClassName} value={panelName} onChange={(event) => setPanelName(event.target.value)} placeholder="Research" maxLength={80} required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Command</span>
            <input className={fieldClassName} value={command} onChange={(event) => setCommand(event.target.value)} placeholder="pi" required />
            <span className="block text-xs text-muted-foreground">Arguments are supported; shell expansion is not.</span>
          </label>
          {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button type="button" className="rounded-md px-3 py-2 text-sm hover:bg-muted" onClick={() => setOpen(false)} disabled={isSubmitting}>Cancel</button>
            <button type="submit" className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" disabled={isSubmitting || !workspaceId}>
              {isSubmitting ? 'Creating…' : 'Create panel'}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
