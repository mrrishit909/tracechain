// Input boundary: byte-size limit, binary/archive/document rejection, strict UTF-8 decoding,
// and a strict JSON parser that preserves numeric lexemes (so `1e5`, `1.0`, `-0` can be rejected),
// rejects duplicate keys and prototype-polluting keys, and bounds nesting depth.
import { LIMITS, DANGEROUS_KEYS, TraceChainError } from './limits.js';

/** Raw JSON number lexeme. Never converted implicitly. */
export class JsonNumber {
  constructor(raw) {
    this.raw = raw;
    Object.freeze(this);
  }
}

const MAGIC = [
  { name: 'ZIP/Office archive', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'PDF document', bytes: [0x25, 0x50, 0x44, 0x46] },
  { name: 'gzip archive', bytes: [0x1f, 0x8b] },
  { name: 'OLE/legacy Office document', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { name: 'RAR archive', bytes: [0x52, 0x61, 0x72, 0x21] },
  { name: '7z archive', bytes: [0x37, 0x7a, 0xbc, 0xaf] },
  { name: 'executable (MZ)', bytes: [0x4d, 0x5a] },
  { name: 'executable (ELF)', bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

/**
 * Decode untrusted input (string, Buffer or Uint8Array) to text. Never fetches URLs or reads files:
 * a string is always treated as content, never as a path or URL.
 */
export function decodeInput(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    throw new TraceChainError('INPUT_TYPE', 'Input must be a UTF-8 string or byte array (no URLs, files or objects)');
  }
  if (bytes.byteLength > LIMITS.maxInputBytes) {
    throw new TraceChainError('INPUT_TOO_LARGE', `Input is ${bytes.byteLength} bytes; limit is ${LIMITS.maxInputBytes} bytes (1 MiB)`);
  }
  for (const m of MAGIC) {
    if (bytes.byteLength >= m.bytes.length && m.bytes.every((b, i) => bytes[i] === b)) {
      throw new TraceChainError('BINARY_INPUT', `Rejected ${m.name}: only UTF-8 JSON or CSV text is accepted`);
    }
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new TraceChainError('INVALID_UTF8', 'Input is not valid UTF-8');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw new TraceChainError('CONTROL_CHARACTERS', 'Input contains NUL or other disallowed control characters');
  }
  return text;
}

/** Strict JSON parse. Objects are null-prototype; numbers are JsonNumber lexemes. */
export function parseStrictJson(text) {
  let i = 0;
  const n = text.length;
  const fail = (msg) => {
    throw new TraceChainError('JSON_SYNTAX', `${msg} at offset ${i}`);
  };
  const ws = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const value = (depth) => {
    if (depth > LIMITS.maxJsonDepth) {
      throw new TraceChainError('JSON_TOO_DEEP', `JSON nesting exceeds ${LIMITS.maxJsonDepth}`);
    }
    ws();
    const c = text[i];
    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    return fail('Unexpected token');
  };
  const object = (depth) => {
    i++;
    const out = Object.create(null);
    ws();
    if (text[i] === '}') { i++; return out; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail('Expected string key');
      const key = string();
      if (DANGEROUS_KEYS.has(key)) {
        throw new TraceChainError('DANGEROUS_KEY', `Object key "${key}" is not allowed`);
      }
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new TraceChainError('DUPLICATE_KEY', `Duplicate JSON key "${key}"`);
      }
      ws();
      if (text[i] !== ':') fail('Expected ":"');
      i++;
      out[key] = value(depth + 1);
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return out; }
      fail('Expected "," or "}"');
    }
  };
  const array = (depth) => {
    i++;
    const out = [];
    ws();
    if (text[i] === ']') { i++; return out; }
    for (;;) {
      out.push(value(depth + 1));
      if (out.length > LIMITS.maxRecords * 4) {
        throw new TraceChainError('TOO_MANY_RECORDS', 'JSON array too large');
      }
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return out; }
      fail('Expected "," or "]"');
    }
  };
  const string = () => {
    i++;
    let out = '';
    for (;;) {
      if (i >= n) fail('Unterminated string');
      const c = text[i];
      if (c === '"') { i++; break; }
      if (c === '\\') {
        const e = text[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('Bad unicode escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else if (e in map) {
          out += map[e];
          i += 2;
        } else {
          fail('Bad escape');
        }
        continue;
      }
      if (c < ' ') fail('Raw control character in string');
      out += c;
      i++;
      if (out.length > LIMITS.maxNoteLength * 2) {
        throw new TraceChainError('STRING_TOO_LONG', 'JSON string exceeds bounded length');
      }
    }
    return out;
  };
  const number = () => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 400));
    if (!m) fail('Bad number');
    i += m[0].length;
    return new JsonNumber(m[0]);
  };
  const result = value(0);
  ws();
  if (i !== n) fail('Trailing content');
  return result;
}
