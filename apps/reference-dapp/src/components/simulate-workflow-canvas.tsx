// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlow, Background, MarkerType, getNodesBounds, getViewportForBounds, useReactFlow, useStore, useStoreApi, useUpdateNodeInternals, type Node, type NodeProps, type ReactFlowState } from '@xyflow/react';
import { isLendingComposition } from '@defi-workflow-engine/workflow-contracts';
import { composerActions, composerConnections, composerSummary } from '../domain/composer-presentation';
import { shownCanvasPositions } from '../domain/canvas-layout';
import { useWorkflow } from '../state/workflow-store';
import { useEstimateOwners } from '../state/estimate-owners';
import { ComposerCard, type ComposerCardData } from './composer-card';
import { DarkSpotlight } from './dark-spotlight';
import { CANVAS_GESTURES, CanvasNavigator } from './canvas-navigator';

const FIT_PADDING = { top: '32px', bottom: '136px', left: '32px', right: '32px' } as const;
function InspectionCard({ data }: NodeProps) { return <ComposerCard data={data as ComposerCardData}/>; }
const nodeTypes = { workflow: InspectionCard };

/** Viewport state is presentation only. Nodes, order, links and parameters come from the shared draft. */
function InspectionViewport({ onState }: { onState: (value: 'pending' | 'fitted') => void }) {
  const store = useStoreApi();
  const updateNodeInternals = useUpdateNodeInternals();
  const requestedMeasurement = useRef<string | null>(null);
  const ready = useStore((state: ReactFlowState) => state.panZoom !== null);
  const signature = useStore((state: ReactFlowState) => `${state.width}:${state.height}:` + [...state.nodeLookup.values()]
    .map(node => `${node.id}:${node.position.x}:${node.position.y}:${node.measured.width}:${node.measured.height}`).join('|'));
  const { setViewport } = useReactFlow();
  useLayoutEffect(() => {
    const state = store.getState();
    if (!ready || state.width <= 0 || state.height <= 0) { onState('pending'); return; }
    const nodes = [...state.nodeLookup.values()];
    const missing = nodes.filter(node => !node.measured.width || !node.measured.height);
    if (missing.length) {
      onState('pending');
      if (requestedMeasurement.current !== signature) {
        requestedMeasurement.current = signature;
        updateNodeInternals(missing.map(node => node.id));
      }
      return;
    }
    requestedMeasurement.current = null;
    if (nodes.length) {
      // Set the viewport directly: controlled read-only nodes have no authoring change callback.
      const viewport = getViewportForBounds(getNodesBounds(nodes), state.width, state.height, 0.35, 1.1, FIT_PADDING);
      void setViewport(viewport, { duration: 0 });
    }
    onState('fitted');
  }, [ready, signature, setViewport, onState, store, updateNodeInternals]);
  return null;
}

export function SimulateWorkflowCanvas({ workflowName, primaryAction, stage = 'simulate' }: { workflowName: string; primaryAction?: ReactNode; stage?: 'simulate' | 'execute' }) {
  const { t: tr } = useLocale();
  const { state, context, canvasLayout, reviewError, actionSetup } = useWorkflow();
  const workflow = state.workflow;
  const actions = composerActions(workflow);
  const incomplete = Boolean(reviewError);
  const lending = isLendingComposition(workflow);
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P0-07): swap and bridge steps show the same shared live quote as Build (display only).
  const { evm: evmAccount, solana: solanaAccount } = useEstimateOwners();
  // BUILD-FLOFI-BUILDER-UX-002: the same flow placement as the Build Canvas, so a step keeps its place between Create and Simulate.
  const positions = useMemo(() => {
    const setup = actionSetup ? canvasLayout?.[actionSetup.id] : undefined;
    return shownCanvasPositions(composerActions(workflow), canvasLayout ?? {}, { lending: isLendingComposition(workflow), occupied: setup ? [setup] : [] });
  }, [workflow, canvasLayout, actionSetup]);
  const nodes = useMemo<Node[]>(() => incomplete ? [] : composerActions(workflow).map((node, index) => ({
    id: node.nodeId, type: 'workflow', ariaLabel: `Step ${index + 1}: ${composerSummary(workflow, node, context).action}`,
    position: positions[node.nodeId]!,
    data: { composer: true, inspection: true, step: index + 1, selected: false, vertical: lending,
      summary: composerSummary(workflow, node, context),
      // Simulate only: the Execute plan shows the reviewed amounts, never a newer approximate quote beside them.
      ...stage === 'simulate' && ['asset.swap.exact-input', 'asset.bridge'].includes(node.actionType) ? { estimateWorkflow: workflow, estimateNodeId: node.nodeId,
        estimateOwner: node.chainId.startsWith('solana:') ? solanaAccount : evmAccount, estimateEvmOwner: evmAccount, estimateSolanaOwner: solanaAccount } : {} },
  })), [workflow, context, positions, incomplete, lending, evmAccount, solanaAccount, stage]);
  const edges = useMemo(() => incomplete ? [] : composerConnections(workflow).map(({ id, source, target }) => ({
    id, source, target, type: 'default', animated: false,
    markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: 'var(--edge-line)' },
    style: { stroke: 'var(--edge-line)', strokeWidth: 1.5 },
  })), [workflow, incomplete]);
  const [viewport, setViewport] = useState<'pending' | 'fitted'>('pending');
  return <section className={`canvas simulate-canvas simulation-workflow-canvas panel ${lending ? 'simulation-lending-canvas' : ''}`} aria-label={tr(stage === 'execute' ? 'Execution plan' : 'Workflow simulation')}>
    <div className="canvas-head"><div><h2>{workflowName}</h2></div><span className="revision">{tr(actions.length)} {tr(actions.length === 1 ? 'action' : 'actions')}</span></div>
    <div className="flow-surface simulate-flow-surface" role="region" aria-label={tr(stage === 'execute' ? 'Execution workflow graph' : 'Simulation workflow graph')} data-viewport={viewport}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} minZoom={0.35} maxZoom={1.4}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
        deleteKeyCode={null} fitViewOptions={{ padding: FIT_PADDING }} {...CANVAS_GESTURES}>
        <InspectionViewport onState={setViewport}/>
        <Background gap={18} size={1} color="var(--grid)"/>
        <DarkSpotlight/>
        <CanvasNavigator fitViewOptions={{ padding: FIT_PADDING }} compactBelow={1024}/>
      </ReactFlow>
      {nodes.length === 0 && <div className="simulation-workflow-empty"><strong>{tr(incomplete ? 'Check your workflow' : 'Add an action to your workflow')}</strong><p>{tr(incomplete ? stage === 'execute' ? 'Complete its configuration on the Canvas before executing.' : 'Complete its configuration on the Canvas before simulating.' : stage === 'execute' ? 'Create a workflow in the Editor first.' : 'Create your strategy on the Canvas, then return here to simulate it.')}</p></div>}
      {primaryAction && <div className="canvas-primary-action simulation-canvas-actions">{primaryAction}</div>}
    </div>
    <div className="canvas-foot"><span>{tr(stage === 'execute' ? 'Execution plan' : 'Workflow preview')}</span><span>{tr("Configured on the Canvas")}</span></div>
  </section>;
}
