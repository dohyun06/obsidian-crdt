import DiffMatchPatch from "diff-match-patch";
import type * as Y from "yjs";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const SURROGATE_RANGE_START = 0xd800;
const SURROGATE_RANGE_SIZE = 0x800;
const MAX_DISTINCT_CODE_POINTS = 0xffff - SURROGATE_RANGE_SIZE;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const differ = new DiffMatchPatch();

export type TextEdit = { op: "equal" | "delete" | "insert"; text: string };

export class TooManyDistinctCharactersError extends Error {
  constructor() {
    super(`text uses more than ${MAX_DISTINCT_CODE_POINTS} distinct characters; cannot diff safely`);
    this.name = "TooManyDistinctCharactersError";
  }
}

export function hasLoneSurrogate(value: string): boolean {
  return LONE_SURROGATE.test(value);
}

/**
 * Diffs by Unicode code point. A plain UTF-16 diff can split an emoji's surrogate pair,
 * and Yjs turns a lone surrogate into U+FFFD when it encodes the update (spec §4.3).
 * Each distinct code point is mapped to one BMP non-surrogate char, diffed, then mapped back.
 */
export function diffByCodePoint(before: string, after: string): TextEdit[] {
  const codec = createCodePointCodec();
  const diffs = differ.diff_main(codec.encode(before), codec.encode(after));
  return diffs.map(([op, chunk]) => ({ op: toOpName(op), text: codec.decode(chunk) }));
}

export function applyMinimalDiff(text: Y.Text, next: string, origin: unknown): void {
  const doc = text.doc;
  if (!doc) throw new Error("applyMinimalDiff: Y.Text must belong to a Y.Doc");
  const current = text.toString();
  if (current === next) return;
  const edits = diffByCodePoint(current, next);
  doc.transact(() => {
    let index = 0;
    for (const edit of edits) {
      if (edit.op === "equal") index += edit.text.length;
      else if (edit.op === "delete") text.delete(index, edit.text.length);
      else {
        text.insert(index, edit.text);
        index += edit.text.length;
      }
    }
  }, origin);
}

function toOpName(op: number): TextEdit["op"] {
  if (op === DIFF_DELETE) return "delete";
  if (op === DIFF_INSERT) return "insert";
  return "equal";
}

function createCodePointCodec() {
  const table: string[] = [];
  const ids = new Map<string, number>();
  const toChar = (id: number) => String.fromCharCode(id < SURROGATE_RANGE_START ? id : id + SURROGATE_RANGE_SIZE);
  const toId = (code: number) => (code < SURROGATE_RANGE_START ? code : code - SURROGATE_RANGE_SIZE);
  return {
    encode(value: string): string {
      let out = "";
      for (const codePoint of value) {
        let id = ids.get(codePoint);
        if (id === undefined) {
          if (table.length >= MAX_DISTINCT_CODE_POINTS) throw new TooManyDistinctCharactersError();
          id = table.length;
          table.push(codePoint);
          ids.set(codePoint, id);
        }
        out += toChar(id);
      }
      return out;
    },
    decode(value: string): string {
      let out = "";
      for (let i = 0; i < value.length; i++) out += table[toId(value.charCodeAt(i))] ?? "";
      return out;
    },
  };
}
