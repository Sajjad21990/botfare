import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/* ReceiptVerifier imports through the "@/" alias, which the unit project does not resolve, so these
   checks read the sources the way verify-section and landing-links do. */
const src = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");
const verifier = src("components/verify/receipt-verifier.tsx");
const page = src("app/verify/page.tsx");

describe("/verify checks on demand", () => {
  it("verifies a ?receipt link on load but never the sample", () => {
    expect(verifier).toMatch(
      /useEffect\(\(\) => \{\s*if \(ran\.current \|\| !initialReceipt \|\| example\) return;/,
    );
    expect(page).toMatch(/const example = receipt \? null : await exampleReceiptId\(\);/);
    expect(page).toMatch(/initialReceipt=\{receipt \?\? example\}\s*example=\{example !== null\}/);
  });

  it("fills the input with the sample and says Verify checks it", () => {
    expect(verifier).toContain('useState(initialReceipt ?? "")');
    expect(verifier).toMatch(/input\.trim\(\) === sampleId/);
    expect(verifier).toMatch(/our demo recipe blog\. Press Verify to\s+check it\./);
  });

  it("keeps the sample at /verify so a reload shows it unchecked", () => {
    expect(verifier).toMatch(/options\.sample \? VERIFY_PATH : verifyHref\(receiptId\)/);
  });

  it("puts the Verify mark beside the page title", () => {
    expect(page).toMatch(/<h1[^>]*>\s*<VerifyMark className="size-10 sm:size-12" \/>/);
  });
});
