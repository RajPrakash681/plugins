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
import type { KubeDeployment } from '@kinvolk/headlamp-plugin/lib/k8s/deployment';
import { useRestartRollout } from '../hooks/useRestartRollout';
import { useDeploymentList } from './useDeploymentList';

type KServiceRestartTrackerProps = {
  /** Cluster the Knative Service runs in. */
  cluster: string;
  /** Namespace of the Knative Service. */
  namespace: string;
  /** Name of the Knative Service to restart. */
  serviceName: string;
  /**
   * Called once the result has been shown.
   *
   * @param callOnDone - Whether the restart reached the running Deployments.
   */
  onFinished: (callOnDone: boolean) => void;
};

/**
 * Reads the Deployments that match a label selector once, without watching.
 *
 * @param cluster - Cluster to read from.
 * @param namespace - Namespace to read from.
 * @param labelSelector - Label selector of the Deployments to read.
 * @returns The matching Deployments as plain Kubernetes objects.
 */
async function readDeployments(
  cluster: string,
  namespace: string,
  labelSelector: string
): Promise<KubeDeployment[]> {
  const list = await ApiProxy.clusterRequest(
    `/apis/apps/v1/namespaces/${namespace}/deployments`,
    { cluster },
    { labelSelector }
  );
  return list?.items ?? [];
}

/**
 * Restarts a Knative Service's Pods for as long as it is mounted. It watches the Service's
 * Deployments and hands them to {@link useRestartRollout}, which patches them, follows their
 * rollouts and shows the result. Headlamp's `useList` cannot be switched off, so the watch lasts
 * exactly as long as this component: mount it to start a restart and unmount it once it is over.
 *
 * @param props - The Knative Service to restart, and what to do once the result has been shown.
 * @returns Nothing; the component renders no UI.
 */
export function KServiceRestartTracker({
  cluster,
  namespace,
  serviceName,
  onFinished,
}: KServiceRestartTrackerProps) {
  const labelSelector = `serving.knative.dev/service=${serviceName}`;
  const { items, error, isSuccess, isFetching } = useDeploymentList(
    cluster,
    namespace,
    labelSelector
  );

  useRestartRollout({
    serviceKey: `${cluster}/${namespace}/${serviceName}`,
    deployments: items,
    listed: isSuccess && !isFetching,
    listError: error,
    readDeployments: () => readDeployments(cluster, namespace, labelSelector),
    onFinished,
  });

  return null;
}
