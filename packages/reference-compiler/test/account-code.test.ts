import { describe, expect, it } from 'vitest';
import { ownerAccountCode, VERIFIED_EIP7702_DELEGATES } from '../src/account-code.js';
import { DELEGATION_FRAMEWORK_V1_3 } from '../src/erc7710.js';

describe('BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 owner account classification', () => {
  const metaMask = DELEGATION_FRAMEWORK_V1_3.eip7702StatelessDeleGator;
  it('treats empty code as a standard account (EOA)', () => {
    expect(ownerAccountCode('0x')).toEqual({ kind: 'EOA' });
  });
  it('recognizes a MetaMask Smart Account (EIP-7702 delegation to the reviewed DeleGator) as a verified delegated EOA', () => {
    expect(VERIFIED_EIP7702_DELEGATES).toContain(metaMask);
    expect(ownerAccountCode('0xef0100' + metaMask.slice(2))).toEqual({ kind: 'EIP7702', delegate: metaMask, verified: true });
    // Nodes may return the designator in upper case.
    expect(ownerAccountCode(('0xef0100' + metaMask.slice(2)).toUpperCase().replace('0XEF', '0xef'))).toEqual({ kind: 'EIP7702', delegate: metaMask, verified: true });
  });
  it('flags a delegation to any other implementation as unverified (a sweeper delegate is never trusted)', () => {
    expect(ownerAccountCode('0xef0100' + '1'.repeat(40))).toEqual({ kind: 'EIP7702', delegate: '0x' + '1'.repeat(40), verified: false });
  });
  it('fails closed on contract code, malformed designators and non-strings', () => {
    for (const code of ['0x6080604052', '0xef0100' + '1'.repeat(38), '0xef0100' + '1'.repeat(42), '0xef0100' + '0'.repeat(40), '0x0', '', null, undefined, 7])
      expect(ownerAccountCode(code)).toEqual({ kind: 'CONTRACT' });
  });
});
