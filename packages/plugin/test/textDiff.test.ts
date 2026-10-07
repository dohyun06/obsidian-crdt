import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyMinimalDiff, diffByCodePoint, hasLoneSurrogate } from "../src/core/textDiff";

function docWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return doc;
}

function remoteCopy(doc: Y.Doc): string {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy.getText("content").toString();
}

describe("diffByCodePoint", () => {
  it("never splits a surrogate pair", () => {
    const edits = diffByCodePoint("x😀y", "x😁y");
    for (const edit of edits) expect(hasLoneSurrogate(edit.text)).toBe(false);
  });
});

describe("applyMinimalDiff", () => {
  const cases: Array<[string, string]> = [
    ["x😀y", "x😁y"],
    ["한글 테스트", "한글 수정 테스트"],
    ["a\r\nb", "a\nb"],
    ["", "😀 new"],
    ["😀😀", "😀"],
    ["unchanged", "unchanged"],
  ];

  for (const [before, after] of cases) {
    it(`turns ${JSON.stringify(before)} into ${JSON.stringify(after)} locally and remotely`, () => {
      const doc = docWith(before);
      applyMinimalDiff(doc.getText("content"), after, "test");
      expect(doc.getText("content").toString()).toBe(after);
      expect(remoteCopy(doc)).toBe(after);
    });
  }

  it("emits no update when the text is unchanged", () => {
    const doc = docWith("same");
    let updates = 0;
    doc.on("update", () => updates++);
    applyMinimalDiff(doc.getText("content"), "same", "test");
    expect(updates).toBe(0);
  });

  it("tags the transaction with the given origin", () => {
    const doc = docWith("a");
    const origins: unknown[] = [];
    doc.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin));
    applyMinimalDiff(doc.getText("content"), "ab", "disk");
    expect(origins).toEqual(["disk"]);
  });

  it("keeps a concurrent remote edit elsewhere in the text", () => {
    const local = docWith("line one\nline two\n");
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
    remote.getText("content").insert(remote.getText("content").length, "line three\n");
    applyMinimalDiff(local.getText("content"), "LINE ONE\nline two\n", "disk");
    Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
    expect(local.getText("content").toString()).toBe("LINE ONE\nline two\nline three\n");
  });
});
