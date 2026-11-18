// SPDX-License-Identifier: AGPL-3.0-only
import { handleFinopsExport } from '../../../../../admin/finops/http';

export const POST = (request: Request) => handleFinopsExport(request);
