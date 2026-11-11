import { describe, expect, it } from "vitest";
import { demoBaseUrl, demoCommands } from "../src/components/judge/demo-commands";

describe("/judge curl commands", () => {
  it("defaults to the local demo and trims trailing slashes", () => {
    expect(demoBaseUrl(undefined)).toBe("http://localhost:4000");
    expect(demoBaseUrl("  ")).toBe("http://localhost:4000");
    expect(demoBaseUrl("https://saffron-and-salt.example//")).toBe(
      "https://saffron-and-salt.example",
    );
  });

  it("sends real browser headers for the free read and the agent header for the 402", () => {
    const c = demoCommands("https://saffron-and-salt.example");
    expect(c.url).toBe("https://saffron-and-salt.example/recipes/weeknight-red-lentil-dal");
    for (const header of ["Accept-Language: en-US", "Sec-Fetch-Site: none", "Sec-Fetch-Dest"]) {
      expect(c.human).toContain(header);
    }
    expect(c.human).toContain("-A 'Mozilla/5.0");
    expect(c.human).not.toContain("x-botfare-agent");
    expect(c.agent).toBe(
      "curl -i -H 'x-botfare-agent: 1' https://saffron-and-salt.example/recipes/weeknight-red-lentil-dal",
    );
    expect(c.decode).toContain("base64 --decode");
    expect(c.decode).toContain("payment-required");
  });
});
