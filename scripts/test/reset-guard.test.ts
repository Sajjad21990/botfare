import { describe, expect, it } from "vitest";
import { ALLOW_LOCAL_FLAG, CONFIRM_FLAG, describeTarget, refusalFor } from "../lib/reset-guard";

const RENDER = "postgresql://botfare:secret@dpg-abc123-a/botfare";
const LOCAL = "postgres://botfare:botfare@localhost:5432/botfare";

describe("db:reset guard", () => {
  it("names the target without credentials", () => {
    expect(describeTarget(RENDER)).toBe("dpg-abc123-a/botfare");
    expect(describeTarget(RENDER)).not.toContain("secret");
  });

  it("refuses without the confirmation flag", () => {
    expect(refusalFor(RENDER, [])).toContain(CONFIRM_FLAG);
  });

  it("runs on a remote database once confirmed", () => {
    expect(refusalFor(RENDER, [CONFIRM_FLAG])).toBeNull();
  });

  it("refuses a local database unless it is allowed too", () => {
    expect(refusalFor(LOCAL, [CONFIRM_FLAG])).toContain(ALLOW_LOCAL_FLAG);
    expect(refusalFor("postgres://u:p@127.0.0.1/db", [CONFIRM_FLAG])).not.toBeNull();
    expect(refusalFor(LOCAL, [CONFIRM_FLAG, ALLOW_LOCAL_FLAG])).toBeNull();
  });
});
