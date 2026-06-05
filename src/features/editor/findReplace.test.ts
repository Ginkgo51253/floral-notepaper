import { describe, expect, it } from "vitest";
import { findAll, isWordBoundary, replaceAll, replaceCurrent } from "./findReplace";

describe("findReplace regex mode", () => {
  const content = "foo bar foo123\nbaz";

  it("findAll locates regex matches", () => {
    const matches = findAll(content, "foo\\d+", false, true);
    expect(matches).toEqual([{ start: 8, end: 14 }]);
  });

  it("replaceCurrent with capture group backref", () => {
    const matches = findAll(content, "(foo)\\d+", false, true);
    expect(matches.length).toBe(1);
    const { content: out } = replaceCurrent(content, "(foo)\\d+", "$1!", 0, false, true);
    expect(out).toBe("foo bar foo!\nbaz");
  });

  it("replaceCurrent with lookahead pattern", () => {
    const c = "foo bar";
    const matches = findAll(c, "foo(?= )", false, true);
    expect(matches).toEqual([{ start: 0, end: 3 }]);
    const { content: out } = replaceCurrent(c, "foo(?= )", "baz", 0, false, true);
    expect(out).toBe("baz bar");
  });

  it("replaceAll with capture group", () => {
    const c = "a1 b2 c3";
    const { content: out, replacedCount } = replaceAll(c, "(\\w)(\\d)", "$2$1", false, true);
    expect(replacedCount).toBe(3);
    expect(out).toBe("1a 2b 3c");
  });

  it("replaceAll simple regex", () => {
    const c = "hello world hello";
    const { content: out, replacedCount } = replaceAll(c, "hello", "hi", false, true);
    expect(replacedCount).toBe(2);
    expect(out).toBe("hi world hi");
  });

  it("replaceCurrent dot-star", () => {
    const c = "abc";
    const matches = findAll(c, "a.c", false, true);
    expect(matches).toEqual([{ start: 0, end: 3 }]);
    const { content: out } = replaceCurrent(c, "a.c", "X", 0, false, true);
    expect(out).toBe("X");
  });

  it("replaceCurrent with $& backref", () => {
    const c = "aa bb";
    const { content: out } = replaceCurrent(c, "\\w+", "[$&]", 0, false, true);
    expect(out).toBe("[aa] bb");
  });

  it("replaceAll with wholeWord uses expandBackrefs for $1", () => {
    const c = "a1 b2";
    const { content: out, replacedCount } = replaceAll(c, "(\\w)(\\d)", "$2$1", false, true, true);
    expect(replacedCount).toBe(2);
    expect(out).toBe("1a 2b");
  });

  it("replaceAll regex with preserveCase", () => {
    const c = "Hello HELLO hello";
    const { content: out, replacedCount } = replaceAll(
      c,
      "hello",
      "world",
      false,
      true,
      false,
      true,
    );
    expect(replacedCount).toBe(3);
    expect(out).toBe("World WORLD world");
  });

  it("replaceAll regex with $1 backrefs matches replaceCurrent", () => {
    const c = "foo bar foo123\nbaz";
    const { content: out, replacedCount } = replaceAll(c, "(foo)\\d+", "$1!", false, true);
    expect(replacedCount).toBe(1);
    expect(out).toBe("foo bar foo!\nbaz");
  });
});

describe("findReplace wholeWord", () => {
  it("isWordBoundary treats CJK as word characters", () => {
    expect(isWordBoundary("你好世界", 0, 2)).toBe(false);
    expect(isWordBoundary("你好 世界", 0, 2)).toBe(true);
  });

  it("findAll wholeWord skips partial ASCII matches", () => {
    const matches = findAll("testing test", "test", false, false, true);
    expect(matches).toEqual([{ start: 8, end: 12 }]);
  });
});
