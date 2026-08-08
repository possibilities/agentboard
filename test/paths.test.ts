import { describe, expect, test } from "bun:test";
import { configDirectory, dataDirectory, expandTilde, stateDirectory } from "../src/paths.ts";

const home = "/home/example";

describe("xdg directories", () => {
  test("absolute XDG overrides are honored", () => {
    expect(dataDirectory({ XDG_DATA_HOME: "/xdg/data" }, home, "app")).toBe("/xdg/data/app");
    expect(stateDirectory({ XDG_STATE_HOME: "/xdg/state" }, home, "app")).toBe("/xdg/state/app");
    expect(configDirectory({ XDG_CONFIG_HOME: "/xdg/cfg" }, home, "app")).toBe("/xdg/cfg/app");
  });

  test("relative XDG overrides fall back to defaults", () => {
    expect(dataDirectory({ XDG_DATA_HOME: "relative" }, home, "app")).toBe(
      "/home/example/.local/share/app",
    );
  });

  test("unset XDG uses defaults", () => {
    expect(dataDirectory({}, home, "app")).toBe("/home/example/.local/share/app");
    expect(stateDirectory({}, home, "app")).toBe("/home/example/.local/state/app");
    expect(configDirectory({}, home, "app")).toBe("/home/example/.config/app");
  });
});

describe("expandTilde", () => {
  test("expands bare tilde and tilde prefix, leaves the rest alone", () => {
    expect(expandTilde("~", home)).toBe(home);
    expect(expandTilde("~/wiki", home)).toBe("/home/example/wiki");
    expect(expandTilde("/absolute", home)).toBe("/absolute");
    expect(expandTilde("relative/~", home)).toBe("relative/~");
  });
});
