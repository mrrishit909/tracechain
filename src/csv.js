// RFC 4180-style CSV parsing (bounded) and serialization with spreadsheet formula escaping.
import { LIMITS, TraceChainError } from './limits.js';

/**
 * Parse CSV text into { header, rows: [{ line, cells }] }. `line` is the 1-based physical line
 * where the record starts, retained as the source row for findings.
 */
export function parseCsv(text) {
  const records = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const startLine = line;
    const cells = [];
    let cell = '';
    let inQuotes = false;
    let quotedCell = false;
    for (;;) {
      if (i >= n) {
        if (inQuotes) throw new TraceChainError('CSV_SYNTAX', `Unterminated quoted field starting line ${startLine}`);
        cells.push(cell);
        break;
      }
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        if (c === '\n') line++;
        cell += c; i++;
      } else if (c === '"') {
        if (cell.length > 0 || quotedCell) throw new TraceChainError('CSV_SYNTAX', `Stray quote on line ${line}`);
        inQuotes = true; quotedCell = true; i++;
      } else if (c === ',') {
        cells.push(cell); cell = ''; quotedCell = false; i++;
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        i++; line++;
        cells.push(cell);
        break;
      } else {
        if (quotedCell) throw new TraceChainError('CSV_SYNTAX', `Characters after closing quote on line ${line}`);
        cell += c; i++;
      }
      if (cell.length > LIMITS.maxNoteLength * 2) {
        throw new TraceChainError('STRING_TOO_LONG', `CSV cell exceeds bounded length on line ${startLine}`);
      }
    }
    if (cells.length > LIMITS.maxCsvColumns) {
      throw new TraceChainError('CSV_TOO_MANY_COLUMNS', `Line ${startLine} has ${cells.length} columns`);
    }
    if (cells.length === 1 && cells[0] === '') continue; // blank line
    records.push({ line: startLine, cells });
    if (records.length > LIMITS.maxRecords + 1) {
      throw new TraceChainError('TOO_MANY_RECORDS', `CSV exceeds ${LIMITS.maxRecords} records`);
    }
  }
  if (records.length === 0) throw new TraceChainError('CSV_EMPTY', 'CSV has no header row');
  const [head, ...rows] = records;
  for (const r of rows) {
    if (r.cells.length !== head.cells.length) {
      throw new TraceChainError('CSV_COLUMN_MISMATCH', `Line ${r.line} has ${r.cells.length} columns; header has ${head.cells.length}`);
    }
  }
  return { header: head.cells, rows };
}

// Formula triggers plus the escape character itself (so escaping is unambiguously reversible).
const ESCAPE_PREFIX = /^[=+\-@\t\r']/;

/**
 * Escape a text cell so spreadsheets treat it as text, then quote per RFC 4180.
 * Strings starting with = + - @ TAB CR (or the ' escape itself) get a leading apostrophe.
 * Numbers are emitted as plain integers.
 */
export function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && ESCAPE_PREFIX.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Reverse of csvCell's escaping for text columns (used by round-trip parsing). */
export function unescapeFormula(s) {
  return s.startsWith("'") ? s.slice(1) : s;
}

export function toCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}
