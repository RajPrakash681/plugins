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

import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import Deployment from '@kinvolk/headlamp-plugin/lib/k8s/deployment';
import type { SnackbarKey } from 'notistack';
import { useSnackbar } from 'notistack';
import React from 'react';
import type { KService } from '../../../../resources/knative';
import { useNotify } from '../../../common/notifications/useNotify';
import { restartKServicePods } from './restartKServicePods';

type KServiceActionId = 'redeploy' | 'restart';

type UseKServiceActionsOptions = {
  onDone?: () => void;
};

/**
 * Reads the Deployments that match a label selector once, without watching.
 *
 * @param query - Cluster, namespace and label selector of the Deployments to read.
 * @returns The matching Deployments as plain Kubernetes objects.
 */
async function listDeploymentsByLabelSelector(query: {
  cluster: string;
  namespace: string;
  labelSelector: string;
}): Promise<Deployment['jsonData'][]> {
  const { cluster, namespace, labelSelector } = query;
  const list = await ApiProxy.clusterRequest(
    `/apis/apps/v1/namespaces/${namespace}/deployments`,
    { cluster },
    { labelSelector }
  );
  return list?.items ?? [];
}

/**
 * Watches the Deployments that match a label selector through `Deployment.apiList`. Each
 * Deployment is tagged with `cluster`, so that its `patch` goes to the right cluster.
 *
 * @param query - Cluster, namespace and label selector of the Deployments to watch.
 * @param onUpdate - Called with every matching Deployment after each change.
 * @param onError - Called when listing or watching fails.
 * @returns A function that stops the watch, which also works before the watch has started.
 */
function watchDeploymentsByLabelSelector(
  query: { cluster: string; namespace: string; labelSelector: string },
  onUpdate: (deployments: Deployment[]) => void,
  onError: (err: unknown) => void
): () => void {
  const { cluster, namespace, labelSelector } = query;
  let cancel: (() => void) | null = null;
  let stopped = false;

  const request = Deployment.apiList(
    (items: Deployment[]) => {
      onUpdate(
        items.map(item => {
          item.cluster = cluster;
          return item;
        })
      );
    },
    onError,
    {
      namespace,
      cluster,
      queryParams: { labelSelector },
    }
  );

  request()
    .then(cancelRequest => {
      if (stopped) {
        cancelRequest();
      } else {
        cancel = cancelRequest;
      }
    })
    .catch(onError);

  return () => {
    stopped = true;
    if (cancel) {
      cancel();
    }
  };
}

/**
 * Provides the Redeploy and Restart actions of a Knative Service.
 *
 * @param kservice - The Knative Service to act on; the actions do nothing until it has loaded.
 * @param options - `onDone`, called after a successful redeploy, or once a restart has reported its
 * result for the running Deployments.
 * @returns `acting`, the action in progress or null, and the `handleRedeploy` and `handleRestart`
 * handlers.
 */
export function useKServiceActions(
  kservice: KService | null | undefined,
  options?: UseKServiceActionsOptions
) {
  const [acting, setActing] = React.useState<KServiceActionId | null>(null);
  const { notifyError, notifyInfo } = useNotify();
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const onDone = options?.onDone;

  /**
   * Restart progress snackbar.
   *
   * We intentionally use "dismiss + show" updates (close then enqueue) instead of trying
   * to "update" a snackbar by key, following the upstream Headlamp pattern.
   */
  const progressSnackbarKeyRef = React.useRef<SnackbarKey | null>(null);

  function setProgress(message: string) {
    if (progressSnackbarKeyRef.current !== null) {
      closeSnackbar(progressSnackbarKeyRef.current);
    }

    progressSnackbarKeyRef.current = enqueueSnackbar(message, {
      variant: 'info',
      persist: true,
    });
  }

  function clearProgress() {
    if (progressSnackbarKeyRef.current !== null) {
      closeSnackbar(progressSnackbarKeyRef.current);
      progressSnackbarKeyRef.current = null;
    }
  }

  React.useEffect(() => () => clearProgress(), [closeSnackbar]);

  async function handleRedeploy() {
    if (acting !== null) {
      return;
    }

    if (!kservice || !kservice.cluster) {
      return;
    }

    setActing('redeploy');
    try {
      const now = new Date().toISOString();
      await kservice.patch({
        spec: {
          template: {
            metadata: {
              name: null as any,
              annotations: {
                'knative.headlamp.dev/redeployAt': now,
              },
            },
          },
        },
      });
      notifyInfo('Redeploy requested');
      if (onDone) {
        onDone();
      }
    } catch (err: unknown) {
      const error = err as { message?: string } | undefined;
      const detail = error?.message?.trim();
      notifyError(detail ? `Redeploy failed: ${detail}` : 'Redeploy failed');
    } finally {
      setActing(null);
    }
  }

  /**
   * Restarts the Knative Service's Pods with a Deployment rollout and reports the result. Does
   * nothing while another action is running or the Knative Service has not loaded.
   *
   * @returns A promise that settles once the result has been reported.
   */
  async function handleRestart() {
    if (acting !== null) {
      return;
    }

    if (!kservice || !kservice.cluster) {
      return;
    }

    const namespace = kservice.metadata.namespace;
    const serviceName = kservice.metadata.name;

    setActing('restart');
    try {
      if (!namespace) {
        notifyError('Restart failed: namespace not found');
        return;
      }

      if (!serviceName) {
        notifyError('Restart failed: KService name not found');
        return;
      }

      await restartKServicePods({
        clearProgress,
        cluster: kservice.cluster,
        listDeploymentsByLabelSelector,
        namespace,
        notifyError,
        notifyInfo,
        onDone,
        serviceName,
        setProgress,
        watchDeploymentsByLabelSelector,
      });
    } catch (err: unknown) {
      const error = err as { message?: string } | undefined;
      const detail = error?.message?.trim();
      notifyError(detail ? `Restart failed: ${detail}` : 'Restart failed');
    } finally {
      setActing(null);
    }
  }

  return {
    acting,
    handleRedeploy,
    handleRestart,
  };
}
