import { afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocBadges } from '../ui/components/DocBadges';
import { repoInfoForDocument } from './documentRepoInfo';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

test.skipIf(!hasDom)('live review hides the repository badge while a normal document keeps it', async () => {
  const repoInfo = { display: 'plannotator/workspaces', branch: 'rooms/resurrect' };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  await act(async () => root!.render(
    <DocBadges layout="column" repoInfo={repoInfoForDocument(repoInfo, true)} />,
  ));
  expect(host.textContent).not.toContain(repoInfo.display);
  expect(host.textContent).not.toContain(repoInfo.branch);

  await act(async () => root!.render(
    <DocBadges layout="column" repoInfo={repoInfoForDocument(repoInfo, false)} />,
  ));
  expect(host.textContent).toContain(repoInfo.display);
  expect(host.textContent).toContain(repoInfo.branch);
});
