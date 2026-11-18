// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../../../i18n/locale';
import { finopsCopy } from '../../../components/admin/finops-copy';

export default function FinopsLoading() {
  const { copy } = finopsCopy(useLocale().language);
  return <p className="admin-main" role="status">{copy("Loading financial report…")}</p>;
}
