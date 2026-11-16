// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-P1-UI-OVERFLOW-AND-ATTRIBUTION-001: synthetic display strings for the Assistant Review overflow acceptance (valid shapes, no real
 * person's wallet): a Solana and an EVM address, a long route and a long technical value. Shared by the browser harness and its spec.
 */
export const CHAT_REVIEW_FIXTURE = Object.freeze({
  solana: 'Fx7DkP2qWv9LbS3mRt8NcZ4yHj6Ue5Ag1oKiBhXwQrTs',
  evm: '0x9F3c2B7aD41e6085Cb4D9a0e37F2c51B8d6A0E4f',
  route: `USDC → SOL via Jupiter route ${'Rt7LbS3mRt8NcZ4yHj6Ue5Ag'.repeat(4)}`,
  technical: `quote-binding:${'a1B2c3D4e5F6'.repeat(10)}`,
});
