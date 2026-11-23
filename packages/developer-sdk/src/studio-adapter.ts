// SPDX-License-Identifier: Apache-2.0
/** SDK v1 for offline certification of read-only adapter code. The runner supplies the observations. */
export type StudioAdapterInput = {
  readonly mode: 'verify' | 'test';
  readonly chainRef: string;
  readonly observations: Readonly<Record<string, string | boolean>>;
};

export type StudioAdapterResult =
  | { readonly ok: true; readonly chainRef: string; readonly facts: Readonly<Record<string, string | boolean>> }
  | { readonly ok: false; readonly code: string };

export type StudioAdapterV1 = (input: StudioAdapterInput) => StudioAdapterResult | Promise<StudioAdapterResult>;
