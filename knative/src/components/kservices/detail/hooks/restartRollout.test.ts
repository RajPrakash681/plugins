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

import {
  AHEAD,
  ANNOTATION,
  DEADLINE_EXCEEDED,
  FIRST,
  makeDeployment,
  NOW,
  restarted,
  SECOND,
} from './__tests__/restartFixtures';
import {
  buildReport,
  getRestartOutcome,
  getRolloutState,
  isRunning,
  restartPatch,
} from './restartRollout';

describe('isRunning', () => {
  it('needs a name and at least one desired Pod', () => {
    expect(isRunning(makeDeployment(FIRST, 1))).toBe(true);
    expect(isRunning(makeDeployment(FIRST, 0))).toBe(false);
    expect(isRunning({ metadata: {}, spec: { replicas: 1 } })).toBe(false);
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

describe('restartPatch', () => {
  it('sets the restart annotation on the Pod template', () => {
    expect(restartPatch(NOW)).toEqual({
      spec: { template: { metadata: { annotations: { [ANNOTATION]: NOW } } } },
    });
  });
});

describe('getRestartOutcome', () => {
  it('follows the rollout once the Pod template carries the restart', () => {
    expect(getRestartOutcome(restarted(FIRST, 2), NOW)).toBe('complete');
    expect(getRestartOutcome(restarted(FIRST, 2, { updatedReplicas: 1 }), NOW)).toBe('progressing');
    expect(getRestartOutcome(restarted(FIRST, 1, { conditions: DEADLINE_EXCEEDED }), NOW)).toBe(
      'failed'
    );
  });

  it('keeps waiting while the Deployment shows the state from before the patch', () => {
    expect(getRestartOutcome(makeDeployment(FIRST, 1), NOW)).toBe('progressing');
    expect(
      getRestartOutcome(makeDeployment(FIRST, 1, {}, { restartedAt: '2025-12-31' }), NOW)
    ).toBe('progressing');
  });

  it('counts a restart that someone else started later', () => {
    expect(getRestartOutcome(makeDeployment(FIRST, 1, {}, { restartedAt: AHEAD }), NOW)).toBe(
      'complete'
    );
  });

  it('reports a Deployment that is gone', () => {
    expect(getRestartOutcome(undefined, NOW)).toBe('removed');
  });
});

describe('buildReport', () => {
  it('reports success when every rollout completed', () => {
    expect(buildReport([{ name: FIRST, outcome: 'complete' }], false)).toEqual({
      kind: 'info',
      message: 'Restart completed successfully',
    });
  });

  it('names the Deployments it restarted when another patch failed', () => {
    expect(buildReport([{ name: FIRST, outcome: 'complete' }], true)).toEqual({
      kind: 'info',
      message: `Restarted ${FIRST}`,
    });
  });

  it('lists every problem in one error', () => {
    expect(
      buildReport(
        [
          { name: FIRST, outcome: 'failed' },
          { name: SECOND, outcome: 'removed' },
          { name: 'service-a-00004-deployment', outcome: 'progressing' },
          { name: 'service-a-00005-deployment', outcome: 'complete' },
        ],
        false
      )
    ).toEqual({
      kind: 'error',
      message:
        `Restart did not complete: ${FIRST} exceeded its progress deadline; ` +
        `${SECOND} was removed before its rollout finished; ` +
        'service-a-00004-deployment did not finish rolling out in time',
    });
  });
});
