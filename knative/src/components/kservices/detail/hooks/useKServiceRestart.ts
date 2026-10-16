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

import { K8s } from '@kinvolk/headlamp-plugin/lib';
import type { SnackbarKey } from 'notistack';
import { useSnackbar } from 'notistack';
import React from 'react';
import type { KService } from '../../../../resources/knative';
import { withErrorDetail } from '../../../../utils/error';
import { useNotify } from '../../../common/notifications/useNotify';
import {
  buildReport,
  getRestartOutcome,
  isRunning,
  restartPatch,
  ROLLOUT_TIMEOUT_MS,
} from './restartRollout';

const { Deployment } = K8s.ResourceClasses;

type UseKServiceRestartOptions = {
  /**
   * Called once the restart is over, even when some of its patches failed; not called when no
   * Deployment has running Pods or the Deployments cannot be read.
   */
  onDone?: () => void;
};

/** A restart that has been started and not yet reported. */
type Run = {
  /** The time this restart wrote to the restart annotation. */
  restartedAt: string;
  /** The Deployments this restart patches. */
  names: string[];
  /** The Deployments whose patch failed, which the restart does not wait for. */
  failed: string[];
  /** True once the restart has waited as long as it will. */
  timedOut: boolean;
};

/**
 * Restarts a Knative Service the way `kubectl rollout restart` does. `restart` sets the
 * `kubectl.kubernetes.io/restartedAt` annotation on the Pod template of each of the Service's
 * Deployments that has running Pods, waits for every rollout to finish by watching the live
 * Deployment list, and reports the result. The Deployments are watched for as long as the
 * component that uses this hook is mounted; once it unmounts, the restart is no longer followed
 * and nothing more is reported, except a patch that fails after that.
 *
 * @param kservice - The Knative Service to restart.
 * @param options - `onDone`, called once the restart has reported its result.
 * @returns `restart`, which starts the restart; `restarting`, true until the result has been
 * reported; and `ready`, false while the Deployments are still loading.
 */
export function useKServiceRestart(kservice: KService, options?: UseKServiceRestartOptions) {
  const cluster = kservice.cluster;
  const namespace = kservice.metadata.namespace;
  const serviceName = kservice.metadata.name;
  const onDone = options?.onDone;

  const { notifyError, notifyInfo } = useNotify();
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const [run, setRun] = React.useState<Run | null>(null);

  const { items: deployments, error: listError } = Deployment.useList({
    cluster,
    namespace,
    labelSelector: `serving.knative.dev/service=${serviceName}`,
  });

  const progressSnackbarKeyRef = React.useRef<SnackbarKey | null>(null);
  const clearProgress = React.useCallback(() => {
    if (progressSnackbarKeyRef.current !== null) {
      closeSnackbar(progressSnackbarKeyRef.current);
      progressSnackbarKeyRef.current = null;
    }
  }, [closeSnackbar]);
  React.useEffect(() => clearProgress, [clearProgress]);

  // The restart gives up when its rollouts have not finished after a long time.
  const restartedAt = run?.restartedAt;
  React.useEffect(() => {
    if (restartedAt === undefined) {
      return undefined;
    }
    const timer = setTimeout(
      () => setRun(current => current && { ...current, timedOut: true }),
      ROLLOUT_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [restartedAt]);

  // The live list says how far each rollout is; once all are over, the restart tells the user.
  React.useEffect(() => {
    if (!run) {
      return;
    }

    const outcomes = run.names
      .filter(name => !run.failed.includes(name))
      .map(name => ({
        name,
        outcome:
          deployments === null
            ? ('progressing' as const)
            : getRestartOutcome(
                deployments.find(deployment => deployment.metadata.name === name),
                run.restartedAt
              ),
      }));
    if (!run.timedOut && outcomes.some(({ outcome }) => outcome === 'progressing')) {
      return;
    }

    clearProgress();
    if (outcomes.length > 0) {
      const report = buildReport(outcomes, run.failed.length > 0);
      (report.kind === 'error' ? notifyError : notifyInfo)(report.message);
    }
    onDone?.();
    setRun(null);
  }, [run, deployments, onDone, clearProgress, notifyError, notifyInfo]);

  /**
   * Restarts the Knative Service's Pods with a Deployment rollout. Does nothing while a restart is
   * running or the Knative Service has no cluster; the result of the rollout is reported through
   * notifications once the Deployments have rolled out.
   *
   * @returns A promise that settles once the restart patches have been answered.
   */
  async function restart() {
    if (run !== null || !cluster) {
      return;
    }

    if (!namespace) {
      notifyError('Restart failed: namespace not found');
      return;
    }

    if (!serviceName) {
      notifyError('Restart failed: KService name not found');
      return;
    }

    if (deployments === null) {
      notifyError(withErrorDetail('Restart failed', listError));
      return;
    }

    const running = deployments.filter(isRunning);
    if (running.length === 0) {
      notifyInfo('No running Pods found for KService');
      return;
    }

    const names = running.map(deployment => deployment.metadata.name);
    const restartedAtNow = new Date().toISOString();
    setRun({ restartedAt: restartedAtNow, names, failed: [], timedOut: false });
    progressSnackbarKeyRef.current = enqueueSnackbar(
      `Restart in progress: rolling out ${names.join(', ')}`,
      { variant: 'info', persist: true }
    );

    const results = await Promise.allSettled(
      running.map(async deployment => deployment.patch(restartPatch(restartedAtNow)))
    );
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected' ? [{ name: names[index], reason: result.reason }] : []
    );
    if (failures.length > 0) {
      notifyError(
        `Failed to restart ${failures
          .map(({ name, reason }) => withErrorDetail(name, reason))
          .join('; ')}`
      );
      setRun(current =>
        current?.restartedAt === restartedAtNow
          ? { ...current, failed: failures.map(({ name }) => name) }
          : current
      );
    }
  }

  return {
    restart,
    restarting: run !== null,
    ready: deployments !== null || listError !== null,
  };
}
