import React from "react";
import type { WorkspaceFileChange } from "@plannotator/core/workspace-status-types";
import type { DirState } from "../../hooks/useFileBrowser";

interface GitChangesBrowserProps {
  dirs: DirState[];
  onSelectFile?: (absolutePath: string, dirPath: string) => void;
  onRefresh: () => void;
}

type ChangeEntry = { change: WorkspaceFileChange; dirPath: string };

function statusMarker(change: WorkspaceFileChange): { label: string; className: string; title: string } {
  switch (change.status) {
    case "added": return { label: "A", className: "text-success", title: "Added" };
    case "deleted": return { label: "D", className: "text-destructive", title: "Deleted" };
    case "renamed": return { label: "R", className: "text-[#007aff]", title: change.oldPath ? `Renamed from ${change.oldPath}` : "Renamed" };
    case "untracked": return { label: "U", className: "text-primary", title: "Untracked" };
    case "conflicted": return { label: "!", className: "text-destructive", title: "Conflict" };
    default: return { label: "M", className: "text-muted-foreground", title: "Modified" };
  }
}

const ChangeRow: React.FC<{ entry: ChangeEntry; onSelectFile?: GitChangesBrowserProps["onSelectFile"] }> = ({ entry, onSelectFile }) => {
  const marker = statusMarker(entry.change);
  const relativePath = entry.change.repoRelativePath || entry.change.path.replace(`${entry.dirPath}/`, "");
  const select = () => onSelectFile?.(entry.change.path, entry.dirPath);
  return (
    <button
      type="button"
      onClick={select}
      disabled={!onSelectFile || entry.change.status === "deleted"}
      className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50 disabled:cursor-default disabled:opacity-70"
      title={entry.change.status === "deleted" ? `${relativePath} (deleted)` : relativePath}
    >
      <span className={`w-3 flex-shrink-0 text-center text-[10px] font-semibold ${marker.className}`} title={marker.title}>{marker.label}</span>
      <span className="min-w-0 flex-1 truncate">{relativePath}</span>
      <span className="flex-shrink-0 whitespace-nowrap text-[10px] tabular-nums">
        {entry.change.additions > 0 && <span className="additions">+{entry.change.additions}</span>}
        {entry.change.additions > 0 && entry.change.deletions > 0 && " "}
        {entry.change.deletions > 0 && <span className="deletions">-{entry.change.deletions}</span>}
      </span>
      {entry.change.staged && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" title="Staged" />}
    </button>
  );
};

export const GitChangesBrowser: React.FC<GitChangesBrowserProps> = ({ dirs, onSelectFile, onRefresh }) => {
  const entries = React.useMemo(() => dirs.flatMap((dir) =>
    Object.values(dir.workspaceStatus?.files ?? {}).map((change) => ({ change, dirPath: dir.path })),
  ), [dirs]);
  const staged = entries.filter(({ change }) => change.staged);
  const untracked = entries.filter(({ change }) => change.status === "untracked");
  const changes = entries.filter(({ change }) => !change.staged && change.status !== "untracked");
  const unavailable = dirs.length > 0 && dirs.every((dir) => dir.workspaceStatus?.available === false);

  const group = (label: string, items: ChangeEntry[]) => items.length > 0 && (
    <section className="border-b border-border/30 last:border-0">
      <h3 className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label} · {items.length}</h3>
      {items.map((entry) => <ChangeRow key={`${entry.dirPath}:${entry.change.path}`} entry={entry} onSelectFile={onSelectFile} />)}
    </section>
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
        <span className="text-[10px] text-muted-foreground">Current Git repository</span>
        <button type="button" onClick={onRefresh} className="rounded px-2 py-1 text-[10px] text-primary hover:bg-muted/50">Refresh</button>
      </div>
      {entries.length > 0 ? <>
        {group("Staged", staged)}
        {group("Changes", changes)}
        {group("Untracked", untracked)}
      </> : (
        <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
          {unavailable ? "The current pane folder is not a Git repository." : "No Git changes in the current repository."}
        </div>
      )}
    </div>
  );
};
