import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarContainer } from './SidebarContainer';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

test.skipIf(!hasDom)('gives active desktop and mobile Messages panels bounded keyboard-scroll regions', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SidebarContainer
        activeTab="messages"
        onTabChange={() => {}}
        onClose={() => {}}
        width={320}
        blocks={[]}
        annotations={[]}
        activeSection={null}
        onTocNavigate={() => {}}
        versionInfo={null}
        versions={[]}
        selectedBaseVersion={null}
        onSelectBaseVersion={() => {}}
        isPlanDiffActive={false}
        hasPreviousVersion={false}
        onActivatePlanDiff={() => {}}
        isLoadingVersions={false}
        isSelectingVersion={false}
        fetchingVersion={null}
        onFetchVersions={() => {}}
        archivePlans={[]}
        selectedArchiveFile={null}
        onArchiveSelect={() => {}}
        isLoadingArchive={false}
        showMessagesTab
        messages={[
          { messageId: 'm1', text: 'Older' },
          { messageId: 'm2', text: 'Newest' },
        ]}
        selectedMessageId="m2"
        onSelectMessage={() => {}}
        messagesChronological
        messagesAutoLoadOnScroll
      />,
    );
  });

  const desktop = host.querySelector<HTMLElement>('[data-messages-scroll-region="desktop"]');
  const mobile = host.querySelector<HTMLElement>('[data-messages-scroll-region="mobile"]');
  expect(desktop).not.toBeNull();
  expect(mobile).not.toBeNull();
  expect(desktop!.className).toContain('flex-1 min-h-0');
  expect(mobile!.className).toContain('h-[calc(min(72dvh,36rem)-4.75rem)]');
  for (const region of [desktop!, mobile!]) {
    expect(region.tabIndex).toBe(0);
    expect(region.style.overflowY).toBe('auto');
    expect(region.style.overscrollBehaviorY).toBe('contain');
  }
});
