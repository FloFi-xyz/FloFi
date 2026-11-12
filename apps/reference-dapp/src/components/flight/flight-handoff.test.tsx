// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): the gate's hand-off is ONE full navigation (location.replace, at once, no timer) to its fixed path, and it
 * never races a page that is already leaving on purpose (Disconnect ending the session on its way to sign-in).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HookHarness } from '../../test-utils/hook-harness';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../../test-utils/hook-harness')).hookMocks }));
import { beginPageExit } from '../../accounts/page-exit';
import { FlightHandoff } from './flight-transition';

let host: HookHarness;
const replace = vi.fn(), assign = vi.fn(), setTimeoutSpy = vi.fn();
beforeEach(() => {
  host = new HookHarness(); replace.mockClear(); assign.mockClear(); setTimeoutSpy.mockClear();
  vi.stubGlobal('window', { location: { replace, assign }, setTimeout: setTimeoutSpy });
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('Flight hand-off', () => {
  it('replaces the page with its destination at once, as a full navigation', () => {
    const html = host.render(() => renderToStaticMarkup(<FlightHandoff to="/board" message="Taking you to Flight FloFi…"/>));
    expect(html).toContain('Taking you to Flight FloFi…');
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/board');
    expect(assign).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    // Re-rendered (a later Server Action re-render): no second navigation.
    host.render(() => renderToStaticMarkup(<FlightHandoff to="/board" message="Taking you to Flight FloFi…"/>));
    expect(replace).toHaveBeenCalledTimes(1);
  });
  it('leaves a page that is already leaving for sign-in to finish (Disconnect)', () => {
    beginPageExit();
    const html = host.render(() => renderToStaticMarkup(<FlightHandoff to="/board" message="Taking you to Flight FloFi…"/>));
    expect(replace).not.toHaveBeenCalled();
    expect(html).not.toContain('Taking you to Flight FloFi…');
    expect(html).toContain('role="status"');
  });
});
