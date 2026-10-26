// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLayoutEffect } from 'react';
import { useWorkflow } from '../state/workflow-store';

/** Read-only loopback test probe. Mounted only under the server's engineering guard. */
export function EngineeringProbe() {
  const { state } = useWorkflow();
  // useLayoutEffect (not useEffect): empty-canvas /app becomes interactive before a passive
  // effect would run, and readWorkflowIr must already see the canonical IR.
  useLayoutEffect(() => {
    const target = window as unknown as { __flofiEngineeringWorkflow?: string };
    target.__flofiEngineeringWorkflow = JSON.stringify(state.workflow);
    return () => { delete target.__flofiEngineeringWorkflow; };
  }, [state.workflow]);
  return null;
}
