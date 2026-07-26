export type DocumentRepoInfo = {
  display: string;
  branch?: string;
  host?: string;
};

/** Live pane identity is already shown by its workspace/tab chips. */
export const repoInfoForDocument = (
  repoInfo: DocumentRepoInfo | null,
  liveMessageReview: boolean,
): DocumentRepoInfo | null => liveMessageReview ? null : repoInfo;
