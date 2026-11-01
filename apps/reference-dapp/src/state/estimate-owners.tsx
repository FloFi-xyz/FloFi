// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P0-07): the connected EVM and Solana addresses a read-only quote may use as its untrusted quote
 * subject, provided by the app shell (which holds the wallet stores) to the Simulate canvas without that canvas importing the stores and
 * their server actions. Display only: an address here grants nothing. No provider: no owner, the estimate is quoted without one.
 */
import { createContext, useContext } from 'react';

export type EstimateOwners = { readonly evm: string | null; readonly solana: string | null };
export const EstimateOwnersContext = createContext<EstimateOwners>({ evm: null, solana: null });
export const useEstimateOwners = (): EstimateOwners => useContext(EstimateOwnersContext);
