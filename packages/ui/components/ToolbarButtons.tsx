import React from 'react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { Send, Check, X } from 'lucide-react';

type ToolbarLabelBreakpoint = 'md' | 'lg';

interface FeedbackButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
  shortLabel?: string;
  loadingLabel?: string;
  shortLoadingLabel?: string;
  title?: string;
  muted?: boolean;
  labelBreakpoint?: ToolbarLabelBreakpoint;
}

export const FeedbackButton: React.FC<FeedbackButtonProps> = ({
  onClick,
  disabled = false,
  isLoading = false,
  label = 'Send Feedback',
  shortLabel,
  loadingLabel = 'Sending...',
  shortLoadingLabel,
  title = 'Send Feedback',
  muted = false,
  labelBreakpoint = 'md',
}) => (
  <Button
    variant="outline"
    size="xs"
    onClick={onClick}
    disabled={disabled}
    title={title}
    iconLeft={<Send className="size-3.5" />}
    className={cn(muted && 'opacity-50 cursor-not-allowed')}
  >
    {shortLabel ? (
      <>
        <span className={labelBreakpoint === 'lg' ? 'hidden lg:inline xl:hidden' : 'hidden md:inline lg:hidden'}>
          {isLoading ? (shortLoadingLabel ?? loadingLabel) : shortLabel}
        </span>
        <span className={labelBreakpoint === 'lg' ? 'hidden xl:inline' : 'hidden lg:inline'}>
          {isLoading ? loadingLabel : label}
        </span>
      </>
    ) : (
      <>
        <span className={labelBreakpoint === 'lg' ? 'lg:hidden' : 'md:hidden'}>{isLoading ? '…' : 'Send'}</span>
        <span className={labelBreakpoint === 'lg' ? 'hidden lg:inline' : 'hidden md:inline'}>
          {isLoading ? loadingLabel : label}
        </span>
      </>
    )}
  </Button>
);

export interface ApproveButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  label?: string;
  loadingLabel?: string;
  mobileLabel?: string;
  mobileLoadingLabel?: string;
  title?: string;
  dimmed?: boolean;
  muted?: boolean;
  labelBreakpoint?: ToolbarLabelBreakpoint;
}

export const ApproveButton: React.FC<ApproveButtonProps> = ({
  onClick,
  disabled = false,
  isLoading = false,
  label = 'Approve',
  loadingLabel = 'Approving...',
  mobileLabel = 'OK',
  mobileLoadingLabel = '...',
  title,
  dimmed = false,
  muted = false,
  labelBreakpoint = 'md',
}) => (
  <Button
    variant="success"
    size="xs"
    onClick={onClick}
    disabled={disabled}
    title={title}
    iconLeft={<Check className="size-3.5" />}
    className={cn(
      muted && 'opacity-40 cursor-not-allowed bg-muted text-muted-foreground hover:bg-muted',
      disabled && !muted && 'bg-muted text-muted-foreground hover:bg-muted',
      dimmed && !muted && !disabled && 'bg-success/50 text-success-foreground/70 hover:bg-success hover:text-success-foreground',
    )}
  >
    <span className={labelBreakpoint === 'lg' ? 'lg:hidden' : 'md:hidden'}>
      {isLoading ? mobileLoadingLabel : mobileLabel}
    </span>
    <span className={labelBreakpoint === 'lg' ? 'hidden lg:inline' : 'hidden md:inline'}>
      {isLoading ? loadingLabel : label}
    </span>
  </Button>
);

interface ExitButtonProps {
  onClick: () => void;
  disabled?: boolean;
  isLoading?: boolean;
  title?: string;
  labelBreakpoint?: ToolbarLabelBreakpoint;
  /**
   * Text shown instead of "Close". Set by callers whose click does something
   * other than close the review session.
   *
   * The live-pane surface reuses this button to END AN AGENT'S PANE, and it
   * read "Close" in muted secondary styling — the same word, weight and colour
   * this button uses everywhere else for the entirely benign "close this review
   * without sending feedback". Below the label breakpoint it collapsed further,
   * to a bare `×` among six other header glyphs, which is the single most
   * over-learned "dismiss this view" idiom there is.
   */
  label?: string;
  /** Compact form for narrow viewports; falls back to `label`. */
  shortLabel?: string;
  /**
   * Destructive intent: the click ends something that is running and cannot be
   * undone. Such a control never degrades to an icon at any width — the word is
   * the whole warning.
   */
  destructive?: boolean;
}

export const ExitButton: React.FC<ExitButtonProps> = ({
  onClick,
  disabled = false,
  isLoading = false,
  title = 'Close session without sending feedback',
  labelBreakpoint = 'md',
  label = 'Close',
  shortLabel,
  destructive = false,
}) => (
  <Button
    variant="secondary"
    size="xs"
    onClick={onClick}
    disabled={disabled || isLoading}
    title={title}
    aria-label={title}
    className={
      destructive
        ? 'bg-destructive/12 text-destructive border border-destructive/35 hover:bg-destructive/20'
        : 'bg-muted text-muted-foreground hover:bg-muted/80'
    }
  >
    {destructive ? (
      // Always words, never a lone glyph — including on a phone.
      <>
        <span className={labelBreakpoint === 'lg' ? 'lg:hidden' : 'md:hidden'}>
          {isLoading ? '…' : (shortLabel ?? label)}
        </span>
        <span className={labelBreakpoint === 'lg' ? 'hidden lg:inline' : 'hidden md:inline'}>
          {isLoading ? 'Ending…' : label}
        </span>
      </>
    ) : (
      <>
        <span className={labelBreakpoint === 'lg' ? 'lg:hidden' : 'md:hidden'}>
          {isLoading ? '…' : <X className="size-3.5" aria-hidden="true" />}
        </span>
        <span className={labelBreakpoint === 'lg' ? 'hidden lg:inline' : 'hidden md:inline'}>
          {isLoading ? 'Closing...' : label}
        </span>
      </>
    )}
  </Button>
);
