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

import { ActionButton } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import React from 'react';
import type { KService } from '../../../../resources/knative';
import { useKServiceRestart } from '../hooks/useKServiceRestart';

type KServiceRestartButtonProps = {
  /** The Knative Service to restart. */
  kservice: KService;
  /** Set to `menu` to show the button as an item of a menu. */
  buttonStyle?: React.ComponentProps<typeof ActionButton>['buttonStyle'];
  /** True while another action of the Knative Service is running. */
  disabled: boolean;
  /** Called with true when the restart starts and with false when it ends. */
  onRestartingChange: (restarting: boolean) => void;
  /** Called once the restart has reported its result. */
  onDone?: () => void;
};

/**
 * Shows the Restart button of a Knative Service. It watches the Service's Deployments for as long
 * as it is mounted, so render it only for users who are allowed to restart the Service.
 *
 * @param props - The Knative Service, and how the button works with the other actions.
 * @returns The Restart button.
 */
export function KServiceRestartButton({
  kservice,
  buttonStyle,
  disabled,
  onRestartingChange,
  onDone,
}: KServiceRestartButtonProps) {
  const { restart, restarting, ready } = useKServiceRestart(kservice, { onDone });

  React.useEffect(() => {
    onRestartingChange(restarting);
    return () => onRestartingChange(false);
  }, [restarting, onRestartingChange]);

  return (
    <ActionButton
      description="Restart"
      icon="mdi:restart"
      buttonStyle={buttonStyle}
      onClick={restart}
      iconButtonProps={{ disabled: disabled || restarting || !ready }}
    />
  );
}
