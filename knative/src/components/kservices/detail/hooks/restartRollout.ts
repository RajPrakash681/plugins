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

const RESTARTED_AT_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';

/**
 * How long a restart waits for its rollouts. Kubernetes marks a stalled rollout as failed on its
 * own once its progress deadline passes, so this only ends a restart whose rollout never reports.
 */
export const ROLLOUT_TIMEOUT_MS = 3_600_000;

/** The parts of a Deployment that the restart reads to follow its rollout. */
export type DeploymentState = {
  /** The Deployment's identity and version. */
  metadata: {
    /** Name of the Deployment. */
    name?: string;
    /** Goes up each time the Deployment's spec changes, including with the restart patch. */
    generation?: number;
  };
  /** What the Deployment should run. */
  spec?: {
    /** Number of Pods the Deployment should run; 0 when the Service has scaled to zero. */
    replicas?: number;
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

/**
 * Where a Deployment's rollout stands: `progressing` while it is still under way, `failed` when it
 * exceeded its progress deadline, and `complete` when every Pod runs the latest template and is
 * available.
 */
export type RolloutState = 'complete' | 'progressing' | 'failed';

/** Where the rollout of one restarted Deployment stands; `removed` when it has disappeared. */
export type RestartOutcome = RolloutState | 'removed';

/** What the restart tells the user once it is over. */
export type RestartReport = {
  /** Which kind of notification to show. */
  kind: 'error' | 'info';
  /** The notification text. */
  message: string;
};

/**
 * Tells whether a Deployment has running Pods to restart.
 *
 * @param deployment - The Deployment to check.
 * @returns True when the Deployment has a name and wants at least one Pod; the name is then known
 * to be set.
 */
export function isRunning<T extends DeploymentState>(
  deployment: T
): deployment is T & { metadata: { name: string } } {
  return !!deployment.metadata.name && (deployment.spec?.replicas ?? 0) > 0;
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
 * Builds the patch that restarts a Deployment, the way `kubectl rollout restart` does.
 *
 * @param restartedAt - The time to write to the restart annotation.
 * @returns The patch body, which sets the restart annotation on the Deployment's Pod template.
 */
export function restartPatch(restartedAt: string) {
  return {
    spec: {
      template: {
        metadata: { annotations: { [RESTARTED_AT_ANNOTATION]: restartedAt } },
      },
    },
  };
}

/**
 * Follows the rollout of a restart on one Deployment.
 *
 * A Deployment whose Pod template does not carry the restart yet is still `progressing`, so data
 * from before the patch never counts as a finished rollout. Once the annotation shows, the
 * Deployment's generation includes the patch, and {@link getRolloutState} waits for the controller
 * to act on it. A restart that someone else started later, which holds a later time, counts too.
 *
 * @param deployment - The Deployment as the cluster shows it now, or undefined if it is gone.
 * @param restartedAt - The time the restart wrote to the restart annotation.
 * @returns `removed` for a Deployment that is gone, `progressing` while the restart is not in its
 * Pod template yet, and else the state of its rollout.
 */
export function getRestartOutcome(
  deployment: DeploymentState | undefined,
  restartedAt: string
): RestartOutcome {
  if (!deployment) {
    return 'removed';
  }

  const annotation = deployment.spec?.template?.metadata?.annotations?.[RESTARTED_AT_ANNOTATION];
  return Date.parse(annotation ?? '') >= Date.parse(restartedAt)
    ? getRolloutState(deployment)
    : 'progressing';
}

const PROBLEMS: Partial<Record<RestartOutcome, string>> = {
  removed: 'was removed before its rollout finished',
  failed: 'exceeded its progress deadline',
  progressing: 'did not finish rolling out in time',
};

/**
 * Tells the user how a restart ended.
 *
 * @param outcomes - Where the rollout of each followed Deployment stands when the restart ends; one
 * that is still `progressing` has run out of time.
 * @param partial - True when the restart of another Deployment failed, which was reported already.
 * @returns An error with every problem, or else a success.
 */
export function buildReport(
  outcomes: Array<{ name: string; outcome: RestartOutcome }>,
  partial: boolean
): RestartReport {
  const problems = outcomes.flatMap(({ name, outcome }) => {
    const problem = PROBLEMS[outcome];
    return problem ? [`${name} ${problem}`] : [];
  });
  if (problems.length > 0) {
    return { kind: 'error', message: `Restart did not complete: ${problems.join('; ')}` };
  }
  if (partial) {
    return { kind: 'info', message: `Restarted ${outcomes.map(({ name }) => name).join(', ')}` };
  }
  return { kind: 'info', message: 'Restart completed successfully' };
}
