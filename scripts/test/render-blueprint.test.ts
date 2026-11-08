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
    expect(builds.length).toBe(4); // botfare-web, botfare-demo, botfare-payouts, botfare-demo-refresh
    for (const build of builds) {
      const corepack = build.indexOf("corepack enable");
      expect(corepack).toBeGreaterThanOrEqual(0);
      expect(corepack).toBeLessThan(build.indexOf("pnpm"));
    }
  });

  it("gives botfare-web its public URL and the judge, login and research agent settings", () => {
    const yaml = read("render.yaml");
    const web = /name: botfare-web\n([\s\S]*?)(?=\n {2}- type:)/.exec(yaml)?.[1] ?? "";
    for (const key of [
      "BOTFARE_URL",
      "DEMO_PUBLIC_URL",
      "BOTFARE_AGENT_KEY",
      "PAYPAL_LOGIN_ENABLED",
      "JUDGE_SANDBOX_BUYER_EMAIL",
      "JUDGE_SANDBOX_BUYER_PASSWORD",
    ]) {
      expect(web).toContain(`key: ${key}`);
    }
  });

  it("runs the daily payouts job as a cron service with the payouts script", () => {
    const yaml = read("render.yaml");
    const cron = /- type: cron\n([\s\S]*?)(?=\n {2}- type:|\ndatabases:)/.exec(yaml)?.[1] ?? "";
    expect(cron).toMatch(/name: botfare-payouts/);
    expect(cron).toMatch(/schedule: "[^"]+"/);
    expect(cron).toMatch(/startCommand: pnpm payouts:run/);
    for (const key of ["DATABASE_URL", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) {
      expect(cron).toContain(`key: ${key}`);
    }
    expect(JSON.parse(read("package.json")).scripts["payouts:run"]).toBe("tsx scripts/payouts.ts");
  });

  it("refreshes the demo story weekly, so the Fare Advisor's 14-day window never runs dry", () => {
    const yaml = read("render.yaml");
    const cron = /name: botfare-demo-refresh\n([\s\S]*?)(?=\n {2}- type:|\ndatabases:)/.exec(
      yaml,
    )?.[1];
    expect(cron).toBeDefined();
    expect(cron).toMatch(/schedule: "\d+ \d+ \* \* \d"/); // once a week, inside the 14 days
    expect(cron).toMatch(/startCommand: pnpm seed:traffic --weekly/);
    expect(cron).toContain("key: DATABASE_URL");
    expect(JSON.parse(read("package.json")).scripts["seed:traffic"]).toBe("tsx scripts/traffic.ts");
  });
});
