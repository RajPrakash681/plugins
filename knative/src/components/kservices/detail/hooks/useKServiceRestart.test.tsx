/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import type { KService } from '../../../../resources/knative';
import {
  ANNOTATION,
  ApiStatusError,
  DEADLINE_EXCEEDED,
  FIRST,
  makeDeployment,
  type MockDeployment,
  NOW,
  restarted,
  SECOND,
} from './__tests__/restartFixtures';
import { ROLLOUT_TIMEOUT_MS } from './restartRollout';
import { useKServiceRestart } from './useKServiceRestart';

const mocks = vi.hoisted(() => ({
  useList: vi.fn(),
  enqueueSnackbar: vi.fn(),
  closeSnackbar: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  K8s: { ResourceClasses: { Deployment: { useList: mocks.useList } } },
}));

vi.mock('notistack', () => ({
  useSnackbar: () => ({
    enqueueSnackbar: mocks.enqueueSnackbar,
    closeSnackbar: mocks.closeSnackbar,
  }),
}));

vi.mock('../../../common/notifications/useNotify', () => ({
  useNotify: () => ({ notifyError: mocks.notifyError, notifyInfo: mocks.notifyInfo }),
}));

const IDLE = 'service-a-00001-deployment';
const LABEL_SELECTOR = 'serving.knative.dev/service=service-a';
const kservice = {
  cluster: 'cluster-a',
  metadata: { namespace: 'default', name: 'service-a' },
} as unknown as KService;

/** What the mocked `Deployment.useList` returns; a test changes it and renders again. */
let list: { items: MockDeployment[] | null; error: unknown };

type View = ReturnType<typeof setup>;

/**
 * Renders the hook for `service-a`, with the live list holding the given Deployments.
 *
 * @param items - The Deployments the list starts with, or null while it is loading.
 * @param service - The Knative Service to restart.
 * @returns The rendered hook, and its `onDone` mock.
 */
function setup(items: MockDeployment[] | null, service: KService = kservice) {
  list = { items, error: null };
  const onDone = vi.fn();
  const view = renderHook(() => useKServiceRestart(service, { onDone }));
  return { ...view, onDone };
}

/**
 * Starts the restart and waits until its patches have been answered.
 *
 * @param view - The rendered hook.
 */
async function start(view: View) {
  await act(async () => {
    await view.result.current.restart();
  });
}

/**
 * Changes the live list and renders again, as a watch update does.
 *
 * @param view - The rendered hook.
 * @param items - The Deployments the list holds now.
 */
function publish(view: View, items: MockDeployment[] | null) {
  list.items = items;
  act(() => view.rerender());
}

/**
 * Lets time pass, with the timers that depend on it.
 *
 * @param ms - Milliseconds to advance the clock by.
 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useKServiceRestart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.enqueueSnackbar.mockReturnValue('progress-key');
    mocks.useList.mockImplementation(() => ({
      // A new array on every render, as the real list is.
      items: list.items && [...list.items],
      error: list.error,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('annotates each running Deployment and follows its rollout through the live list', async () => {
    const running = makeDeployment(FIRST, 2);
    const idle = makeDeployment(IDLE, 0);
    const view = setup([running, idle]);

    await start(view);

    expect(mocks.useList).toHaveBeenCalledWith({
      cluster: 'cluster-a',
      namespace: 'default',
      labelSelector: LABEL_SELECTOR,
    });
    expect(running.patch).toHaveBeenCalledTimes(1);
    expect(running.patch).toHaveBeenCalledWith({
      spec: { template: { metadata: { annotations: { [ANNOTATION]: NOW } } } },
    });
    expect(idle.patch).not.toHaveBeenCalled();
    expect(mocks.enqueueSnackbar).toHaveBeenCalledWith(
      `Restart in progress: rolling out ${FIRST}`,
      { variant: 'info', persist: true }
    );
    expect(view.result.current.restarting).toBe(true);

    publish(view, [restarted(FIRST, 2, { replicas: 3 }), idle]);
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
    expect(view.result.current.restarting).toBe(true);

    publish(view, [restarted(FIRST, 2), idle]);

    expect(mocks.notifyInfo).toHaveBeenCalledTimes(1);
    expect(mocks.notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(view.onDone).toHaveBeenCalledTimes(1);
    expect(mocks.closeSnackbar).toHaveBeenCalledWith('progress-key');
    expect(view.result.current.restarting).toBe(false);
  });

  it('is not ready until the list has loaded or failed', async () => {
    const view = setup(null);
    expect(view.result.current.ready).toBe(false);

    list.error = new ApiStatusError(403, 'forbidden');
    act(() => view.rerender());
    expect(view.result.current.ready).toBe(true);

    await start(view);

    expect(mocks.notifyError).toHaveBeenCalledWith('Restart failed: forbidden');
    expect(mocks.enqueueSnackbar).not.toHaveBeenCalled();
    expect(view.onDone).not.toHaveBeenCalled();
  });

  it('does not restart while a restart is running', async () => {
    const running = makeDeployment(FIRST, 1);
    const view = setup([running]);

    await start(view);
    await start(view);

    expect(running.patch).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the Knative Service has no cluster', async () => {
    const running = makeDeployment(FIRST, 1);
    const view = setup([running], {
      metadata: { namespace: 'default', name: 'service-a' },
    } as unknown as KService);

    await start(view);

    expect(running.patch).not.toHaveBeenCalled();
    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
  });

  it('refuses to restart a Knative Service without a namespace', async () => {
    const running = makeDeployment(FIRST, 1);
    const view = setup([running], {
      cluster: 'cluster-a',
      metadata: { name: 'service-a' },
    } as unknown as KService);

    await start(view);

    expect(running.patch).not.toHaveBeenCalled();
    expect(mocks.notifyError).toHaveBeenCalledWith('Restart failed: namespace not found');
  });

  it('says so when no Pods are running', async () => {
    const idle = makeDeployment(IDLE, 0);
    const view = setup([idle]);

    await start(view);

    expect(idle.patch).not.toHaveBeenCalled();
    expect(mocks.notifyInfo).toHaveBeenCalledWith('No running Pods found for KService');
    expect(mocks.enqueueSnackbar).not.toHaveBeenCalled();
    expect(view.onDone).not.toHaveBeenCalled();
    expect(view.result.current.restarting).toBe(false);
  });

  it('ignores updates that still show the Deployment from before the patch', async () => {
    const view = setup([makeDeployment(FIRST, 1)]);
    await start(view);

    publish(view, [makeDeployment(FIRST, 1)]);
    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
    expect(view.result.current.restarting).toBe(true);

    publish(view, [restarted(FIRST, 1)]);

    expect(mocks.notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
  });

  it('reports a failed patch without waiting for a rollout', async () => {
    const running = makeDeployment(FIRST, 1);
    running.patch.mockRejectedValueOnce(new ApiStatusError(403, 'forbidden'));
    const view = setup([running]);

    await start(view);

    expect(mocks.notifyError).toHaveBeenCalledTimes(1);
    expect(mocks.notifyError).toHaveBeenCalledWith(`Failed to restart ${FIRST}: forbidden`);
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
    expect(view.onDone).toHaveBeenCalledTimes(1);
    expect(mocks.closeSnackbar).toHaveBeenCalledWith('progress-key');
    expect(view.result.current.restarting).toBe(false);
  });

  it('keeps following the Deployments it patched when another patch fails', async () => {
    const first = makeDeployment(FIRST, 1);
    const second = makeDeployment(SECOND, 1);
    second.patch.mockRejectedValueOnce(new ApiStatusError(409, 'conflict'));
    const view = setup([first, second]);

    await start(view);
    expect(mocks.notifyError).toHaveBeenCalledWith(`Failed to restart ${SECOND}: conflict`);
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
    expect(view.result.current.restarting).toBe(true);

    publish(view, [restarted(FIRST, 1), second]);

    expect(mocks.notifyInfo).toHaveBeenCalledWith(`Restarted ${FIRST}`);
    expect(view.onDone).toHaveBeenCalledTimes(1);
  });

  it('treats a patch that throws as a failed patch', async () => {
    const running = makeDeployment(FIRST, 1);
    running.patch.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const view = setup([running]);

    await start(view);

    expect(mocks.notifyError).toHaveBeenCalledWith(`Failed to restart ${FIRST}: boom`);
    expect(view.result.current.restarting).toBe(false);
  });

  it('reports every Deployment whose rollout does not complete', async () => {
    const view = setup([makeDeployment(FIRST, 1), makeDeployment(SECOND, 1)]);
    await start(view);

    publish(view, [restarted(FIRST, 1, { conditions: DEADLINE_EXCEEDED })]);

    expect(mocks.notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} exceeded its progress deadline; ` +
        `${SECOND} was removed before its rollout finished`
    );
    expect(mocks.notifyInfo).not.toHaveBeenCalled();
    expect(view.onDone).toHaveBeenCalledTimes(1);
  });

  it('does not take a list that is loading again for removed Deployments', async () => {
    const view = setup([makeDeployment(FIRST, 1)]);
    await start(view);

    publish(view, null);
    expect(mocks.notifyError).not.toHaveBeenCalled();

    publish(view, [restarted(FIRST, 1)]);
    expect(mocks.notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
  });

  describe('when a rollout does not finish', () => {
    it('waits an hour for a rollout that keeps changing, then reports it', async () => {
      const view = setup([makeDeployment(FIRST, 4)]);
      await start(view);

      for (let updated = 1; updated <= 3; updated++) {
        publish(view, [restarted(FIRST, 4, { updatedReplicas: updated })]);
        await advance(ROLLOUT_TIMEOUT_MS / 4 - 1);
      }
      expect(mocks.notifyError).not.toHaveBeenCalled();
      expect(view.result.current.restarting).toBe(true);

      await advance(ROLLOUT_TIMEOUT_MS / 4 + 3);

      expect(mocks.notifyError).toHaveBeenCalledWith(
        `Restart did not complete: ${FIRST} did not finish rolling out in time`
      );
      expect(view.onDone).toHaveBeenCalledTimes(1);
      expect(mocks.closeSnackbar).toHaveBeenCalledWith('progress-key');
      expect(view.result.current.restarting).toBe(false);
    });

    it('reports a Deployment whose patch gets no answer once the time is up', async () => {
      const running = makeDeployment(FIRST, 1);
      running.patch.mockReturnValueOnce(new Promise(() => {}));
      const view = setup([running]);
      act(() => {
        void view.result.current.restart();
      });

      await advance(ROLLOUT_TIMEOUT_MS);

      expect(mocks.notifyError).toHaveBeenCalledWith(
        `Restart did not complete: ${FIRST} did not finish rolling out in time`
      );
      expect(view.result.current.restarting).toBe(false);
    });

    it('can restart again afterwards', async () => {
      const running = makeDeployment(FIRST, 1);
      const view = setup([running]);
      await start(view);
      await advance(ROLLOUT_TIMEOUT_MS);

      await start(view);

      expect(running.patch).toHaveBeenCalledTimes(2);
      expect(view.result.current.restarting).toBe(true);
    });
  });

  describe('when the component unmounts', () => {
    it('stops following the rollout and clears the progress', async () => {
      const view = setup([makeDeployment(FIRST, 1)]);
      await start(view);

      view.unmount();
      await advance(2 * ROLLOUT_TIMEOUT_MS);

      expect(mocks.closeSnackbar).toHaveBeenCalledWith('progress-key');
      expect(mocks.notifyError).not.toHaveBeenCalled();
      expect(mocks.notifyInfo).not.toHaveBeenCalled();
      expect(view.onDone).not.toHaveBeenCalled();
    });
  });
});
