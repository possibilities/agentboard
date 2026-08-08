import { describe, expect, test } from "bun:test";
import { normalizeLabel, topicKeyFor } from "../src/topic.ts";

describe("topicKeyFor", () => {
  test("treats a leading article as noise", () => {
    expect(topicKeyFor("the auth cleanup")).toBe("auth-cleanup");
    expect(topicKeyFor("Auth cleanup")).toBe("auth-cleanup");
    expect(topicKeyFor("A log panel")).toBe("log-panel");
    expect(topicKeyFor("an icon set")).toBe("icon-set");
  });

  test("strips only the leading article, and only one", () => {
    expect(topicKeyFor("the the thing")).toBe("the-thing");
    expect(topicKeyFor("rename the thing")).toBe("rename-the-thing");
    expect(topicKeyFor("theatre seating")).toBe("theatre-seating");
  });

  test("joins on any run of non-alphanumerics and trims the edges", () => {
    expect(topicKeyFor("  Fix   the   flaky --- login test!  ")).toBe("fix-the-flaky-login-test");
    expect(topicKeyFor("v2.1 rollout")).toBe("v2-1-rollout");
  });

  test("never returns a blank key", () => {
    expect(topicKeyFor("???")).toBe("???");
    expect(topicKeyFor("the ")).toBe("the");
  });
});

describe("normalizeLabel", () => {
  test("collapses the ragged spacing dictation produces", () => {
    expect(normalizeLabel("  the   auth\n cleanup ")).toBe("the auth cleanup");
  });
});
