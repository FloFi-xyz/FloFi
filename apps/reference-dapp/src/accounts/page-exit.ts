// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): "this page is already leaving on purpose". Disconnect (src/accounts/disconnect.ts) ends the FloFi session
 * with a Server Action and then finishes its own steps (Privy logout) before it replaces the page with sign-in. The action's re-render meets a
 * Flight gate that no longer sees a session, whose full-page hand-off to /board (src/components/flight/flight-transition.tsx) must not
 * cut those steps short or win over sign-in. Presentation only: it grants, revokes or skips no check; the server gate decides as before.
 */
let exiting = false;
/** Marks this document as leaving through a flow that navigates on its own. Never cleared: the document is replaced. */
export function beginPageExit(): void { exiting = true; }
export const pageExitInProgress = (): boolean => exiting;
