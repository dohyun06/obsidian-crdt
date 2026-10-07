import { describe, expect, it } from "vitest";
import { TEXT_HISTORY_LIMIT, TextHistory } from "../src/core/textHistory";

describe("TextHistory", () => {
  it("remembers recent texts per file", () => {
    const history = new TextHistory();
    history.record("f1", "a");
    history.record("f1", "ab");
    expect(history.has("f1", "a")).toBe(true);
    expect(history.has("f2", "a")).toBe(false);
  });

  it("skips consecutive duplicates and keeps only the most recent entries", () => {
    const history = new TextHistory();
    for (let i = 0; i <= TEXT_HISTORY_LIMIT; i++) history.record("f1", `v${i}`);
    history.record("f1", `v${TEXT_HISTORY_LIMIT}`);
    expect(history.has("f1", "v0")).toBe(false);
    expect(history.has("f1", `v${TEXT_HISTORY_LIMIT}`)).toBe(true);
  });

  it("forgets a file", () => {
    const history = new TextHistory();
    history.record("f1", "a");
    history.forget("f1");
    expect(history.has("f1", "a")).toBe(false);
  });
});
