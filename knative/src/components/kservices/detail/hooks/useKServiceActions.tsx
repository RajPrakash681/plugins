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

import React from 'react';
import type { KService } from '../../../../resources/knative';
import { withErrorDetail } from '../../../../utils/error';
import { useNotify } from '../../../common/notifications/useNotify';

type UseKServiceActionsOptions = {
  onDone?: () => void;
};

/**
 * Provides the Redeploy action of a Knative Service, and keeps track of whether an action is
 * running so that the Redeploy and Restart buttons can disable each other. The Restart itself lives
 * in `KServiceRestartButton`, which reports whether it is running through `setRestarting`.
 *
 * @param kservice - The Knative Service to act on.
 * @param options - `onDone`, called after a successful redeploy.
 * @returns `busy`, true while the Redeploy or the Restart is running; the `handleRedeploy` handler;
 * and `setRestarting`, which the Restart button calls as its restart starts and ends.
 */
export function useKServiceActions(kservice: KService, options?: UseKServiceActionsOptions) {
  const [redeploying, setRedeploying] = React.useState(false);
  const [restarting, setRestarting] = React.useState(false);
  const { notifyError, notifyInfo } = useNotify();
  const busy = redeploying || restarting;

  async function handleRedeploy() {
    if (busy || !kservice.cluster) {
      return;
    }

    setRedeploying(true);
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
      options?.onDone?.();
    } catch (err: unknown) {
      notifyError(withErrorDetail('Redeploy failed', err));
    } finally {
      setRedeploying(false);
    }
  }

  return {
    busy,
    handleRedeploy,
    setRestarting,
  };
}
