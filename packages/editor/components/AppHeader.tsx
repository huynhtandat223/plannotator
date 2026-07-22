import React from 'react';
import type { Origin } from '@plannotator/shared/agents';
import type { Agent } from '@plannotator/ui/hooks/useAgents';
import type { UpdateInfo } from '@plannotator/ui/hooks/useUpdateCheck';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';
import { ApproveDropdown } from '@plannotator/ui/components/ApproveDropdown';
import { Settings } from '@plannotator/ui/components/Settings';
import { PlanHeaderMenu } from '@plannotator/ui/components/PlanHeaderMenu';
import type { CallbackConfig } from '@plannotator/ui/utils/callback';
import type { UIPreferences } from '@plannotator/ui/utils/uiPreferences';
import { SparklesIcon } from '@plannotator/ui/components/SparklesIcon';
import { HerdrProcessPanelLauncher } from './HerdrProcessPanelLauncher';

interface AppHeaderProps {
  /** HTML annotate surface: show a Hide/Show annotation-tools toggle in the header,
   *  so hiding leaves the rendered HTML completely free of overlay controls. */
  htmlSurface?: boolean;
  htmlToolsHidden?: boolean;
  onToggleHtmlTools?: () => void;
  // Mode flags (stable after mount)
  isApiMode: boolean;
  annotateMode: boolean;
  archiveMode: boolean;
  goalSetupMode: boolean;
  goalSetupCanSubmit: boolean;
  goalSetupIsSubmitting: boolean;
  goalSetupSubmitLabel: string;
  gate: boolean;
  isSharedSession: boolean;
  origin: Origin | null;

  // Dynamic state
  isSubmitting: boolean;
  isExiting: boolean;
  isPanelOpen: boolean;
  aiAvailable: boolean;
  isAIChatOpen: boolean;
  showExAIChat?: boolean;
  isExAIChatOpen?: boolean;
  aiHasMessages: boolean;
  hasAnyAnnotations: boolean;
  annotationCount: number;
  linkedDocIsActive: boolean;
  readOnly?: boolean;
  callbackShareUrlReady: boolean;
  canShareCurrentSession: boolean;
  agentName: string;
  availableAgents: Agent[];
  showAnnotationsWarning: boolean;
  /** Live Herdr workspace navigation, rendered as compact pinned mobile controls. */
  showLiveMessagePicker?: boolean;
  showLiveProcessPanel?: boolean;
  onLiveProcessPanelCreated?: (panel: { paneId: string; panelName: string }) => void;
  showLiveFolder?: boolean;
  showLiveChanges?: boolean;
  onOpenLiveMessages?: () => void;
  onOpenLiveFolder?: () => void;
  onOpenLiveChanges?: () => void;
  liveFeedbackCount?: number;
  liveCloseCurrentPane?: boolean;

  // Callback config (null when no bot callback)
  callbackConfig: CallbackConfig | null;

  // Settings props
  taterMode: boolean;
  mobileSettingsOpen: boolean;
  gitUser: string | undefined;

  // Handlers — App owns all decision logic, header just calls these
  onCallbackFeedback: () => void;
  onCallbackApprove: () => void;
  onAnnotateExit: () => void;
  onGoalSetupExit: () => void;
  onGoalSetupSubmit: () => void;
  onAnnotateFeedback: () => void;
  onAnnotateApprove: () => void;
  onFeedback: () => void;
  onApprove: () => void;
  onAnnotationPanelToggle: () => void;
  onAIChatToggle: () => void;
  onExAIChatToggle?: () => void;
  onArchiveCopy: () => void;
  onArchiveDone: () => void;
  onTaterModeChange: (enabled: boolean) => void;
  onIdentityChange: (oldId: string, newId: string) => void;
  onUIPreferencesChange: (prefs: UIPreferences) => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onOpenExport: () => void;
  onCopyAgentInstructions: () => void;
  onDownloadAnnotations: () => void;
  onPrint: () => void;
  onCopyShareLink: () => void;
  onOpenImport: () => void;
  onSaveToObsidian: () => void;
  onSaveToBear: () => void;
  onSaveToOctarine: () => void;

  // PlanHeaderMenu config
  appVersion: string;
  updateInfo?: UpdateInfo | null;
  isWSL?: boolean;
  agentInstructionsEnabled: boolean;
  obsidianConfigured: boolean;
  bearConfigured: boolean;
  octarineConfigured: boolean;
}

/** Lightweight hover/focus tooltip usable by any header control. Non-interactive,
 *  visible on group hover or keyboard focus-within, so it satisfies the same
 *  affordance for mouse and keyboard users. */
const HeaderTooltip: React.FC<{ label: string }> = ({ label }) => (
  <span
    role="tooltip"
    className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
  >
    {label}
  </span>
);

const HeaderIconButton: React.FC<{ onClick?: () => void; title: string; children: React.ReactNode }> = ({ onClick, title, children }) => (
  <span className="group relative inline-flex">
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>{children}</svg>
    </button>
    <HeaderTooltip label={title} />
  </span>
);

export const AppHeader = React.memo<AppHeaderProps>(({
  htmlSurface,
  htmlToolsHidden,
  onToggleHtmlTools,
  isApiMode,
  annotateMode,
  archiveMode,
  goalSetupMode,
  goalSetupCanSubmit,
  goalSetupIsSubmitting,
  goalSetupSubmitLabel,
  gate,
  isSharedSession,
  origin,
  isSubmitting,
  isExiting,
  isPanelOpen,
  aiAvailable,
  isAIChatOpen,
  showExAIChat,
  isExAIChatOpen,
  aiHasMessages,
  hasAnyAnnotations,
  annotationCount,
  linkedDocIsActive,
  readOnly = false,
  callbackShareUrlReady,
  canShareCurrentSession,
  agentName,
  availableAgents,
  showAnnotationsWarning,
  showLiveMessagePicker,
  showLiveProcessPanel,
  onLiveProcessPanelCreated,
  showLiveFolder,
  showLiveChanges,
  onOpenLiveMessages,
  onOpenLiveFolder,
  onOpenLiveChanges,
  liveFeedbackCount = 0,
  liveCloseCurrentPane,
  callbackConfig,
  taterMode,
  mobileSettingsOpen,
  gitUser,
  onCallbackFeedback,
  onCallbackApprove,
  onAnnotateExit,
  onGoalSetupExit,
  onGoalSetupSubmit,
  onAnnotateFeedback,
  onAnnotateApprove,
  onFeedback,
  onApprove,
  onAnnotationPanelToggle,
  onAIChatToggle,
  onExAIChatToggle,
  onArchiveCopy,
  onArchiveDone,
  onTaterModeChange,
  onIdentityChange,
  onUIPreferencesChange,
  onOpenSettings,
  onCloseSettings,
  onOpenExport,
  onCopyAgentInstructions,
  onDownloadAnnotations,
  onPrint,
  onCopyShareLink,
  onOpenImport,
  onSaveToObsidian,
  onSaveToBear,
  onSaveToOctarine,
  appVersion,
  updateInfo,
  isWSL,
  agentInstructionsEnabled,
  obsidianConfigured,
  bearConfigured,
  octarineConfigured,
}) => {
  return (
    <header data-app-header="true" className="h-12 shrink-0 flex items-center justify-between px-2 md:px-4 border-b border-border/50 bg-card/50 backdrop-blur-xl z-[50]">
      <div className="flex items-center gap-2">
        <AppHeaderLogo />
        {htmlSurface && onToggleHtmlTools && (
          <button
            type="button"
            onClick={onToggleHtmlTools}
            className="ml-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded cursor-pointer"
            title={htmlToolsHidden ? 'Show annotation tools' : 'Hide annotation tools'}
          >
            {htmlToolsHidden ? 'Show tools' : 'Hide tools'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 md:gap-2">
        {/* Live workspace navigation is pinned in the mobile header, not in
            the document viewport, so it never overlaps selected text or Send. */}
        {(showLiveMessagePicker || showLiveFolder || showLiveChanges) && (
          <div className="flex items-center gap-0.5 md:hidden">
            {showLiveMessagePicker && <HeaderIconButton onClick={onOpenLiveMessages} title="Messages">
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </HeaderIconButton>}
            {showLiveFolder && <HeaderIconButton onClick={onOpenLiveFolder} title="Folder">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </HeaderIconButton>}
            {showLiveChanges && <HeaderIconButton onClick={onOpenLiveChanges} title="Git Changes">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </HeaderIconButton>}
          </div>
        )}

        {showLiveProcessPanel && onLiveProcessPanelCreated && (
          <div className="mr-1">
            <HerdrProcessPanelLauncher onCreated={onLiveProcessPanelCreated} />
          </div>
        )}

        {/* Bot callback buttons — only shown when ?cb=&ct= params are present */}
        {callbackConfig && !isApiMode && isSharedSession && (
          <>
            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
            <FeedbackButton
              onClick={onCallbackFeedback}
              disabled={isSubmitting || !callbackShareUrlReady}
              isLoading={isSubmitting}
              title="Send feedback to bot"
            />
            <ApproveButton
              onClick={onCallbackApprove}
              disabled={isSubmitting || !callbackShareUrlReady}
              isLoading={isSubmitting}
              title="Approve design and notify bot"
            />
          </>
        )}

        {isApiMode && !linkedDocIsActive && archiveMode && (
          <>
            <button
              onClick={onArchiveCopy}
              className="px-2.5 py-1 rounded-md text-xs font-medium transition-all bg-muted text-foreground hover:bg-muted/80 border border-border"
              title="Copy plan content"
            >
              <span className="hidden md:inline">Copy</span>
              <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              onClick={onArchiveDone}
              className="px-2.5 py-1 rounded-md text-xs font-medium transition-all bg-success text-success-foreground hover:opacity-90"
              title="Close archive"
            >
              Done
            </button>
          </>
        )}

        {showExAIChat && onExAIChatToggle && (
          <button type="button" onClick={onExAIChatToggle} aria-pressed={isExAIChatOpen} title={isExAIChatOpen ? 'Hide Ex AI Chat' : 'Show Ex AI Chat'} className={`flex h-8 items-center gap-1 rounded-md px-2 text-xs ${isExAIChatOpen ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
            <SparklesIcon className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Ex AI Chat</span>
          </button>
        )}

        {isApiMode && !linkedDocIsActive && goalSetupMode && (
          <>
            <ExitButton
              onClick={onGoalSetupExit}
              disabled={isExiting || goalSetupIsSubmitting}
              isLoading={isExiting}
              title="Close goal setup without submitting"
            />
            <ApproveButton
              onClick={onGoalSetupSubmit}
              disabled={!goalSetupCanSubmit || goalSetupIsSubmitting || isExiting}
              isLoading={goalSetupIsSubmitting}
              label={goalSetupSubmitLabel}
              loadingLabel="Submitting..."
              mobileLabel="Submit"
              title={goalSetupSubmitLabel}
            />
            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
          </>
        )}

        {isApiMode && (!readOnly || liveFeedbackCount > 0) && (!linkedDocIsActive || annotateMode) && !archiveMode && !goalSetupMode && (
          <>
            {annotateMode ? (
              <>
                <ExitButton
                  onClick={onAnnotateExit}
                  disabled={isSubmitting || isExiting}
                  isLoading={isExiting}
                  title={liveCloseCurrentPane ? 'Close the selected live Pi panel' : undefined}
                />
                {(hasAnyAnnotations || liveFeedbackCount > 0) && (
                  <FeedbackButton
                    onClick={onAnnotateFeedback}
                    disabled={isSubmitting || isExiting}
                    isLoading={isSubmitting}
                    label="Send Feedback"
                    title={liveFeedbackCount > 0 ? "Send feedback for the selected response" : "Send Feedback"}
                  />
                )}
              </>
            ) : (
              <FeedbackButton
                onClick={onFeedback}
                disabled={isSubmitting}
                isLoading={isSubmitting}
                label="Send Feedback"
                title="Send Feedback"
              />
            )}

            {(!annotateMode || gate) && (
              origin === 'opencode' && !annotateMode && availableAgents.length > 0 ? (
                <ApproveDropdown
                  onApprove={onApprove}
                  agents={availableAgents}
                  disabled={isSubmitting}
                  isLoading={isSubmitting}
                />
              ) : (
                <div className="relative group/approve">
                  <ApproveButton
                    onClick={onApprove}
                    disabled={isSubmitting || (annotateMode && isExiting)}
                    isLoading={isSubmitting}
                    dimmed={!annotateMode && (origin === 'claude-code' || origin === 'gemini-cli') && showAnnotationsWarning}
                    title={annotateMode ? 'Approve — no changes requested' : undefined}
                  />
                  {!annotateMode && (origin === 'claude-code' || origin === 'gemini-cli') && showAnnotationsWarning && (
                    <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-56 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                      <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                      <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                      {agentName} doesn't support feedback on approval. Your feedback won't be seen.
                    </div>
                  )}
                </div>
              )
            )}

            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
          </>
        )}

        {/* Annotations panel toggle */}
        {!goalSetupMode && !readOnly && (
          <span className="group relative inline-flex">
          <button
            onClick={onAnnotationPanelToggle}
            aria-label={isPanelOpen ? 'Hide annotations' : 'Show annotations'}
            aria-pressed={isPanelOpen}
            className={`relative flex h-8 w-8 items-center justify-center rounded-md text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
              isPanelOpen
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            {annotationCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground px-0.5">
                {annotationCount > 99 ? '99+' : annotationCount}
              </span>
            )}
          </button>
          <HeaderTooltip label={isPanelOpen ? 'Hide annotations' : 'Show annotations'} />
          </span>
        )}
        {!goalSetupMode && aiAvailable && (
          <span className="group relative inline-flex">
          <button
            onClick={onAIChatToggle}
            aria-pressed={isAIChatOpen}
            className={`relative flex h-8 w-8 items-center justify-center rounded-md text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
              isAIChatOpen
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            aria-label={isAIChatOpen ? 'Hide AI chat' : 'Show AI chat'}
          >
            <SparklesIcon className="w-4 h-4" />
            {aiHasMessages && !isAIChatOpen && (
              <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-primary" />
            )}
          </button>
          <HeaderTooltip label={isAIChatOpen ? 'Hide AI chat' : 'Show AI chat'} />
          </span>
        )}

        {/* Settings dialog (controlled, button hidden — opened from PlanHeaderMenu) */}
        <div className="hidden">
          <Settings
            taterMode={taterMode}
            onTaterModeChange={onTaterModeChange}
            onIdentityChange={onIdentityChange}
            origin={origin}
            mode={annotateMode ? 'annotate' : 'plan'}
            onUIPreferencesChange={onUIPreferencesChange}
            externalOpen={mobileSettingsOpen}
            onExternalClose={onCloseSettings}
            gitUser={gitUser}
          />
        </div>

        <PlanHeaderMenu
          appVersion={appVersion}
          updateInfo={updateInfo}
          origin={origin}
          isWSL={isWSL}
          onOpenSettings={onOpenSettings}
          onOpenExport={onOpenExport}
          onCopyAgentInstructions={onCopyAgentInstructions}
          onDownloadAnnotations={onDownloadAnnotations}
          onPrint={onPrint}
          onCopyShareLink={onCopyShareLink}
          onOpenImport={onOpenImport}
          onSaveToObsidian={onSaveToObsidian}
          onSaveToBear={onSaveToBear}
          onSaveToOctarine={onSaveToOctarine}
          sharingEnabled={canShareCurrentSession}
          isApiMode={isApiMode}
          agentInstructionsEnabled={agentInstructionsEnabled}
          obsidianConfigured={!goalSetupMode && obsidianConfigured}
          bearConfigured={!goalSetupMode && bearConfigured}
          octarineConfigured={!goalSetupMode && octarineConfigured}
        />
      </div>
    </header>
  );
});

const AppHeaderLogo = () => (
  <div className="flex items-center gap-2 md:gap-3">
    <a
      href="https://plannotator.ai"
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 md:gap-2 hover:opacity-80 transition-opacity"
    >
      <span className="text-sm font-semibold tracking-tight">Plannotator</span>
    </a>
  </div>
);
