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

import { vi } from 'vitest';
import {
  getRolloutState,
  RESTARTED_AT_ANNOTATION,
  restartKServicePods,
} from './restartKServicePods';

/** An API error with an HTTP status, like the ones Headlamp's API calls reject with. */
class ApiStatusError extends Error {
  /** HTTP status code of the failed request. */
  readonly status: number;

  /**
   * Creates an error for a request that failed with the given status.
   *
   * @param status - HTTP status code of the failed request.
   * @param message - Error message.
   */
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiStatusError';
    this.status = status;
  }
}

/** A Deployment as the tests hand it to the restart. */
type MockDeployment = {
  /** Name, generation, and a resourceVersion that changes with the generation or status. */
  metadata: {
    /** Name of the Deployment. */
    name: string;
    /** Generation of the Deployment's spec. */
    generation: number;
    /** Changes whenever the generation or the status changes. */
    resourceVersion: string;
  };
  /** Desired Pods, progress deadline and the Pod template's annotations. */
  spec: {
    /** Number of Pods the Deployment should run. */
    replicas: number;
    /** Seconds a rollout may go without progress; unset means the 600-second default. */
    progressDeadlineSeconds?: number;
    /** The Pod template. */
    template: {
      /** Metadata of the Pod template. */
      metadata: {
        /** Annotations of the Pod template, including the restart annotation. */
        annotations: Record<string, string>;
      };
    };
  };
  /** What the Deployment controller reports about the rollout. */
  status: {
    /** The generation the controller has acted on. */
    observedGeneration: number;
    /** All Pods of the Deployment, old and new. */
    replicas: number;
    /** Pods created from the latest template. */
    updatedReplicas: number;
    /** Pods that are ready to serve. */
    availableReplicas: number;
    /** Conditions reported by the controller. */
    conditions?: Array<{
      /** Condition type, for example `Progressing`. */
      type: string;
      /** Why the condition is in its state, for example `ProgressDeadlineExceeded`. */
      reason: string;
    }>;
  };
  /** Mock of the Deployment's `patch`. */
  patch: ReturnType<typeof vi.fn>;
};

/** The callbacks of the watch a restart started, so a test can drive it. */
type Feed = {
  /** Sends a new list of Deployments to the restart. */
  onUpdate: (deployments: MockDeployment[]) => void;
  /** Sends a watch error to the restart. */
  onError: (err: unknown) => void;
  /** Mock of the function that stops the watch. */
  stop: ReturnType<typeof vi.fn>;
};

const NOW = '2026-01-01T00:00:00.000Z';
const AHEAD = '2026-01-01T00:10:00.000Z';
const FIRST = 'service-a-00002-deployment';
const SECOND = 'service-a-00003-deployment';
const IDLE = 'service-a-00001-deployment';
const QUERY = {
  cluster: 'cluster-a',
  namespace: 'default',
  labelSelector: 'serving.knative.dev/service=service-a',
};
const REVERTED = `${FIRST} lost its restart annotation (restarts need Knative 1.21 or later)`;
const DEADLINE_EXCEEDED = [{ type: 'Progressing', reason: 'ProgressDeadlineExceeded' }];

const clearProgress = vi.fn();
const listDeploymentsByLabelSelector = vi.fn();
const notifyError = vi.fn();
const notifyInfo = vi.fn();
const setProgress = vi.fn();
const watchDeploymentsByLabelSelector = vi.fn();

let feed: Feed;

/**
 * Builds a Deployment whose rollout is complete unless `status` says otherwise.
 *
 * @param name - Name of the Deployment.
 * @param replicas - Desired number of Pods, also used for every status count.
 * @param status - Status fields to override.
 * @param options - Generation, restart annotation time and progress deadline.
 * @returns The Deployment, with a `patch` mock that resolves.
 */
function makeDeployment(
  name: string,
  replicas: number,
  status: Partial<MockDeployment['status']> = {},
  options: { generation?: number; restartedAt?: string; progressDeadlineSeconds?: number } = {}
): MockDeployment {
  const generation = options.generation ?? 1;
  const fullStatus = {
    observedGeneration: generation,
    replicas,
    updatedReplicas: replicas,
    availableReplicas: replicas,
    ...status,
  };
  return {
    metadata: { name, generation, resourceVersion: JSON.stringify([generation, fullStatus]) },
    spec: {
      replicas,
      progressDeadlineSeconds: options.progressDeadlineSeconds,
      template: {
        metadata: {
          annotations: options.restartedAt
            ? { [RESTARTED_AT_ANNOTATION]: options.restartedAt }
            : {},
        },
      },
    },
    status: fullStatus,
    patch: vi.fn().mockResolvedValue({}),
  };
}

/**
 * Builds a Deployment as it looks after the restart patch: generation 2, with the restart
 * annotation.
 *
 * @param name - Name of the Deployment.
 * @param replicas - Desired number of Pods.
 * @param status - Status fields to override.
 * @returns The restarted Deployment.
 */
function restarted(
  name: string,
  replicas: number,
  status: Partial<MockDeployment['status']> = {}
): MockDeployment {
  return makeDeployment(name, replicas, status, { generation: 2, restartedAt: NOW });
}

/**
 * Starts restarting `service-a` in namespace `default` of `cluster-a`, with the mocked
 * dependencies.
 *
 * @returns The `onDone` mock, and the restart's promise.
 */
function begin() {
  const onDone = vi.fn();
  const operation = restartKServicePods({
    clearProgress,
    cluster: 'cluster-a',
    listDeploymentsByLabelSelector,
    namespace: 'default',
    notifyError,
    notifyInfo,
    onDone,
    serviceName: 'service-a',
    setProgress,
    watchDeploymentsByLabelSelector,
  });

  return { onDone, operation };
}

/**
 * Lets pending promise callbacks and zero-delay timers run.
 *
 * @returns A promise that resolves once they have run.
 */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

/**
 * Starts a restart whose first read finds the given Deployments, and lets it start the watch
 * when any of them has running Pods.
 *
 * @param current - The Deployments the first read returns.
 * @returns The `onDone` mock, and the restart's promise.
 */
async function startRestart(current: MockDeployment[]) {
  listDeploymentsByLabelSelector.mockResolvedValueOnce(current);
  const started = begin();
  await flush();
  return started;
}

describe('restartKServicePods', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    clearProgress.mockReset();
    listDeploymentsByLabelSelector.mockReset();
    notifyError.mockReset();
    notifyInfo.mockReset();
    setProgress.mockReset();
    watchDeploymentsByLabelSelector.mockReset();
    watchDeploymentsByLabelSelector.mockImplementation((_query, onUpdate, onError) => {
      feed = { onUpdate, onError, stop: vi.fn() };
      return feed.stop;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('annotates each running Deployment and follows its rollout through one watch', async () => {
    const running = makeDeployment(FIRST, 2);
    const idle = makeDeployment(IDLE, 0);
    const { onDone, operation } = await startRestart([running, idle]);

    feed.onUpdate([running, idle]);
    await flush();
    expect(setProgress).toHaveBeenCalledWith(`Restart in progress: rolling out ${FIRST}`);
    feed.onUpdate([restarted(FIRST, 2, { replicas: 3 })]);
    feed.onUpdate([restarted(FIRST, 2)]);
    await operation;

    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(1);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledWith(QUERY);
    expect(watchDeploymentsByLabelSelector).toHaveBeenCalledTimes(1);
    expect(watchDeploymentsByLabelSelector.mock.calls[0][0]).toEqual(QUERY);
    expect(running.patch).toHaveBeenCalledTimes(1);
    expect(running.patch).toHaveBeenCalledWith({
      spec: { template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: NOW } } } },
    });
    expect(idle.patch).not.toHaveBeenCalled();
    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(notifyError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(feed.stop).toHaveBeenCalledTimes(1);
    expect(clearProgress).toHaveBeenCalled();
  });

  it('ignores updates that still show the Deployment from before the patch', async () => {
    const running = makeDeployment(FIRST, 1);
    const { operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await flush();
    expect(notifyError).not.toHaveBeenCalled();
    expect(notifyInfo).not.toHaveBeenCalled();

    feed.onUpdate([restarted(FIRST, 1)]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
  });

  it('waits for the generation from the patch when the patch updates the object', async () => {
    const running = makeDeployment(FIRST, 1);
    running.patch.mockImplementationOnce(async () => {
      running.metadata.generation = 2;
      return {};
    });
    const { operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([restarted(FIRST, 1)]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('waits for the generation the patch returned, not an earlier change', async () => {
    const running = makeDeployment(FIRST, 2);
    running.patch.mockResolvedValueOnce({ metadata: { generation: 3 } });
    const { operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([makeDeployment(FIRST, 1, {}, { generation: 2 })]);
    await flush();
    expect(notifyError).not.toHaveBeenCalled();

    feed.onUpdate([makeDeployment(FIRST, 2, {}, { generation: 3, restartedAt: NOW })]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('treats a newer restart annotation as a finished restart', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);

    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await flush();
    feed.onUpdate([
      makeDeployment(FIRST, 1, {}, { generation: 3, restartedAt: '2026-01-01T00:05:00.000Z' }),
    ]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('does not start a watch when no Pods are running', async () => {
    const idle = makeDeployment(IDLE, 0);
    const { onDone, operation } = await startRestart([idle]);
    await operation;

    expect(watchDeploymentsByLabelSelector).not.toHaveBeenCalled();
    expect(idle.patch).not.toHaveBeenCalled();
    expect(notifyInfo).toHaveBeenCalledWith('No running Pods found for KService');
    expect(setProgress).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('stops the watch when the Pods are gone by the time it lists them', async () => {
    const { onDone, operation } = await startRestart([makeDeployment(FIRST, 1)]);

    const idle = makeDeployment(FIRST, 0);
    feed.onUpdate([idle]);
    await operation;

    expect(idle.patch).not.toHaveBeenCalled();
    expect(notifyInfo).toHaveBeenCalledWith('No running Pods found for KService');
    expect(onDone).not.toHaveBeenCalled();
    expect(feed.stop).toHaveBeenCalledTimes(1);
  });

  it('fails the restart when the first read fails', async () => {
    listDeploymentsByLabelSelector.mockRejectedValueOnce(new ApiStatusError(403, 'forbidden'));
    const { operation } = begin();

    await expect(operation).rejects.toThrow('forbidden');
    expect(watchDeploymentsByLabelSelector).not.toHaveBeenCalled();
    expect(setProgress).not.toHaveBeenCalled();
  });

  it('fails the restart when the first read never answers', async () => {
    listDeploymentsByLabelSelector.mockReturnValueOnce(new Promise(() => {}));
    const { operation } = begin();
    const outcome = expect(operation).rejects.toThrow('Timed out listing Deployments');

    await vi.advanceTimersByTimeAsync(120_000);
    await outcome;
    expect(watchDeploymentsByLabelSelector).not.toHaveBeenCalled();
  });

  it('fails the restart when the watch never lists the Deployments', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);
    const outcome = expect(operation).rejects.toThrow('Timed out listing Deployments');

    await vi.advanceTimersByTimeAsync(119_000);
    expect(feed.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(feed.stop).toHaveBeenCalledTimes(1);
  });

  it('fails the restart when the watch cannot list the Deployments', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);

    feed.onError(new ApiStatusError(403, 'forbidden'));

    await expect(operation).rejects.toThrow('forbidden');
    expect(feed.stop).toHaveBeenCalledTimes(1);
    expect(clearProgress).toHaveBeenCalled();
  });

  it('reports a failed patch without waiting for a rollout', async () => {
    const running = makeDeployment(FIRST, 1);
    running.patch.mockRejectedValueOnce(new ApiStatusError(403, 'forbidden'));
    const { onDone, operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(`Failed to restart ${FIRST}: forbidden`);
    expect(notifyInfo).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(feed.stop).toHaveBeenCalledTimes(1);
  });

  it('keeps tracking the Deployments it patched when another patch fails', async () => {
    const first = makeDeployment(FIRST, 1);
    const second = makeDeployment(SECOND, 1);
    second.patch.mockRejectedValueOnce(new ApiStatusError(409, 'conflict'));
    const { operation } = await startRestart([first, second]);

    feed.onUpdate([first, second]);
    await flush();
    expect(notifyError).toHaveBeenCalledWith(`Failed to restart ${SECOND}: conflict`);
    expect(notifyInfo).not.toHaveBeenCalled();

    feed.onUpdate([restarted(FIRST, 1), second]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith(`Restarted ${FIRST}`);
  });

  it.each([
    ['a timed-out request', new ApiStatusError(408, 'Request timed-out')],
    ['an unreachable cluster', new ApiStatusError(502, 'Unreachable')],
    ['a server error', new ApiStatusError(500, 'Internal Server Error')],
    ['an error without a status', new Error('Failed to fetch')],
  ])('keeps following a Deployment whose patch fails with %s', async (_name, err) => {
    const running = makeDeployment(FIRST, 1);
    running.patch.mockRejectedValueOnce(err);
    const { operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([restarted(FIRST, 1)]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('keeps following a Deployment whose patch gets no answer', async () => {
    const first = makeDeployment(FIRST, 1);
    const second = makeDeployment(SECOND, 1);
    second.patch.mockReturnValueOnce(new Promise(() => {}));
    const { operation } = await startRestart([first, second]);

    feed.onUpdate([first, second]);
    feed.onUpdate([restarted(FIRST, 1), restarted(SECOND, 1)]);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(notifyInfo).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    await operation;

    expect(notifyError).not.toHaveBeenCalled();
  });

  it('reports a Deployment whose unanswered patch never rolls out', async () => {
    const running = makeDeployment(FIRST, 1);
    running.patch.mockReturnValueOnce(new Promise(() => {}));
    const { operation } = await startRestart([running]);
    listDeploymentsByLabelSelector.mockResolvedValueOnce([running]);

    feed.onUpdate([running]);
    await vi.advanceTimersByTimeAsync(120_000 + 660_000);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} may not have been patched: Timed out patching Deployment`
    );
  });

  it('does not take another change for an unanswered patch', async () => {
    const running = makeDeployment(FIRST, 1);
    running.patch.mockReturnValueOnce(new Promise(() => {}));
    const { operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([makeDeployment(FIRST, 2, {}, { generation: 2 })]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(notifyError).not.toHaveBeenCalled();
    expect(notifyInfo).not.toHaveBeenCalled();

    feed.onUpdate([makeDeployment(FIRST, 2, {}, { generation: 3, restartedAt: NOW })]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('does not take an annotation from before the patch for an unanswered patch', async () => {
    const running = makeDeployment(FIRST, 1, {}, { restartedAt: AHEAD });
    running.patch.mockRejectedValueOnce(new ApiStatusError(502, 'Unreachable'));
    const { operation } = await startRestart([running]);
    const scaled = makeDeployment(FIRST, 2, {}, { generation: 2, restartedAt: AHEAD });
    listDeploymentsByLabelSelector.mockResolvedValueOnce([scaled]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([scaled]);
    await flush();
    expect(notifyError).not.toHaveBeenCalled();
    expect(notifyInfo).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(660_000);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} may not have been patched: Unreachable`
    );
    expect(notifyInfo).not.toHaveBeenCalled();
  });

  it('confirms an unanswered patch that replaced an annotation from a clock ahead', async () => {
    const running = makeDeployment(FIRST, 1, {}, { restartedAt: AHEAD });
    running.patch.mockRejectedValueOnce(new ApiStatusError(502, 'Unreachable'));
    const { operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([restarted(FIRST, 1)]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('reports every Deployment whose rollout does not complete', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1), makeDeployment(SECOND, 1)]);

    feed.onUpdate([makeDeployment(FIRST, 1), makeDeployment(SECOND, 1)]);
    await flush();
    feed.onUpdate([restarted(FIRST, 1, { conditions: DEADLINE_EXCEEDED })]);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} exceeded its progress deadline; ` +
        `${SECOND} was removed before its rollout finished`
    );
    expect(notifyInfo).not.toHaveBeenCalled();
  });

  it('times out when a rollout makes no progress, after one fresh read', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);
    listDeploymentsByLabelSelector.mockResolvedValueOnce([
      restarted(FIRST, 1, { observedGeneration: 1 }),
    ]);

    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await flush();
    feed.onUpdate([restarted(FIRST, 1, { observedGeneration: 1 })]);
    await vi.advanceTimersByTimeAsync(659_000);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await operation;

    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(2);
    expect(listDeploymentsByLabelSelector).toHaveBeenLastCalledWith(QUERY);
    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} did not finish rolling out in time`
    );
    expect(watchDeploymentsByLabelSelector).toHaveBeenCalledTimes(1);
    expect(feed.stop).toHaveBeenCalledTimes(1);
  });

  it('confirms with a fresh read when the watch stops delivering updates', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);
    listDeploymentsByLabelSelector.mockResolvedValueOnce([restarted(FIRST, 1)]);

    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await vi.advanceTimersByTimeAsync(660_000);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('reports the error when the fresh read fails', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);
    listDeploymentsByLabelSelector.mockRejectedValueOnce(new ApiStatusError(403, 'forbidden'));

    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await vi.advanceTimersByTimeAsync(660_000);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} could not be checked: forbidden`
    );
  });

  it('reports the Deployments as unchecked when the fresh read never answers', async () => {
    const { onDone, operation } = await startRestart([makeDeployment(FIRST, 1)]);
    listDeploymentsByLabelSelector.mockReturnValueOnce(new Promise(() => {}));

    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await vi.advanceTimersByTimeAsync(660_000);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(notifyError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} could not be checked: Timed out listing Deployments`
    );
    await operation;
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(feed.stop).toHaveBeenCalledTimes(1);
  });

  it('does not wait longer for repeated identical updates', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);
    const stuck = [restarted(FIRST, 1, { observedGeneration: 1 })];
    listDeploymentsByLabelSelector.mockResolvedValueOnce(stuck);

    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await flush();
    feed.onUpdate(stuck);
    await vi.advanceTimersByTimeAsync(300_000);
    feed.onUpdate(stuck);
    await vi.advanceTimersByTimeAsync(300_000);
    feed.onUpdate(stuck);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(2);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} did not finish rolling out in time`
    );
  });

  it('does not wait longer for changes to Deployments it is not tracking', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1), makeDeployment(IDLE, 0)]);
    const stuck = restarted(FIRST, 1, { observedGeneration: 1 });
    listDeploymentsByLabelSelector.mockResolvedValueOnce([stuck]);

    feed.onUpdate([makeDeployment(FIRST, 1), makeDeployment(IDLE, 0)]);
    await flush();
    feed.onUpdate([stuck, makeDeployment(IDLE, 1)]);
    await vi.advanceTimersByTimeAsync(300_000);
    feed.onUpdate([stuck, makeDeployment(IDLE, 2)]);
    await vi.advanceTimersByTimeAsync(300_000);
    feed.onUpdate([stuck, makeDeployment(IDLE, 3)]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(2);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} did not finish rolling out in time`
    );
  });

  it('does not wait longer for changes to a rollout that has finished', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1), makeDeployment(SECOND, 1)]);
    const stuck = restarted(SECOND, 1, { observedGeneration: 1 });
    listDeploymentsByLabelSelector.mockResolvedValueOnce([restarted(FIRST, 1), stuck]);

    feed.onUpdate([makeDeployment(FIRST, 1), makeDeployment(SECOND, 1)]);
    await flush();
    feed.onUpdate([restarted(FIRST, 1), stuck]);
    await vi.advanceTimersByTimeAsync(300_000);
    feed.onUpdate([restarted(FIRST, 1, { replicas: 2 }), stuck]);
    await vi.advanceTimersByTimeAsync(360_000);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(2);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${SECOND} did not finish rolling out in time`
    );
  });

  it('stops waiting after an hour even while a rollout keeps changing', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 4)]);
    listDeploymentsByLabelSelector.mockResolvedValueOnce([
      restarted(FIRST, 4, { updatedReplicas: 2 }),
    ]);

    feed.onUpdate([makeDeployment(FIRST, 4)]);
    await flush();
    for (let step = 0; step < 6; step++) {
      feed.onUpdate([restarted(FIRST, 4, { updatedReplicas: step % 2 === 0 ? 1 : 2 })]);
      await vi.advanceTimersByTimeAsync(500_000);
    }
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(1);

    for (let step = 6; step < 8; step++) {
      feed.onUpdate([restarted(FIRST, 4, { updatedReplicas: step % 2 === 0 ? 1 : 2 })]);
      await vi.advanceTimersByTimeAsync(500_000);
    }
    await operation;

    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(2);
    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} did not finish rolling out in time`
    );
  });

  it("waits for the Deployment's own progress deadline plus one minute", async () => {
    const running = makeDeployment(FIRST, 1, {}, { progressDeadlineSeconds: 120 });
    const { operation } = await startRestart([running]);
    listDeploymentsByLabelSelector.mockResolvedValueOnce([restarted(FIRST, 1)]);

    feed.onUpdate([running]);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(2);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
  });

  it('caps the wait at an hour for a Deployment without a progress deadline', async () => {
    const running = makeDeployment(FIRST, 1, {}, { progressDeadlineSeconds: 2_147_483_647 });
    const { operation } = await startRestart([running]);
    listDeploymentsByLabelSelector.mockResolvedValueOnce([restarted(FIRST, 1)]);

    feed.onUpdate([running]);
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(notifyError).not.toHaveBeenCalled();
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listDeploymentsByLabelSelector).toHaveBeenCalledTimes(2);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
  });

  it('keeps waiting while the rollout keeps making progress', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 3)]);

    feed.onUpdate([makeDeployment(FIRST, 3)]);
    await flush();
    feed.onUpdate([restarted(FIRST, 3, { updatedReplicas: 1, replicas: 4 })]);
    await vi.advanceTimersByTimeAsync(500_000);
    feed.onUpdate([restarted(FIRST, 3, { updatedReplicas: 2, replicas: 4 })]);
    await vi.advanceTimersByTimeAsync(500_000);
    feed.onUpdate([restarted(FIRST, 3)]);
    await operation;

    expect(notifyInfo).toHaveBeenCalledWith('Restart completed successfully');
    expect(watchDeploymentsByLabelSelector).toHaveBeenCalledTimes(1);
  });

  it('reports a restart that Knative reverted', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);

    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await flush();
    feed.onUpdate([makeDeployment(FIRST, 1, {}, { generation: 3 })]);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(`Restart did not complete: ${REVERTED}`);
  });

  it('reports a restart that Knative set back to an older restart annotation', async () => {
    const earlier = '2025-12-01T00:00:00.000Z';
    const running = makeDeployment(FIRST, 1, {}, { restartedAt: earlier });
    const { operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([makeDeployment(FIRST, 1, {}, { generation: 3, restartedAt: earlier })]);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(`Restart did not complete: ${REVERTED}`);
    expect(notifyInfo).not.toHaveBeenCalled();
  });

  it('reports a restart that Knative set back to an annotation from a clock ahead', async () => {
    const running = makeDeployment(FIRST, 1, {}, { restartedAt: AHEAD });
    const { operation } = await startRestart([running]);

    feed.onUpdate([running]);
    await flush();
    feed.onUpdate([makeDeployment(FIRST, 1, {}, { generation: 3, restartedAt: AHEAD })]);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(`Restart did not complete: ${REVERTED}`);
    expect(notifyInfo).not.toHaveBeenCalled();
  });

  it('reports a Deployment that disappears during the rollout', async () => {
    const { operation } = await startRestart([makeDeployment(FIRST, 1)]);

    feed.onUpdate([makeDeployment(FIRST, 1)]);
    await flush();
    feed.onUpdate([]);
    await operation;

    expect(notifyError).toHaveBeenCalledWith(
      `Restart did not complete: ${FIRST} was removed before its rollout finished`
    );
  });
});

describe('getRolloutState', () => {
  it('waits until the controller has observed the new Pod template', () => {
    expect(getRolloutState(restarted(FIRST, 1, { observedGeneration: 1 }))).toBe('progressing');
  });

  it('waits until old Pods are gone and new Pods are available', () => {
    expect(getRolloutState(makeDeployment(FIRST, 2, { replicas: 3 }))).toBe('progressing');
    expect(getRolloutState(makeDeployment(FIRST, 2, { updatedReplicas: 1 }))).toBe('progressing');
    expect(getRolloutState(makeDeployment(FIRST, 2, { availableReplicas: 1 }))).toBe('progressing');
    expect(getRolloutState(makeDeployment(FIRST, 2))).toBe('complete');
  });

  it('fails when the rollout exceeds its progress deadline', () => {
    expect(getRolloutState(makeDeployment(FIRST, 1, { conditions: DEADLINE_EXCEEDED }))).toBe(
      'failed'
    );
  });
});
