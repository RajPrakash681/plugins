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
import type { DeploymentState } from '../restartRollout';

/** A Deployment as the live list hands it to the hook, with a mock for its `patch`. */
export type MockDeployment = DeploymentState & {
  /** Mock of the Deployment's `patch`; it resolves unless a test says otherwise. */
  patch: ReturnType<typeof vi.fn>;
};

/** An API error with an HTTP status, like the ones Headlamp's API calls reject with. */
export class ApiStatusError extends Error {
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

export const ANNOTATION = 'kubectl.kubernetes.io/restartedAt';
export const NOW = '2026-01-01T00:00:00.000Z';
export const AHEAD = '2026-01-01T00:10:00.000Z';
export const FIRST = 'service-a-00002-deployment';
export const SECOND = 'service-a-00003-deployment';
export const DEADLINE_EXCEEDED = [{ type: 'Progressing', reason: 'ProgressDeadlineExceeded' }];

/**
 * Builds a Deployment whose rollout is complete unless `status` says otherwise.
 *
 * @param name - Name of the Deployment.
 * @param replicas - Desired number of Pods, also used for every status count.
 * @param status - Status fields to override.
 * @param options - Generation and restart annotation time.
 * @returns The Deployment, with a `patch` mock that resolves.
 */
export function makeDeployment(
  name: string,
  replicas: number,
  status: NonNullable<DeploymentState['status']> = {},
  options: { generation?: number; restartedAt?: string } = {}
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
    metadata: { name, generation },
    spec: {
      replicas,
      template: {
        metadata: { annotations: options.restartedAt ? { [ANNOTATION]: options.restartedAt } : {} },
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
 * @returns The restarted Deployment, with a `patch` mock that resolves.
 */
export function restarted(
  name: string,
  replicas: number,
  status: NonNullable<DeploymentState['status']> = {}
): MockDeployment {
  return makeDeployment(name, replicas, status, { generation: 2, restartedAt: NOW });
}
