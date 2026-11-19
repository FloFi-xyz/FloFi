// SPDX-License-Identifier: AGPL-3.0-only
import { FinopsValidationError, validateEntry, type Entry } from './economics.ts';

const COLUMNS = ['scope', 'environment', 'start', 'end', 'source', 'reference', 'currency', 'net', 'coverage',
  'gross', 'credits', 'discounts', 'taxes', 'fxUsd', 'fxSource', 'notes'] as const;
const REQUIRED_COLUMNS = COLUMNS.slice(0, 9);
const MAX_ROWS = 101;
const MAX_TEXT = 14_000;

/** RFC 4180 cell decoding shared by invoice import and bounded provider exports. */
export function parseCsvRows(input: string, limits: { rows: number; columns: number }, invalid: () => never): string[][] {
  const csv = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const records: string[][] = [];
  let record: string[] = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!;
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === ',' || char === '\n') {
      record.push(value);
      if (char === '\n') { records.push(record); record = []; }
      if (records.length > limits.rows || record.length > limits.columns) return invalid();
      value = ''; closed = false;
    } else if (char === '"' && value === '' && !closed) quoted = true;
    else if (closed || char === '"' || char === '\r') return invalid();
    else value += char;
  }
  if (quoted) return invalid();
  if (record.length || value || closed) records.push([...record, value]);
  if (records.length > limits.rows || records.some(row => row.length > limits.columns)) return invalid();
  return records;
}

export function parseFinopsCsv(input: unknown): Entry[] {
  const invalid = (field = 'csv'): never => { throw new FinopsValidationError(field); };
  if (typeof input !== 'string' || input.length > MAX_TEXT) return invalid();
  const records = parseCsvRows(input, { rows: MAX_ROWS, columns: COLUMNS.length }, invalid);
  const [headers, ...rows] = records;
  if (!headers || !rows.length || records.length > MAX_ROWS || new Set(headers).size !== headers.length ||
      headers.some(column => !(COLUMNS as readonly string[]).includes(column)) || REQUIRED_COLUMNS.some(column => !headers.includes(column))) return invalid();
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) return invalid('row ' + (index + 2));
    try { return validateEntry(Object.fromEntries(headers.map((column, i) => [column, cells[i]]))); }
    catch (error) {
      if (error instanceof FinopsValidationError) return invalid('row ' + (index + 2) + ' / ' + error.field);
      throw error;
    }
  });
}

/** Deliberately neutralize spreadsheet formulas even if a future report adds user-derived text. */
export const csvCell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value);
  const escaped = /^[\s]*[=+@-]/.test(text) && !/^-\d+(?:\.\d+)?$/.test(text) || /^[\t\r\n]/.test(text) ? "'" + text : text;
  return '"' + escaped.replaceAll('"', '""') + '"';
};
export const writeFinopsCsv = (rows: readonly (readonly (string | number | null)[])[]) => rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
