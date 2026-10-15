/**
 * A JSON parser with Python's `json.loads` number semantics.
 *
 * The contract reads mirror records with `json.loads`, then asks
 * `isinstance(x, int) and not isinstance(x, bool)`. In Python a number literal
 * is an int only if it has no fraction and no exponent: `1.0`, `1e0`, `10e-1`
 * and `1.0000000000000001` are all floats and are rejected. JavaScript's
 * `JSON.parse` has one number type, so it reads every one of those as `1` and
 * `Number.isInteger` says yes -- a preview built on it would call a record
 * valid that the contract rejects.
 *
 * This parser keeps the distinction: an integer literal becomes a `number`
 * (or a `bigint` beyond 2^53, which Python also accepts), and anything with a
 * fraction or exponent -- plus `NaN`, `Infinity`, `-Infinity`, which Python's
 * default decoder also accepts -- becomes a `PyFloat`, never an integer.
 *
 * Syntax follows Python's decoder, not the JSON spec's leniency:
 *   - leading zeros (`01`), a leading `+`, `1.`, `.1`, hex and a BOM are errors;
 *   - control characters inside strings are errors (strict mode);
 *   - only space, tab, CR and LF are whitespace;
 *   - duplicate keys: the last one wins;
 *   - the whole input must be consumed (trailing data is an error).
 * Any error means "the body is not JSON", which the contract maps to OUTAGE,
 * not to a rejection.
 */

/** A JSON number the contract would treat as a float. */
export class PyFloat {
  constructor(readonly literal: string) {}
}

export type StrictJson =
  | null
  | boolean
  | string
  | number
  | bigint
  | PyFloat
  | StrictJson[]
  | { [key: string]: StrictJson };

export class JsonSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "JsonSyntaxError";
  }
}

const MAX_DEPTH = 500;

const isDigit = (c: string) => c >= "0" && c <= "9";

/** Python's `isinstance(x, int) and not isinstance(x, bool)` for parsed JSON. */
export function isPyInt(x: unknown): x is number | bigint {
  return typeof x === "bigint" || (typeof x === "number" && Number.isInteger(x));
}

/** Value of a parsed integer as a bigint. */
export function pyIntValue(x: number | bigint): bigint {
  return typeof x === "bigint" ? x : BigInt(x);
}

export function parseStrictJson(text: string): StrictJson {
  let i = 0;

  const fail = (msg: string): never => {
    throw new JsonSyntaxError(msg, i);
  };

  const skipWs = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };

  const parseString = (): string => {
    // text[i] === '"'
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text[i]!;
      const code = c.charCodeAt(0);
      if (c === '"') {
        i++;
        return out;
      }
      if (code < 0x20) fail("control character in string");
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      i++;
      const e = text[i];
      switch (e) {
        case '"': out += '"'; i++; break;
        case "\\": out += "\\"; i++; break;
        case "/": out += "/"; i++; break;
        case "b": out += "\b"; i++; break;
        case "f": out += "\f"; i++; break;
        case "n": out += "\n"; i++; break;
        case "r": out += "\r"; i++; break;
        case "t": out += "\t"; i++; break;
        case "u": {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("invalid \\u escape");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          break;
        }
        default:
          fail("invalid escape");
      }
    }
  };

  const parseNumber = (): number | bigint | PyFloat => {
    const start = i;
    if (text[i] === "-") i++;
    if (i >= text.length) fail("bare minus");
    if (text[i] === "0") {
      i++;
    } else if (text[i]! >= "1" && text[i]! <= "9") {
      while (i < text.length && isDigit(text[i]!)) i++;
    } else {
      fail("invalid number");
    }
    let isFloat = false;
    // A fraction needs at least one digit; `1.` leaves the dot unconsumed,
    // which the caller then rejects as stray data -- exactly as Python does.
    if (text[i] === "." && i + 1 < text.length && isDigit(text[i + 1]!)) {
      isFloat = true;
      i++;
      while (i < text.length && isDigit(text[i]!)) i++;
    }
    if (text[i] === "e" || text[i] === "E") {
      let j = i + 1;
      if (text[j] === "+" || text[j] === "-") j++;
      if (j < text.length && isDigit(text[j]!)) {
        isFloat = true;
        while (j < text.length && isDigit(text[j]!)) j++;
        i = j;
      }
    }
    const literal = text.slice(start, i);
    if (isFloat) return new PyFloat(literal);
    const big = BigInt(literal);
    const small = Number(big);
    return Number.isSafeInteger(small) ? (small === 0 ? 0 : small) : big;
  };

  const parseValue = (depth: number): StrictJson => {
    if (depth > MAX_DEPTH) fail("nesting too deep");
    skipWs();
    if (i >= text.length) fail("unexpected end of input");
    const c = text[i]!;
    if (c === '"') return parseString();
    if (c === "{") {
      i++;
      const obj: { [key: string]: StrictJson } = Object.create(null) as { [key: string]: StrictJson };
      skipWs();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        skipWs();
        if (text[i] !== '"') fail("expected a string key");
        const key = parseString();
        skipWs();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        const value = parseValue(depth + 1);
        Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: StrictJson[] = [];
      skipWs();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skipWs();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected ',' or ']'");
      }
    }
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    if (text.startsWith("NaN", i)) { i += 3; return new PyFloat("NaN"); }
    if (text.startsWith("Infinity", i)) { i += 8; return new PyFloat("Infinity"); }
    if (text.startsWith("-Infinity", i)) { i += 9; return new PyFloat("-Infinity"); }
    if (c === "-" || isDigit(c)) return parseNumber();
    return fail(`unexpected character ${JSON.stringify(c)}`);
  };

  const value = parseValue(0);
  skipWs();
  if (i < text.length) fail("extra data");
  return value;
}
