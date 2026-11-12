// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlow, Background, MarkerType, Panel, getNodesBounds, getViewportForBounds, useReactFlow, useStore, useStoreApi, useUpdateNodeInternals, type Node, type NodeProps, type ReactFlowState } from '@xyflow/react';
import { isLendingComposition } from '@defi-workflow-engine/workflow-contracts';
import { composerActions, composerConnections, composerSummary } from '../domain/composer-presentation';
import { shownCanvasPositions } from '../domain/canvas-layout';
import { useWorkflow } from '../state/workflow-store';
import { useEstimateOwners } from '../state/estimate-owners';
import { ComposerCard, type ComposerCardData } from './composer-card';
import { DarkSpotlight } from './dark-spotlight';
import { CANVAS_GESTURES, CanvasNavigator } from './canvas-navigator';
import { CANVAS_EDGE_LABEL, edgeAccessibleLabel, edgeLabel } from './canvas-edge-style';

const FIT_PADDING = { top: '32px', bottom: '136px', left: '32px', right: '32px' } as const;
/** BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the fitted workflow always ends above the bottom controls, whatever their measured height (a step
 * note can add lines), so no control or note ever sits over a card at fit. */
const fitPadding = (controlsHeight: number) => ({ ...FIT_PADDING, bottom: `${Math.max(136, Math.ceil(controlsHeight) + 16)}px` as `${number}px` });
function InspectionCard({ data }: NodeProps) { return <ComposerCard data={data as ComposerCardData}/>; }
const nodeTypes = { workflow: InspectionCard };

/** Viewport state is presentation only. Nodes, order, links and parameters come from the shared draft. */
function InspectionViewport({ onState, padding }: { onState: (value: 'pending' | 'fitted') => void; padding: ReturnType<typeof fitPadding> }) {
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
      const viewport = getViewportForBounds(getNodesBounds(nodes), state.width, state.height, 0.35, 1.1, padding);
      void setViewport(viewport, { duration: 0 });
    }
    onState('fitted');
  }, [ready, signature, setViewport, onState, store, updateNodeInternals, padding]);
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
    id: node.nodeId, type: 'workflow', ariaLabel: tr('Step {0}: {1}', index + 1, tr(composerSummary(workflow, node, context).action)),
    position: positions[node.nodeId]!,
    data: { composer: true, inspection: true, step: index + 1, selected: false, vertical: lending,
      summary: composerSummary(workflow, node, context),
      // P0 workflow execution: Execute shows the same per-step quote as Create and Simulate (keyed by the step alone, so it is the cached answer,
      // not a new one), marked as an estimate or as expired — never a blank '—' for a value FloFi already knows. Signing never uses it.
      ...['asset.swap.exact-input', 'asset.bridge'].includes(node.actionType) ? { estimateWorkflow: workflow, estimateNodeId: node.nodeId,
        estimateOwner: node.chainId.startsWith('solana:') ? solanaAccount : evmAccount, estimateEvmOwner: evmAccount, estimateSolanaOwner: solanaAccount } : {} },
  })), [workflow, context, positions, incomplete, lending, evmAccount, solanaAccount, tr]);
  // BUILD-FLOFI-BUILDER-UX-002: the same link labels as the Build Canvas, so a link reads the same between Create and Simulate.
  const edges = useMemo(() => incomplete ? [] : composerConnections(workflow).map(({ id, source, target, label }) => ({
    id, source, target, type: 'default', animated: false, label: tr(edgeLabel(label)), ariaLabel: tr(edgeAccessibleLabel(label)),
    markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: 'var(--edge-line)' },
    style: { stroke: 'var(--edge-line)', strokeWidth: 1.5 }, ...CANVAS_EDGE_LABEL,
  })), [workflow, incomplete, tr]);
  const [viewport, setViewport] = useState<'pending' | 'fitted'>('pending');
  const controls = useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  useLayoutEffect(() => {
    const element = controls.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setControlsHeight(height => Math.abs(height - element.offsetHeight) < 1 ? height : element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const padding = useMemo(() => fitPadding(controlsHeight), [controlsHeight]);
  return <section className={`canvas simulate-canvas simulation-workflow-canvas panel ${lending ? 'simulation-lending-canvas' : ''}`} aria-label={tr(stage === 'execute' ? 'Execution plan' : 'Workflow simulation')}>
    <div className="canvas-head"><div><h2>{workflowName === 'Your Workflow' ? tr('Your Workflow') : workflowName}</h2></div><span className="revision">{tr(actions.length === 1 ? '1 step' : '{0} steps', actions.length)}</span></div>
    <div className="flow-surface simulate-flow-surface" role="region" aria-label={tr(stage === 'execute' ? 'Execution workflow graph' : 'Simulation workflow graph')} data-viewport={viewport}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} minZoom={0.35} maxZoom={1.4}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} nodesFocusable={false} edgesFocusable={false}
        deleteKeyCode={null} fitViewOptions={{ padding }} {...CANVAS_GESTURES}>
        <InspectionViewport onState={setViewport} padding={padding}/>
        <Background gap={18} size={1} color="var(--grid)"/>
        <DarkSpotlight/>
        {/* BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: one bottom control group laid out by the flow, never by offsets against each other: the
            Canvas navigator on its own centred line, then Back to the Canvas immediately left of the primary action, bottom-right. A step note
            takes its own line above the buttons, so no width, locale or note can make the navigator and the actions overlap. */}
        <Panel ref={controls} position="bottom-right" className="simulation-canvas-controls">
          <CanvasNavigator embedded fitViewOptions={{ padding }} compactBelow={1024}/>
          {primaryAction && <div className="canvas-primary-action simulation-canvas-actions">{primaryAction}</div>}
        </Panel>
      </ReactFlow>
      {nodes.length === 0 && <div className="simulation-workflow-empty"><strong>{tr(incomplete ? 'Check your workflow' : 'Add an action to your workflow')}</strong><p>{tr(incomplete ? stage === 'execute' ? 'Complete its configuration on the Canvas before executing.' : 'Complete its configuration on the Canvas before simulating.' : stage === 'execute' ? 'Create a workflow in the Editor first.' : 'Create your strategy on the Canvas, then return here to simulate it.')}</p></div>}
    </div>
    <div className="canvas-foot"><span>{tr(stage === 'execute' ? 'Execution plan' : 'Workflow preview')}</span><span>{tr("Configured on the Canvas")}</span></div>
  </section>;
}
