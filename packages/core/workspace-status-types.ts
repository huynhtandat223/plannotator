export type WorkspaceFileStatus =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied"
	| "typechange"
	| "conflicted"
	| "untracked";

export interface WorkspaceFileChange {
	path: string;
	repoRelativePath: string;
	oldPath?: string;
	status: WorkspaceFileStatus;
	additions: number;
	deletions: number;
	staged: boolean;
	unstaged: boolean;
}

export interface WorkspaceSinceBaseSections {
	/** The base ref used to calculate the standard since-base change set. */
	base: string;
	/** Resolved merge-base SHA, or HEAD when Git cannot resolve the base. */
	mergeBase: string;
	/** Repo-root-relative paths partitioned like the code-review Git-status view. */
	files: Record<string, {
		group: "committed" | "changes" | "untracked";
		staged: boolean;
	}>;
}

export interface WorkspaceStatusPayload {
	available: boolean;
	rootPath: string;
	repoRoot?: string;
	/** Present when the host can calculate the standard since-base review set. */
	sinceBase?: WorkspaceSinceBaseSections;
	files: Record<string, WorkspaceFileChange>;
	totals: {
		files: number;
		additions: number;
		deletions: number;
	};
	error?: string;
}

export interface GitRepositoryInfo {
	repoRoot: string;
	gitDir: string;
	gitCommonDir: string;
}
