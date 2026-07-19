import { isUtf8 } from "node:buffer";

/**
 * JSON parser that rejects invalid UTF-8 and duplicate object keys after JSON
 * string decoding. Native JSON.parse silently keeps the last duplicate, which
 * is unsafe for settings CAS and authorization objects.
 */

export class StrictJsonError extends Error {
  readonly code: string;
  readonly offset: number;

  constructor(code: string, message: string, offset: number) {
    super(`${code}: ${message} at byte offset ${offset}`);
    this.name = "StrictJsonError";
    this.code = code;
    this.offset = offset;
  }
}

export function parseJsonRejectDuplicateKeys(raw: string | Buffer): unknown {
  if (Buffer.isBuffer(raw) && !isUtf8(raw)) {
    throw new StrictJsonError("STRICT_JSON_UTF8", "input is not valid UTF-8", 0);
  }
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  const parser = new Parser(text);
  const value = parser.parseValue();
  parser.skipWhitespace();
  if (!parser.done()) parser.fail("STRICT_JSON_TRAILING", "unexpected trailing input");
  return value;
}

class Parser {
  private offset = 0;

  constructor(private readonly text: string) {}

  done(): boolean { return this.offset >= this.text.length; }

  skipWhitespace(): void {
    while (!this.done() && /[\x20\x09\x0a\x0d]/.test(this.text[this.offset]!)) this.offset += 1;
  }

  parseValue(): unknown {
    this.skipWhitespace();
    const current = this.text[this.offset];
    if (current === "{") return this.parseObject();
    if (current === "[") return this.parseArray();
    if (current === "\"") return this.parseString();
    if (current === "t") return this.parseKeyword("true", true);
    if (current === "f") return this.parseKeyword("false", false);
    if (current === "n") return this.parseKeyword("null", null);
    if (current === "-" || (current !== undefined && current >= "0" && current <= "9")) return this.parseNumber();
    this.fail("STRICT_JSON_VALUE", "expected a JSON value");
  }

  private parseObject(): Record<string, unknown> {
    this.offset += 1;
    const output = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.consume("}")) return output;
    while (true) {
      this.skipWhitespace();
      if (this.text[this.offset] !== "\"") this.fail("STRICT_JSON_OBJECT_KEY", "expected a quoted object key");
      const keyOffset = this.offset;
      const key = this.parseString();
      if (keys.has(key)) this.failAt("STRICT_JSON_DUPLICATE_KEY", `duplicate object key ${JSON.stringify(key)}`, keyOffset);
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(":")) this.fail("STRICT_JSON_OBJECT_COLON", "expected ':' after object key");
      output[key] = this.parseValue();
      this.skipWhitespace();
      if (this.consume("}")) return output;
      if (!this.consume(",")) this.fail("STRICT_JSON_OBJECT_SEPARATOR", "expected ',' or '}' in object");
    }
  }

  private parseArray(): unknown[] {
    this.offset += 1;
    const output: unknown[] = [];
    this.skipWhitespace();
    if (this.consume("]")) return output;
    while (true) {
      output.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume("]")) return output;
      if (!this.consume(",")) this.fail("STRICT_JSON_ARRAY_SEPARATOR", "expected ',' or ']' in array");
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (!this.done()) {
      const code = this.text.charCodeAt(this.offset);
      if (!escaped && code === 0x22) {
        this.offset += 1;
        const token = this.text.slice(start, this.offset);
        try { return JSON.parse(token) as string; }
        catch { this.failAt("STRICT_JSON_STRING", "invalid JSON string", start); }
      }
      if (!escaped && code < 0x20) this.fail("STRICT_JSON_STRING", "unescaped control character in string");
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      this.offset += 1;
    }
    this.failAt("STRICT_JSON_STRING", "unterminated JSON string", start);
  }

  private parseNumber(): number {
    const tail = this.text.slice(this.offset);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(tail);
    if (!match) this.fail("STRICT_JSON_NUMBER", "invalid JSON number");
    const token = match[0];
    this.offset += token.length;
    const value = Number(token);
    if (!Number.isFinite(value)) this.failAt("STRICT_JSON_NUMBER", "non-finite JSON number", this.offset - token.length);
    return value;
  }

  private parseKeyword<T>(keyword: string, value: T): T {
    if (this.text.slice(this.offset, this.offset + keyword.length) !== keyword) this.fail("STRICT_JSON_KEYWORD", `expected ${keyword}`);
    this.offset += keyword.length;
    return value;
  }

  private consume(value: string): boolean {
    if (this.text[this.offset] !== value) return false;
    this.offset += 1;
    return true;
  }

  fail(code: string, message: string): never { this.failAt(code, message, this.offset); }

  private failAt(code: string, message: string, offset: number): never {
    throw new StrictJsonError(code, message, Buffer.byteLength(this.text.slice(0, offset), "utf8"));
  }
}
