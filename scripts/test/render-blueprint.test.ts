import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

/** Every `buildCommand`, `preDeployCommand` and `startCommand` value in render.yaml. */
function renderCommands(): string[] {
  return [...read("render.yaml").matchAll(/^\s*(?:build|preDeploy|start)Command:\s*(.+)$/gm)].map(
    (m) => (m[1] as string).trim(),
  );
}

describe("render.yaml", () => {
  it("runs on a Node major that still bundles Corepack when the build enables it", () => {
    // Corepack ships with Node 14.19 up to (not including) 25. Render installs the official
    // binaries for .node-version, so `corepack enable` on Node 25+ fails with exit 127.
    const major = Number(/^v?(\d+)/.exec(read(".node-version").trim())?.[1]);
    const engines = JSON.parse(read("package.json")).engines.node as string;
    const minMajor = Number(/>=\s*(\d+)/.exec(engines)?.[1]);
    expect(major).toBeGreaterThanOrEqual(minMajor);
    if (
      renderCommands().some((c) => /\bcorepack\b/.test(c) && !/npm (i|install) -g corepack/.test(c))
    ) {
      expect(major).toBeLessThan(25);
    }
  });

  it("enables Corepack before the first pnpm call of every build", () => {
    const builds = [...read("render.yaml").matchAll(/^\s*buildCommand:\s*(.+)$/gm)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(builds.length).toBe(2);
    for (const build of builds) {
      const corepack = build.indexOf("corepack enable");
      expect(corepack).toBeGreaterThanOrEqual(0);
      expect(corepack).toBeLessThan(build.indexOf("pnpm"));
    }
  });
});
