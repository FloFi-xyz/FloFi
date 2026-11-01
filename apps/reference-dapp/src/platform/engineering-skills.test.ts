// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the multichain engineering skills registry (`skills/`, `scripts/skill_registry.py`) is engineering knowledge
 * for the existing specialists. Every capability a skill names must be one FloFi's own execution capability registry already holds (skills never
 * invent support), the Capability API keeps discovering those networks, and no runtime code imports, reads or executes a skill.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { executionCapabilityRegistry } from '@defi-workflow-engine/action-registry';
import { networkCapabilityProfiles } from '../domain/intelligence/capability-api';
import { networkScope } from '../server/network-scope';
import { networkIdentity } from '../domain/network-registry';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
type Skill = { id: string; authority: string; capabilities: { actionType: string; adapterId: string; chainId: string }[] };
const registry = JSON.parse(readFileSync(join(ROOT, 'skills/registry.json'), 'utf8')) as { skills: string[] };
const skills = registry.skills.map(id => JSON.parse(readFileSync(join(ROOT, 'skills', id, 'skill.json'), 'utf8')) as Skill);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === '.next') return [];
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.|\.spec\./.test(name) ? [path] : [];
  });
}

describe('BUILD-FLOFI-EXECUTION-PERFORMANCE-001 engineering skills and the capability registry', () => {
  it('every capability a skill names is registered in FloFi\'s execution capability registry', () => {
    expect(skills.length).toBeGreaterThanOrEqual(17);
    for (const skill of skills) {
      expect(skill.authority).toBe('ENGINEERING_REFERENCE_ONLY');
      // A MOCK or LOCAL_FORK row is not enough: the skill must describe a path the public product registers for MAINNET execution. The
      // registry's evidenceMaturity for that row is untouched here: a skill never claims execution evidence.
      for (const c of skill.capabilities)
        expect(executionCapabilityRegistry.some(row => row.actionType === c.actionType && row.adapterId === c.adapterId && row.chainId === c.chainId
          && row.environment === 'MAINNET' && row.capabilities.EXECUTE), `${skill.id}: ${c.actionType} ${c.adapterId} ${c.chainId}`).toBe(true);
    }
  });
  it('the networks those capabilities run on stay discoverable through the existing Capability API (no second registry)', () => {
    const profiles = networkCapabilityProfiles(networkScope({}));
    // Ethereum, Base, Arbitrum One and Solana: the public product's mainnets a skill names must each have a Capability API profile with actions.
    for (const chain of ['eip155:1', 'eip155:8453', 'eip155:42161', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']) {
      expect(skills.some(s => s.capabilities.some(c => c.chainId === chain)), chain).toBe(true);
      const key = networkIdentity(chain)?.key, profile = profiles.find(p => p.key === key);
      expect(profile?.actions.length, chain).toBeGreaterThan(0);
    }
  });
  it('no runtime source imports, reads or executes the skills registry', () => {
    const runtime = ['apps/reference-dapp/src', 'apps/reference-dapp/backend', 'packages'].flatMap(dir => files(join(ROOT, dir)));
    expect(runtime.length).toBeGreaterThan(100);
    const offenders = runtime.filter(path => /skills\/(registry\.json|networks\/|protocols\/|operations\/)|skill_registry/.test(readFileSync(path, 'utf8')))
      .map(path => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });
});
