import { describe, expect, it } from "vitest";
import { type ResourceRequest, resourceUrl } from "../src/payment-gate";

function fakeReq(headers: Record<string, string>, protocol = "http"): ResourceRequest {
  const all: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) all[name.toLowerCase()] = value;
  return { protocol, originalUrl: "/articles/burr-basics?ref=1", get: (name) => all[name] };
}

describe("resourceUrl", () => {
  it("uses the Host header without forwarding headers", () => {
    const req = fakeReq({ host: "localhost:4000" });
    expect(resourceUrl(req, "http://localhost:4000")).toBe(
      "http://localhost:4000/articles/burr-basics?ref=1",
    );
  });

  it("uses X-Forwarded-Host when it names the site's registered origin", () => {
    // The judge Docker stack: web fetches the demo at demo:4000 for the public localhost:4300.
    const req = fakeReq({
      host: "demo:4000",
      "x-forwarded-host": "localhost:4300",
      "x-forwarded-proto": "http",
    });
    expect(resourceUrl(req, "http://localhost:4300")).toBe(
      "http://localhost:4300/articles/burr-basics?ref=1",
    );
  });

  it("takes the first forwarded values and falls back to req.protocol", () => {
    const req = fakeReq({ host: "10.0.0.5:8080", "x-forwarded-host": "brewlab.test, proxy:80" });
    expect(resourceUrl(req, "http://brewlab.test")).toBe(
      "http://brewlab.test/articles/burr-basics?ref=1",
    );
    const https = fakeReq({
      host: "10.0.0.5:8080",
      "x-forwarded-host": "brewlab.test",
      "x-forwarded-proto": "https, http",
    });
    expect(resourceUrl(https, "https://brewlab.test/")).toBe(
      "https://brewlab.test/articles/burr-basics?ref=1",
    );
  });

  it("ignores a forwarded host that is not the registered origin", () => {
    const req = fakeReq({ host: "demo:4000", "x-forwarded-host": "premium.example" });
    expect(resourceUrl(req, "http://localhost:4300")).toBe(
      "http://demo:4000/articles/burr-basics?ref=1",
    );
  });

  it("ignores a forwarded proto that changes the origin", () => {
    const req = fakeReq({
      host: "demo:4000",
      "x-forwarded-host": "localhost:4300",
      "x-forwarded-proto": "https",
    });
    expect(resourceUrl(req, "http://localhost:4300")).toBe(
      "http://demo:4000/articles/burr-basics?ref=1",
    );
  });

  it("ignores forwarding headers when the site origin is unknown", () => {
    const req = fakeReq({ host: "demo:4000", "x-forwarded-host": "localhost:4300" });
    expect(resourceUrl(req)).toBe("http://demo:4000/articles/burr-basics?ref=1");
  });
});
