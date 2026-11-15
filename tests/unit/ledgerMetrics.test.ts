import { describe, expect, it } from "vitest";
import { buildCatalogue } from "../../src/lib/tailoring/catalogue";
import { validateOutreachText } from "../../src/lib/tailoring/validate";
import { emailBlockers } from "../../convex/roles";

/**
 * Ledger numbers an email may use must pass the server's truthfulness check
 * before a Gmail draft is made. 400K, 70% and 500K were missing once, and every
 * email that used them was held.
 */
describe("ledger metrics in emails", () => {
  const catalogue = buildCatalogue();
  const allowed = [
    "At Roomvu I owned the frontend for Listing Videos on a platform with roughly 400K paid users.",
    "Patients pay before they book and doctors get roughly 70% in an in-app wallet.",
    "Top Menu serves 400+ restaurants and about 500K visits a month.",
    "Patient registration went from below 10% to above 40%.",
  ];
  for (const body of allowed) {
    it(`passes: ${body.slice(0, 40)}...`, () => {
      expect(emailBlockers(body, validateOutreachText({ body, factIds: [] }, catalogue).violations)).toEqual([]);
    });
  }

  it("still blocks a retired number", () => {
    const body = "At Roomvu the platform had 1M+ active users and I cut deploy time by 60%.";
    expect(emailBlockers(body, validateOutreachText({ body, factIds: [] }, catalogue).violations).length).toBeGreaterThan(0);
  });
});
