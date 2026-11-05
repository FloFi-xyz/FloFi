// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001: a step's own action declaration.
 *
 * Ordering dependencies (`dependencies` without an output reference: the link the Canvas draws between two sequential steps, created by
 * auto-connect or by hand) are workflow structure, not part of the action a step declares. The canonical decoders compare a node with the
 * node its fields would create, which has no dependencies, so the authoring and display readers decode the step with its pure ordering links
 * set aside. A step that consumes another step's output (an OUTPUT_REFERENCE input, a bound composition) is returned unchanged: its
 * dependencies are part of its declaration. Pure; never changes the workflow itself.
 */
export function ownDeclaration<T>(node: T): T {
  const value = node as unknown as { readonly dependencies?: readonly string[]; readonly inputs?: readonly { readonly kind: string }[] };
  if (!value || !Array.isArray(value.dependencies) || !value.dependencies.length || value.inputs?.some(input => input.kind === 'OUTPUT_REFERENCE')) return node;
  return { ...(node as object), dependencies: [] } as T;
}
