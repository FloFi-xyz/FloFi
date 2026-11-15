// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Why an opt-in backend subsystem (automations, delegation, workflow runs, Flight email; API or worker) failed to load — or why one of their
 * sweeps failed — as closed fields only.
 *
 * `main.ts` loads those subsystems with dynamic imports and keeps the rest of the process serving when one fails. It used to drop the
 * exception entirely, so a production worker reported only `WORKFLOW_RUN_WORKER_LOAD_FAILED` for two days while the real cause (a module
 * Node's type stripping refuses) stayed invisible. These fields name the cause without ever logging the exception message, which can embed
 * configuration (connection strings, URLs, tokens) or user data:
 *
 *   cause_code    a closed code: the thrown message when it already is one (`USER_FUNDED_SOLANA_RPC_INVALID`), else Node's error code
 *                 (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), else `UNCLASSIFIED_ERROR`
 *   node_error    Node's `ERR_*` code, when there is one
 *   sql_state     a PostgreSQL SQLSTATE (5 characters), when the cause is the database
 *   system_error  a system error code (`ECONNREFUSED`…)
 *   error_type    the error class (`SyntaxError`, `TypeError`…)
 *   module        the repository-relative source file the error points at (`apps/reference-dapp/src/…/x.ts`): only an existing file of this
 *                 repository named by a location V8 printed itself (a stack frame, or the header of a syntax error) or by Node's own `url`
 *                 for the module it failed on — never a location quoted in the message
 * It never throws: whatever the thrown value is, the subsystem is disabled with at least `cause_code`.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LoadFailureFields = { readonly cause_code: string; readonly node_error?: string; readonly sql_state?: string; readonly system_error?: string;
  readonly error_type?: string; readonly module?: string };

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..') + sep;
const CLOSED_CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const NODE_ERROR = /^ERR_[A-Z0-9_]{1,60}$/;
const SQL_STATE = /^[0-9A-Z]{5}$/;
const SYSTEM_ERROR = /^E[A-Z]{2,20}$/;
const ERROR_TYPE = /^[A-Za-z]{1,40}Error$/;
const SOURCE_PATH = /^(?:apps|packages)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+){1,12}\.[cm]?[jt]s$/;
// The header line of a syntax/type-stripping error (`file:///…/x.ts:37`, or the plain path) and a stack frame (`    at … (file:///…:1:2)`).
const HEADER = /^((?:file:\/\/)?\/[^\s'"()]+?\.[cm]?[jt]s):\d+$/;
const FRAME = /^\s+at (?:.*\()?((?:file:\/\/)?\/[^\s'"()]+?\.[cm]?[jt]s):\d+:\d+\)?$/;

const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const read = (error: object, key: string): unknown => { try { return (error as Record<string, unknown>)[key]; } catch { return undefined; } };

/** The lines of `stack` V8 wrote around the message: the syntax-error header before the `<Name>: <message>` line, and the frames after it. */
function locations(stack: string, message: string): string[] {
  const lines = stack.split('\n');
  // The message's own lines (it can span several) are dropped wherever they appear, so nothing quoted in it is ever read as a location.
  const quoted = new Set(message.split('\n').filter(line => line.trim()));
  const header = lines.findIndex(line => /^[A-Za-z]{0,40}Error\b/.test(line));
  return lines.filter((line, index) => !quoted.has(line) && (FRAME.test(line) || (header > 0 && index < header && HEADER.test(line))));
}

function repositoryFile(location: string, root: string): string | undefined {
  let path: string;
  try { path = location.startsWith('file://') ? fileURLToPath(location) : location; } catch { return undefined; }
  if (!path.startsWith(root) || !existsSync(path)) return undefined;
  const local = relative(root, path).split(sep).join('/');
  return SOURCE_PATH.test(local) && !local.split('/').includes('..') && !local.includes('/node_modules/') ? local : undefined;
}

function moduleOf(error: object, message: string, root: string): string | undefined {
  const url = text(read(error, 'url'));
  const candidates = [...url?.startsWith('file://') ? [url] : [], ...locations(text(read(error, 'stack')) ?? '', message)
    .map(line => (FRAME.exec(line) ?? HEADER.exec(line))![1]!)];
  for (const candidate of candidates) {
    const local = repositoryFile(candidate, root);
    if (local) return local;
  }
  return undefined;
}

function classify(error: unknown, root: string): LoadFailureFields {
  if (!(error instanceof Error)) return { cause_code: 'UNCLASSIFIED_ERROR' };
  const message = text(read(error, 'message')) ?? '', name = text(read(error, 'name'));
  const code = text(read(error, 'code')), cause = read(error, 'cause');
  const causeCode = cause && typeof cause === 'object' ? text(read(cause, 'code')) : null;
  const nodeError = code && NODE_ERROR.test(code) ? code : undefined;
  const sqlState = [code, causeCode].find(c => c && SQL_STATE.test(c) && !NODE_ERROR.test(c)) ?? undefined;
  const systemError = [code, causeCode].find(c => c && SYSTEM_ERROR.test(c)) ?? undefined;
  const module = moduleOf(error, message, root);
  return {
    cause_code: CLOSED_CODE.test(message) ? message : nodeError ?? systemError ?? 'UNCLASSIFIED_ERROR',
    ...nodeError ? { node_error: nodeError } : {},
    ...sqlState ? { sql_state: sqlState } : {},
    ...systemError ? { system_error: systemError } : {},
    ...name && ERROR_TYPE.test(name) ? { error_type: name } : {},
    ...module ? { module } : {},
  };
}

export function loadFailureFields(error: unknown, root: string = REPOSITORY_ROOT): LoadFailureFields {
  // A hostile or broken thrown value (a throwing getter, a Proxy) must not turn one subsystem's failure into a crash of the whole process.
  try { return classify(error, root); } catch { return { cause_code: 'UNCLASSIFIED_ERROR' }; }
}
