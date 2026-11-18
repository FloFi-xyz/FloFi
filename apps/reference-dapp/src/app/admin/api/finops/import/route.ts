// SPDX-License-Identifier: AGPL-3.0-only
import { handleFinopsImport } from '../../../../../admin/finops/http';

export const POST = (request: Request) => handleFinopsImport(request);
