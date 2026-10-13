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

export const RESTARTED_AT_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_PROGRESS_DEADLINE_SECONDS = 600;
const ROLLOUT_TIMEOUT_MARGIN_MS = 60_000;
const MAX_ROLLOUT_TIMEOUT_MS = 3_600_000;

/** The parts of a Deployment that the restart reads to follow its rollout. */
type DeploymentState = {
  /** The Deployment's identity and version. */
  metadata: {
    /** Name of the Deployment. */
    name?: string;
    /** Goes up each time the Deployment's spec changes, including with the restart patch. */
    generation?: number;
    /** Changes on every update to the Deployment, so a new value means something changed. */
    resourceVersion?: string;
  };
  /** What the Deployment should run. */
  spec?: {
    /** Number of Pods the Deployment should run; 0 when the Service has scaled to zero. */
    replicas?: number;
    /** Seconds a rollout may go without progress before Kubernetes marks it as failed. */
    progressDeadlineSeconds?: number;
    /** The template every Pod of the Deployment is created from. */
    template?: {
      /** Metadata given to every Pod. */
      metadata?: {
        /** Pod annotations, including `kubectl.kubernetes.io/restartedAt`. */
        annotations?: Record<string, string>;
      };
    };
  };
  /** What the Deployment controller last reported. */
  status?: {
    /** The generation the controller has acted on. */
    observedGeneration?: number;
    /** All Pods of the Deployment, old and new. */
    replicas?: number;
    /** Pods created from the latest template. */
    updatedReplicas?: number;
    /** Pods that are ready to serve traffic. */
    availableReplicas?: number;
    /** Conditions reported by the controller. */
    conditions?: Array<{
      /** Condition type, for example `Progressing`. */
      type?: string;
      /** Why the condition is in its state, for example `ProgressDeadlineExceeded`. */
      reason?: string;
    }>;
  };
};

/** A Deployment from the watch, which the restart can also patch. */
type RestartDeployment = DeploymentState & {
  /**
   * Applies a merge patch to the Deployment.
   *
   * @param body - The patch that sets the restart annotation on the Pod template.
   * @returns The updated Deployment, when the API server sends it back.
   */
  patch: (body: {
    spec: { template: { metadata: { annotations: Record<string, string> } } };
  }) => Promise<{ metadata?: { generation?: number } } | undefined>;
};

/** Selects the Deployments of one Knative Service. */
type DeploymentQuery = {
  /** Cluster the Knative Service runs in. */
  cluster: string;
  /** Namespace of the Knative Service. */
  namespace: string;
  /** Label selector for the Service's Deployments: `serving.knative.dev/service=<name>`. */
  labelSelector: string;
};

/**
 * Starts watching the Deployments that match a query.
 *
 * @param query - The Deployments to watch.
 * @param onUpdate - Called with every matching Deployment after each change.
 * @param onError - Called when listing or watching fails.
 * @returns A function that stops the watch.
 */
type WatchDeploymentsByLabelSelector = (
  query: DeploymentQuery,
  onUpdate: (deployments: RestartDeployment[]) => void,
  onError: (err: unknown) => void
) => () => void;

/**
 * Reads the Deployments that match a query once, without watching.
 *
 * @param query - The Deployments to read.
 * @returns The matching Deployments.
 */
type ListDeploymentsByLabelSelector = (query: DeploymentQuery) => Promise<DeploymentState[]>;

/** What {@link restartKServicePods} needs from its caller. */
type RestartKServicePodsOptions = {
  /** Removes the progress notification. */
  clearProgress: () => void;
  /** Cluster the Knative Service runs in. */
  cluster: string;
  /**
   * Reads the Deployments once: first to see whether any has running Pods, and again to confirm
   * their state before reporting a timeout.
   */
  listDeploymentsByLabelSelector: ListDeploymentsByLabelSelector;
  /** Namespace of the Knative Service. */
  namespace: string;
  /** Shows an error notification. */
  notifyError: (message: string) => void;
  /** Shows an information notification. */
  notifyInfo: (message: string) => void;
  /**
   * Called once the result for the running Deployments has been reported, even when their patches
   * failed; not called when none has running Pods or the Deployments cannot be read.
   */
  onDone?: () => void;
  /** Name of the Knative Service to restart. */
  serviceName: string;
  /** Shows the progress notification, replacing any earlier one. */
  setProgress: (message: string) => void;
  /**
   * Watches the Deployments; every rollout is followed through this one watch, which starts only
   * when a Deployment has running Pods.
   */
  watchDeploymentsByLabelSelector: WatchDeploymentsByLabelSelector;
};

/**
 * Where a Deployment's rollout stands: `progressing` while it is still under way, `failed` when it
 * exceeded its progress deadline, and `complete` when every Pod runs the latest template and is
 * available.
 */
type RolloutState = 'complete' | 'progressing' | 'failed';

/** Why a Deployment's restart did not complete. */
type RolloutProblem = {
  /**
   * What went wrong: `failed` (the rollout exceeded its progress deadline), `reverted` (the restart
   * annotation was removed, or set back to its value from before the patch or to an older time),
   * `missing` (the Deployment was deleted), `timeout` (the rollout did not finish in time),
   * `unchecked` (the final read failed or took too long) or `unconfirmed` (the patch got no clear
   * answer and the restart annotation never appeared).
   */
  outcome: 'failed' | 'reverted' | 'missing' | 'timeout' | 'unchecked' | 'unconfirmed';
  /** The error message of the failed read for `unchecked`, or of the failed patch for `unconfirmed`. */
  detail?: string;
};

/** What a restart changed, to judge the Deployments it patched by. */
type RestartRecord = {
  /** The time this restart wrote to the restart annotation. */
  restartedAt: string;
  /** Each Deployment's restart annotation from before the patch, by name. */
  previous: Map<string, string | undefined>;
  /**
   * The generation each Deployment reached with the restart patch, by name; data from an older
   * generation is ignored.
   */
  minGeneration: Map<string, number>;
  /**
   * The Deployments whose patch got no clear answer, with the error it failed with, by name. Their
   * data is ignored until it carries this restart, which moves them to `minGeneration`.
   */
  unconfirmed: Map<string, string | undefined>;
};

/** The latest data from the Deployment watch. */
type Snapshot = {
  /** Every matching Deployment, once the first list has arrived. */
  deployments?: RestartDeployment[];
  /** The latest watch error, cleared when a new list arrives. */
  error?: unknown;
};

/** When a wait gives up. */
type WaitOptions = {
  /** Milliseconds without activity after which the wait gives up. */
  idleMs: number;
  /** Milliseconds after which the wait gives up even with activity; defaults to `idleMs`. */
  totalMs?: number;
  /**
   * Summarises the latest data; only a change in this value counts as activity and restarts the
   * idle timer. It is read again after each evaluation, so it can depend on state that the
   * evaluation changes. Without it, the idle timer is never restarted.
   */
  activityKey?: (current: Snapshot) => string;
};

/**
 * Waits for a request, but no longer than a time limit.
 *
 * @param request - The request to wait for.
 * @param timeoutMs - Milliseconds to wait before giving up.
 * @param onTimeout - Produces the outcome when the request has not settled within `timeoutMs`.
 * @returns The request's result, or the outcome of `onTimeout`.
 * @throws The request's own error, or the error that `onTimeout` rejects with.
 */
function withTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => onTimeout().then(resolve, reject), timeoutMs);
    request.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Fails a list request that took too long.
 *
 * @returns A promise rejected with a timeout error.
 */
function listTimedOut(): Promise<never> {
  return Promise.reject(new Error('Timed out listing Deployments'));
}

/**
 * Fails a patch request that took too long.
 *
 * @returns A promise rejected with a timeout error.
 */
function patchTimedOut(): Promise<never> {
  return Promise.reject(new Error('Timed out patching Deployment'));
}

/**
 * Tells whether the API server refused a request, so that the request changed nothing. Timeouts,
 * network failures and server errors leave that open.
 *
 * @param err - The error the request failed with.
 * @returns True for a 4xx status other than 408 Request Timeout.
 */
function wasRefused(err: unknown): boolean {
  const status = (err as { status?: unknown } | undefined)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
}

/**
 * Tells whether a Deployment has running Pods to restart.
 *
 * @param deployment - The Deployment to check.
 * @returns True when the Deployment has a name and wants at least one Pod.
 */
function isRunning(deployment: DeploymentState): boolean {
  return !!deployment.metadata.name && (deployment.spec?.replicas ?? 0) > 0;
}

/**
 * Reads the message of a thrown value.
 *
 * @param err - The thrown value.
 * @returns The trimmed message, or undefined when there is none.
 */
function errorDetail(err: unknown): string | undefined {
  return (err as { message?: string } | undefined)?.message?.trim() || undefined;
}

/**
 * Describes why a Deployment's restart did not complete.
 *
 * @param name - Name of the Deployment.
 * @param problem - What went wrong.
 * @returns A sentence for the error notification.
 */
function describeProblem(name: string, problem: RolloutProblem): string {
  switch (problem.outcome) {
    case 'failed':
      return `${name} exceeded its progress deadline`;
    case 'reverted':
      return `${name} lost its restart annotation (restarts need Knative 1.21 or later)`;
    case 'missing':
      return `${name} was removed before its rollout finished`;
    case 'timeout':
      return `${name} did not finish rolling out in time`;
    case 'unchecked':
      return problem.detail
        ? `${name} could not be checked: ${problem.detail}`
        : `${name} could not be checked`;
    case 'unconfirmed':
      return problem.detail
        ? `${name} may not have been patched: ${problem.detail}`
        : `${name} may not have been patched`;
  }
}

/**
 * Judges a Deployment's rollout with the rules of `kubectl rollout status`.
 *
 * @param deployment - The Deployment to judge.
 * @returns `progressing` while the controller has not acted on the latest spec, new Pods are
 * missing or not yet available, or old Pods remain; `failed` when the rollout exceeded its progress
 * deadline; and `complete` otherwise.
 */
export function getRolloutState(deployment: DeploymentState): RolloutState {
  const status = deployment.status ?? {};
  if ((status.observedGeneration ?? 0) < (deployment.metadata.generation ?? 0)) {
    return 'progressing';
  }

  const progressing = status.conditions?.find(condition => condition.type === 'Progressing');
  if (progressing?.reason === 'ProgressDeadlineExceeded') {
    return 'failed';
  }

  const updated = status.updatedReplicas ?? 0;
  if (
    updated < (deployment.spec?.replicas ?? 0) ||
    (status.replicas ?? 0) > updated ||
    (status.availableReplicas ?? 0) < updated
  ) {
    return 'progressing';
  }

  return 'complete';
}

/**
 * Starts one watch on a Knative Service's Deployments and lets the restart wait on its updates.
 *
 * @param watch - Starts the Deployment watch.
 * @param query - The Deployments to watch.
 * @returns `stop`, which ends the watch, and `waitFor`, which waits for a result from the latest
 * data.
 */
function subscribe(watch: WatchDeploymentsByLabelSelector, query: DeploymentQuery) {
  const snapshot: Snapshot = {};
  let onChange: (() => void) | undefined;
  const stop = watch(
    query,
    deployments => {
      snapshot.deployments = deployments;
      snapshot.error = undefined;
      onChange?.();
    },
    err => {
      snapshot.error = err;
      onChange?.();
    }
  );

  /**
   * Waits until `evaluate` returns a result, or until the wait gives up.
   *
   * @param evaluate - Called with the latest data now and after every update; returns a result to
   * stop waiting, or undefined to keep waiting.
   * @param options - When the wait gives up.
   * @param onTimeout - Produces the result when the wait gives up.
   * @returns The first result from `evaluate`, or the result of `onTimeout`.
   */
  function waitFor<T>(
    evaluate: (current: Snapshot) => T | undefined,
    options: WaitOptions,
    onTimeout: () => T
  ) {
    return new Promise<T>(resolve => {
      const deadline = Date.now() + (options.totalMs ?? options.idleMs);
      let lastActivity: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: T) => {
        clearTimeout(timer);
        onChange = undefined;
        resolve(result);
      };
      const arm = () => {
        clearTimeout(timer);
        const delay = Math.max(0, Math.min(options.idleMs, deadline - Date.now()));
        timer = setTimeout(() => finish(onTimeout()), delay);
      };
      const check = () => {
        const result = evaluate(snapshot);
        if (result !== undefined) {
          finish(result);
        }
        lastActivity = options.activityKey?.(snapshot);
      };

      onChange = () => {
        if (options.activityKey?.(snapshot) !== lastActivity) {
          arm();
        }
        check();
      };
      arm();
      check();
    });
  }

  return { stop, waitFor };
}

/**
 * Reads a Deployment's restart annotation.
 *
 * @param deployment - The Deployment to read.
 * @returns The `kubectl.kubernetes.io/restartedAt` annotation of its Pod template, if it has one.
 */
function restartAnnotation(deployment: DeploymentState): string | undefined {
  return deployment.spec?.template?.metadata?.annotations?.[RESTARTED_AT_ANNOTATION];
}

/**
 * Tells whether a Deployment carries this restart.
 *
 * @param annotation - The Deployment's `kubectl.kubernetes.io/restartedAt` annotation.
 * @param previous - The annotation the Deployment had before this restart's patch.
 * @param restartedAt - The time this restart wrote to the annotation.
 * @returns True when the annotation has changed since before the patch and holds this restart's
 * time or a later one.
 */
function keepsRestart(
  annotation: string | undefined,
  previous: string | undefined,
  restartedAt: string
): boolean {
  return annotation !== previous && Date.parse(annotation ?? '') >= Date.parse(restartedAt);
}

/**
 * Checks each pending Deployment against the latest data. A Deployment whose rollout has finished,
 * or that has disappeared, is removed from `pending`, and any problem with it is added to
 * `problems`.
 *
 * @param deployments - The latest Deployments, from the watch or from a fresh read.
 * @param pending - Names of the Deployments whose rollout has not finished yet.
 * @param problems - Problems found so far, by Deployment name.
 * @param record - What the restart changed; a Deployment whose patch is confirmed moves from
 * `unconfirmed` to `minGeneration`.
 * @returns True when no Deployment is pending any more.
 */
function trackRollouts(
  deployments: DeploymentState[] | undefined,
  pending: Set<string>,
  problems: Map<string, RolloutProblem>,
  record: RestartRecord
): boolean {
  const { restartedAt, previous, minGeneration, unconfirmed } = record;
  for (const name of Array.from(pending)) {
    const deployment = deployments?.find(item => item.metadata.name === name);
    if (!deployment) {
      problems.set(name, { outcome: 'missing' });
      pending.delete(name);
      continue;
    }

    const carriesRestart = keepsRestart(
      restartAnnotation(deployment),
      previous.get(name),
      restartedAt
    );
    if (unconfirmed.has(name)) {
      if (!carriesRestart) {
        continue;
      }
      unconfirmed.delete(name);
      minGeneration.set(name, deployment.metadata.generation ?? 0);
    }
    if ((deployment.metadata.generation ?? 0) < (minGeneration.get(name) ?? 0)) {
      continue;
    }

    const state = getRolloutState(deployment);
    if (state === 'progressing') {
      continue;
    }
    if (state === 'failed') {
      problems.set(name, { outcome: 'failed' });
    } else if (!carriesRestart) {
      problems.set(name, { outcome: 'reverted' });
    }
    pending.delete(name);
  }

  return pending.size === 0;
}

/**
 * Restarts a Knative Service the way `kubectl rollout restart` does. It reads the Service's
 * Deployments once and stops when none has running Pods. Otherwise it watches them, sets the
 * `kubectl.kubernetes.io/restartedAt` annotation on the Pod template of each one that has running
 * Pods, follows every rollout through that watch, and reports the result. A patch that gets no
 * answer in time, or fails without the API server refusing it, is still followed, since the API
 * server may have applied it; its rollout counts only once the Deployment shows this restart's
 * annotation.
 *
 * @param options - The Knative Service to restart, and how to read Deployments and notify the user.
 * @returns A promise that resolves once the result has been reported, and rejects when the
 * Deployments cannot be listed.
 */
export async function restartKServicePods(options: RestartKServicePodsOptions) {
  const {
    clearProgress,
    cluster,
    listDeploymentsByLabelSelector,
    namespace,
    notifyError,
    notifyInfo,
    onDone,
    serviceName,
    setProgress,
    watchDeploymentsByLabelSelector,
  } = options;

  const query = { cluster, namespace, labelSelector: `serving.knative.dev/service=${serviceName}` };
  const current = await withTimeout(
    listDeploymentsByLabelSelector(query),
    REQUEST_TIMEOUT_MS,
    listTimedOut
  );
  if (!current.some(isRunning)) {
    notifyInfo('No running Pods found for KService');
    return;
  }

  const feed = subscribe(watchDeploymentsByLabelSelector, query);

  try {
    const initial = await feed.waitFor<{ deployments: RestartDeployment[] } | { error: unknown }>(
      ({ deployments, error }) => {
        if (error !== undefined) {
          return { error };
        }
        return deployments ? { deployments } : undefined;
      },
      { idleMs: REQUEST_TIMEOUT_MS },
      () => ({ error: new Error('Timed out listing Deployments') })
    );
    if ('error' in initial) {
      throw initial.error;
    }

    const running = initial.deployments.filter(isRunning);
    if (running.length === 0) {
      notifyInfo('No running Pods found for KService');
      return;
    }

    const names = running.map(deployment => deployment.metadata.name as string);
    const restartedAt = new Date().toISOString();
    setProgress(`Restart in progress: rolling out ${names.join(', ')}`);

    const generations = running.map(deployment => deployment.metadata.generation ?? 0);
    const record: RestartRecord = {
      restartedAt,
      previous: new Map(
        running.map(deployment => [
          deployment.metadata.name as string,
          restartAnnotation(deployment),
        ])
      ),
      minGeneration: new Map(),
      unconfirmed: new Map(),
    };
    const results = await Promise.allSettled(
      running.map(deployment =>
        withTimeout(
          deployment.patch({
            spec: {
              template: { metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: restartedAt } } },
            },
          }),
          REQUEST_TIMEOUT_MS,
          patchTimedOut
        )
      )
    );

    const tracked: string[] = [];
    const patchFailures: string[] = [];
    let progressDeadlineSeconds = 0;
    results.forEach((result, index) => {
      const deployment = running[index];
      const name = deployment.metadata.name as string;
      if (result.status === 'fulfilled') {
        record.minGeneration.set(
          name,
          result.value?.metadata?.generation ?? generations[index] + 1
        );
      } else if (wasRefused(result.reason)) {
        const detail = errorDetail(result.reason);
        patchFailures.push(detail ? `${name}: ${detail}` : name);
        return;
      } else {
        record.unconfirmed.set(name, errorDetail(result.reason));
      }

      tracked.push(name);
      progressDeadlineSeconds = Math.max(
        progressDeadlineSeconds,
        deployment.spec?.progressDeadlineSeconds ?? DEFAULT_PROGRESS_DEADLINE_SECONDS
      );
    });

    if (patchFailures.length > 0) {
      notifyError(`Failed to restart ${patchFailures.join('; ')}`);
    }

    if (tracked.length > 0) {
      const pending = new Set(tracked);
      const problems = new Map<string, RolloutProblem>();

      const settled = await feed.waitFor(
        ({ deployments }) =>
          trackRollouts(deployments, pending, problems, record) ? true : undefined,
        {
          idleMs: progressDeadlineSeconds * 1000 + ROLLOUT_TIMEOUT_MARGIN_MS,
          totalMs: MAX_ROLLOUT_TIMEOUT_MS,
          activityKey: ({ deployments }) =>
            Array.from(
              pending,
              name =>
                deployments?.find(item => item.metadata.name === name)?.metadata.resourceVersion
            ).join(','),
        },
        () => false
      );

      if (!settled) {
        try {
          trackRollouts(
            await withTimeout(
              listDeploymentsByLabelSelector(query),
              REQUEST_TIMEOUT_MS,
              listTimedOut
            ),
            pending,
            problems,
            record
          );
          pending.forEach(name =>
            problems.set(
              name,
              record.unconfirmed.has(name)
                ? { outcome: 'unconfirmed', detail: record.unconfirmed.get(name) }
                : { outcome: 'timeout' }
            )
          );
        } catch (err: unknown) {
          pending.forEach(name =>
            problems.set(name, { outcome: 'unchecked', detail: errorDetail(err) })
          );
        }
      }

      if (problems.size > 0) {
        const details = Array.from(problems, ([name, problem]) => describeProblem(name, problem));
        notifyError(`Restart did not complete: ${details.join('; ')}`);
      } else if (patchFailures.length > 0) {
        notifyInfo(`Restarted ${tracked.join(', ')}`);
      } else {
        notifyInfo('Restart completed successfully');
      }
    }

    onDone?.();
  } finally {
    feed.stop();
    clearProgress();
  }
}
