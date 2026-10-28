// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';
/** Informational only. The execution service, rather than a blanket UI lock, fences financial requests. */
export function WalletPendingNotice() {
  const { t } = useLocale();
  return <p role="status">{t('Open your wallet to approve or reject. You can navigate and check status while waiting.')}</p>;
}
