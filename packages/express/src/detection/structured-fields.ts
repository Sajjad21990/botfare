/**
 * Just enough of RFC 8941 (Structured Field Values) to read HTTP Message Signature headers:
 * dictionaries whose members are items or inner lists, each with parameters. Every parsed member
 * keeps its raw text, because RFC 9421 signs the serialized `Signature-Input` member
 * (`@signature-params`) and the serialized identifiers of the covered components.
 */

export type BareItem = string | number | boolean | Uint8Array | { token: string };
export type Params = Map<string, BareItem>;

export interface SfItem {
  value: BareItem;
  params: Params;
  /** The item as written, e.g. `"signature-agent";key="sig1"`. */
  raw: string;
}

export interface SfMember {
  /** Set for an inner list, e.g. `("@authority" "signature-agent")`. */
  list?: SfItem[];
  /** Set for a plain item, e.g. `:base64:`. */
  item?: SfItem;
  params: Params;
  /** The member value as written (inner list or item, with its parameters), without the key. */
  raw: string;
}

class Parser {
  pos = 0;
  constructor(readonly input: string) {}

  peek(): string {
    return this.input[this.pos] ?? "";
  }

  eof(): boolean {
    return this.pos >= this.input.length;
  }

  skipSp(): void {
    while (this.peek() === " ") this.pos++;
  }

  skipOws(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos++;
  }

  fail(what: string): never {
    throw new Error(`structured field: ${what} at ${this.pos}`);
  }

  key(): string {
    const match = /^[a-z*][a-z0-9_\-.*]*/.exec(this.input.slice(this.pos));
    if (!match) this.fail("expected key");
    this.pos += match[0].length;
    return match[0];
  }

  bareItem(): BareItem {
    const c = this.peek();
    if (c === '"') return this.string();
    if (c === ":") return this.bytes();
    if (c === "?") {
      this.pos++;
      const bit = this.peek();
      if (bit !== "0" && bit !== "1") this.fail("expected boolean");
      this.pos++;
      return bit === "1";
    }
    if (c === "-" || /[0-9]/.test(c)) {
      const match = /^-?[0-9]{1,15}(\.[0-9]{1,3})?/.exec(this.input.slice(this.pos));
      if (!match) this.fail("expected number");
      this.pos += match[0].length;
      return Number(match[0]);
    }
    const token = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/.exec(this.input.slice(this.pos));
    if (!token) this.fail("expected item");
    this.pos += token[0].length;
    return { token: token[0] };
  }

  string(): string {
    this.pos++; // opening quote
    let out = "";
    while (!this.eof()) {
      const c = this.input[this.pos++] as string;
      if (c === "\\") {
        const next = this.input[this.pos++];
        if (next !== '"' && next !== "\\") this.fail("bad escape");
        out += next;
      } else if (c === '"') {
        return out;
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) this.fail("non-ASCII in string");
        out += c;
      }
    }
    this.fail("unterminated string");
  }

  bytes(): Uint8Array {
    this.pos++; // opening colon
    const end = this.input.indexOf(":", this.pos);
    if (end < 0) this.fail("unterminated byte sequence");
    const b64 = this.input.slice(this.pos, end);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) this.fail("bad base64");
    this.pos = end + 1;
    return new Uint8Array(Buffer.from(b64, "base64"));
  }

  params(): Params {
    const params: Params = new Map();
    while (this.peek() === ";") {
      this.pos++;
      this.skipSp();
      const key = this.key();
      let value: BareItem = true;
      if (this.peek() === "=") {
        this.pos++;
        value = this.bareItem();
      }
      params.set(key, value);
    }
    return params;
  }

  item(): SfItem {
    const start = this.pos;
    const value = this.bareItem();
    const params = this.params();
    return { value, params, raw: this.input.slice(start, this.pos) };
  }

  member(): SfMember {
    const start = this.pos;
    if (this.peek() === "(") {
      this.pos++;
      const list: SfItem[] = [];
      for (;;) {
        this.skipSp();
        if (this.peek() === ")") {
          this.pos++;
          break;
        }
        list.push(this.item());
        const next = this.peek();
        if (next !== " " && next !== ")") this.fail("expected space or )");
      }
      const params = this.params();
      return { list, params, raw: this.input.slice(start, this.pos) };
    }
    const item = this.item();
    return { item, params: item.params, raw: item.raw };
  }
}

/** Parses a dictionary (`a=1, b=(...);x=2`). Throws on malformed input. */
export function parseDictionary(input: string): Map<string, SfMember> {
  const parser = new Parser(input.trim());
  const out = new Map<string, SfMember>();
  while (!parser.eof()) {
    const key = parser.key();
    let member: SfMember;
    if (parser.peek() === "=") {
      parser.pos++;
      member = parser.member();
    } else {
      const params = parser.params();
      member = { item: { value: true, params, raw: "?1" }, params, raw: "?1" };
    }
    out.set(key, member);
    parser.skipOws();
    if (parser.eof()) break;
    if (parser.peek() !== ",") parser.fail("expected ,");
    parser.pos++;
    parser.skipOws();
    if (parser.eof()) parser.fail("trailing comma");
  }
  return out;
}

/** Parses a single item (`"https://botfare.example"`). Throws on malformed input. */
export function parseItem(input: string): SfItem {
  const parser = new Parser(input.trim());
  const item = parser.item();
  if (!parser.eof()) parser.fail("trailing characters");
  return item;
}
