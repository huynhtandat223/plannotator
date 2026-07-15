import React, { useEffect, useMemo, useState } from 'react';
import { OverlayScrollArea } from '@plannotator/ui/components/OverlayScrollArea';
import type { Annotation } from '@plannotator/ui/types';

export type PlanReviewMessage = { messageId: string; text: string; timestamp?: string };
export type PlanReviewFile = { path: string; supported: boolean };
export type PlanReviewFileSnapshot = PlanReviewFile & { content: string; contentHash: string };
export type PlanReviewSelection =
  | { kind: 'message'; messageId: string }
  | { kind: 'file'; path: string; contentHash: string }
  | null;

export type PlanReviewSnapshot = {
  messages: PlanReviewMessage[];
  files: PlanReviewFile[];
  /** Latest response rounds, oldest to newest. Kept separately from sent annotation snapshots. */
  responseHistory: PlanReviewMessage[];
  selected: PlanReviewSelection;
  fileSnapshots: Record<string, PlanReviewFileSnapshot>;
  draftsByMessageId: Record<string, Annotation[]>;
  sentAnnotationsByMessageId: Record<string, Annotation[]>;
  sentMessageSnapshots: Record<string, PlanReviewMessage>;
  draftsByFileSnapshot: Record<string, Annotation[]>;
  sentAnnotationsByFileSnapshot: Record<string, Annotation[]>;
  sentFileSnapshots: Record<string, PlanReviewFileSnapshot>;
};

export function planFileSnapshotKey(path: string, contentHash: string): string {
  return `${path}\u0000${contentHash}`;
}

export function filterPlanReviewFiles(files: PlanReviewFile[], query: string): PlanReviewFile[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return files;
  return files.filter((file) => file.path.toLowerCase().includes(normalizedQuery));
}

export function resolvePlanReviewMessage(snapshot: PlanReviewSnapshot, messageId: string): PlanReviewMessage | undefined {
  return snapshot.messages.find((message) => message.messageId === messageId)
    ?? snapshot.responseHistory.find((message) => message.messageId === messageId)
    ?? snapshot.sentMessageSnapshots[messageId];
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 110 ? `${normalized.slice(0, 110).trimEnd()}…` : normalized;
}

export function PlanReviewSourcesBrowser({
  snapshot,
  onSelect,
  width,
  mobileOpen,
  onMobileClose,
}: {
  snapshot: PlanReviewSnapshot;
  onSelect: (selection: Exclude<PlanReviewSelection, null> | { kind: 'file'; path: string }) => void;
  width: number | string;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const [tab, setTab] = useState<'messages' | 'files'>(snapshot.selected?.kind === 'file' ? 'files' : 'messages');
  const [fileQuery, setFileQuery] = useState('');
  useEffect(() => {
    if (snapshot.selected?.kind === 'file') setTab('files');
    else if (snapshot.selected?.kind === 'message') setTab('messages');
  }, [snapshot.selected?.kind]);
  const responseHistory = snapshot.responseHistory;
  const responseHistoryIds = useMemo(() => new Set(responseHistory.map((message) => message.messageId)), [responseHistory]);
  const earlierMessages = useMemo(
    () => snapshot.messages.filter((message) => !responseHistoryIds.has(message.messageId)).reverse(),
    [responseHistoryIds, snapshot.messages],
  );
  const filteredFiles = useMemo(() => filterPlanReviewFiles(snapshot.files, fileQuery), [fileQuery, snapshot.files]);
  const fileHistory = useMemo(() => Object.entries(snapshot.sentFileSnapshots).filter(([key, file]) => {
    const current = snapshot.fileSnapshots[file.path];
    return !current || key !== planFileSnapshotKey(current.path, current.contentHash);
  }), [snapshot]);
  const messageCount = (id: string) => (snapshot.draftsByMessageId[id]?.length ?? 0) + (snapshot.sentAnnotationsByMessageId[id]?.length ?? 0);
  const fileCount = (path: string, hash: string) => {
    const key = planFileSnapshotKey(path, hash);
    return (snapshot.draftsByFileSnapshot[key]?.length ?? 0) + (snapshot.sentAnnotationsByFileSnapshot[key]?.length ?? 0);
  };

  return <>
    {mobileOpen && <button type="button" aria-label="Close reviewed sources" onClick={onMobileClose} className="fixed inset-0 top-12 z-[58] bg-background/60 backdrop-blur-sm lg:hidden" />}
    <aside className={`${mobileOpen ? 'fixed inset-y-0 left-0 z-[59] flex w-[min(90vw,20rem)] shadow-2xl' : 'hidden'} lg:sticky lg:top-12 lg:z-auto lg:flex lg:h-[calc(100vh-3rem)] flex-col flex-shrink-0 bg-card border-r border-border`} style={mobileOpen ? undefined : { width }} data-plan-review-sources>
    <div className="flex h-10 items-center justify-between border-b border-border/50 px-3"><span className="text-xs font-medium">Ex-Plannotator Plan</span><button type="button" onClick={onMobileClose} className="rounded p-1.5 text-muted-foreground hover:text-foreground lg:hidden" aria-label="Close reviewed sources">×</button></div>
    <div className="flex h-10 items-center border-b border-border/50 px-2 gap-1">
      <button type="button" onClick={() => setTab('messages')} className={`px-2 py-1 rounded text-xs font-medium ${tab === 'messages' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50'}`}>Messages</button>
      <button type="button" onClick={() => setTab('files')} className={`px-2 py-1 rounded text-xs font-medium ${tab === 'files' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50'}`}>Plan Files</button>
    </div>
    <OverlayScrollArea className="flex-1 min-h-0">
      <div className="p-2">{tab === 'messages' ? <div className="space-y-0.5">
        <p className="px-2 pt-1 pb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Recent assistant responses</p>
        {responseHistory.map((message, index) => <SourceButton key={message.messageId} active={snapshot.selected?.kind === 'message' && snapshot.selected.messageId === message.messageId} label={`#${index + 1}${index === responseHistory.length - 1 ? ' ★' : ''}`} text={preview(message.text)} count={messageCount(message.messageId)} onClick={() => onSelect({ kind: 'message', messageId: message.messageId })} />)}
        {earlierMessages.length > 0 && <p className="px-2 pt-4 pb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Earlier assistant responses</p>}
        {earlierMessages.map((message) => <SourceButton key={message.messageId} active={snapshot.selected?.kind === 'message' && snapshot.selected.messageId === message.messageId} label="Earlier" text={preview(message.text)} count={messageCount(message.messageId)} onClick={() => onSelect({ kind: 'message', messageId: message.messageId })} />)}
      </div> : <div className="space-y-0.5">
        <div className="px-2 pt-1 pb-2">
          <p className="pb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Plan folder</p>
          <label className="block text-[10px] font-medium text-muted-foreground" htmlFor="plan-review-file-filter">Filter files</label>
          <input
            id="plan-review-file-filter"
            type="search"
            value={fileQuery}
            onChange={(event) => setFileQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape' && fileQuery) { event.preventDefault(); setFileQuery(''); } }}
            placeholder="Search paths"
            aria-describedby="plan-review-file-filter-status"
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <p id="plan-review-file-filter-status" className="sr-only" aria-live="polite">{filteredFiles.length} of {snapshot.files.length} files shown.</p>
        </div>
        {snapshot.files.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground">No Plan Files found.</p>}
        {snapshot.files.length > 0 && filteredFiles.length === 0 && <p className="px-2 py-4 text-xs text-muted-foreground" role="status">No files match “{fileQuery}”.</p>}
        {filteredFiles.map((file) => {
          const current = snapshot.fileSnapshots[file.path];
          const count = current ? fileCount(file.path, current.contentHash) : 0;
          return <button key={file.path} type="button" disabled={!file.supported} onClick={() => onSelect({ kind: 'file', path: file.path })} className={`flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors ${snapshot.selected?.kind === 'file' && snapshot.selected.path === file.path && current?.contentHash === snapshot.selected.contentHash ? 'border-primary/30 bg-primary/10 text-primary' : 'border-transparent hover:bg-muted/50'} disabled:cursor-not-allowed disabled:opacity-45`}><span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>{!file.supported && <span className="text-[10px] text-muted-foreground">Unsupported</span>}{count > 0 && <Badge count={count} />}</button>;
        })}
        {fileHistory.length > 0 && <p className="px-2 pt-4 pb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Sent history</p>}
        {fileHistory.map(([key, file]) => <SourceButton key={key} active={snapshot.selected?.kind === 'file' && planFileSnapshotKey(snapshot.selected.path, snapshot.selected.contentHash) === key} label="Sent" text={file.path} count={fileCount(file.path, file.contentHash)} onClick={() => onSelect({ kind: 'file', path: file.path, contentHash: file.contentHash })} />)}
      </div>}</div>
    </OverlayScrollArea>
  </aside>
  </>;
}

function Badge({ count }: { count: number }) { return <span className="shrink-0 min-w-5 h-5 px-1 rounded-full bg-primary/10 text-primary border border-primary/30 text-[10px] font-semibold inline-flex items-center justify-center">{count}</span>; }
function SourceButton({ active, label, text, count, onClick }: { active: boolean; label: string; text: string; count: number; onClick: () => void }) { return <button type="button" onClick={onClick} className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-start gap-2 border ${active ? 'bg-primary/10 text-primary border-primary/30' : 'text-foreground hover:bg-muted/50 border-transparent'}`}><span className="font-mono text-[10px] text-muted-foreground pt-0.5 shrink-0">{label}</span><span className="flex-1 min-w-0 line-clamp-2 leading-snug">{text}</span>{count > 0 && <Badge count={count} />}</button>; }
