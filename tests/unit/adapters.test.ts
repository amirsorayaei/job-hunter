import { describe, expect, it } from "vitest";
import { ADAPTERS, adapterFor } from "@/lib/sources/adapters";
import type { AtsProvider } from "@/lib/sources/types";

/**
 * ATS adapter fixtures.
 *
 * Spec 9: "Each has recorded fixture tests for pagination, empty boards,
 * malformed data, timeout, redirects, 404, 429, 5xx, partial completion, and
 * schema drift. Live network is not required for test success."
 *
 * The transport failures (timeout / 404 / 429 / 5xx / redirects) are the
 * caller's concern — they never reach `parse`, and are covered by the liveness
 * tests, which prove a non-complete run cannot close a job. What is tested here
 * is everything a parser can get wrong on a payload it *did* receive.
 */

const CTX = { slug: "acme", companyName: "Acme" };
const ALL = Object.keys(ADAPTERS) as AtsProvider[];

/** A payload of the right outer shape but with zero jobs, per provider. */
const EMPTY_PAYLOAD: Record<AtsProvider, unknown> = {
  greenhouse: { jobs: [] },
  lever: [],
  ashby: { jobs: [] },
  smartrecruiters: { content: [], offset: 0, totalFound: 0 },
  recruitee: { offers: [] },
  workable: { jobs: [] },
  personio: '<?xml version="1.0"?><workzag-jobs></workzag-jobs>',
};

/** A payload whose shape is unrecognizable, per provider. */
const GARBAGE_PAYLOAD: Record<AtsProvider, unknown> = {
  greenhouse: { unexpected: true },
  lever: { notAnArray: true },
  ashby: { postings: [] },
  smartrecruiters: { results: [] },
  recruitee: { jobs: [] },
  workable: { offers: [] },
  personio: "<html><body>Not a job feed</body></html>",
};

describe("every adapter", () => {
  it("treats an empty board as an authoritative complete result", () => {
    // This is the ONLY shape allowed to eventually close jobs.
    for (const provider of ALL) {
      const result = adapterFor(provider).parse(EMPTY_PAYLOAD[provider], CTX);
      expect(result.jobs, provider).toHaveLength(0);
      expect(result.result.outcome, provider).toBe("complete");
      expect(result.result.authoritativeEmpty, provider).toBe(true);
    }
  });

  it("treats schema drift as failed, never as an empty board", () => {
    // Phase 2 criterion 2. If drift produced authoritativeEmpty, a provider
    // changing its response shape would close every job for that company.
    for (const provider of ALL) {
      const result = adapterFor(provider).parse(GARBAGE_PAYLOAD[provider], CTX);
      expect(result.result.outcome, provider).toBe("failed");
      expect(result.result.authoritativeEmpty, provider).toBe(false);
      expect(result.result.termination, provider).toContain("schema drift");
    }
  });

  it("never throws on hostile input", () => {
    for (const provider of ALL) {
      for (const input of [null, undefined, 0, "", [], {}, { jobs: null }, [null]]) {
        expect(() => adapterFor(provider).parse(input, CTX), provider).not.toThrow();
      }
    }
  });

  it("builds a listing URL that escapes the slug", () => {
    for (const provider of ALL) {
      const url = adapterFor(provider).listUrl("a b/c");
      expect(url, provider).not.toContain(" ");
      expect(url.startsWith("https://"), provider).toBe(true);
    }
  });
});

describe("greenhouse", () => {
  it("normalizes a job and strips HTML", () => {
    const { jobs, result } = adapterFor("greenhouse").parse(
      {
        jobs: [
          {
            id: 4444,
            title: "Senior Frontend Engineer",
            absolute_url: "https://boards.greenhouse.io/acme/jobs/4444",
            location: { name: "Amsterdam, Netherlands" },
            content: "<p>Build <b>things</b>.</p><p>Remote friendly.</p>",
            updated_at: "2026-08-01T10:00:00Z",
          },
        ],
      },
      CTX,
    );

    expect(result.outcome).toBe("complete");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].externalId).toBe("4444");
    expect(jobs[0].locations).toEqual([{ city: "Amsterdam", country: "Netherlands" }]);
    expect(jobs[0].descriptionText).toContain("Build things.");
    expect(jobs[0].descriptionText).not.toContain("<b>");
    // Location decides, not the JD: "Remote friendly" in a JD for an Amsterdam
    // office role is usually hybrid, and read as remote it flooded the queue.
    expect(jobs[0].workplaceType).toBe("unknown");
    expect(jobs[0].stableLocator).toBe("greenhouse:acme:4444");
  });

  it("skips malformed items and counts them, keeping the good ones", () => {
    const { jobs, result } = adapterFor("greenhouse").parse(
      {
        jobs: [
          { id: 1, title: "Good", absolute_url: "https://x.test/1" },
          { id: 2 }, // no title or url
          "not an object",
        ],
      },
      CTX,
    );

    expect(jobs).toHaveLength(1);
    expect(result.malformedItemCount).toBe(2);
    expect(result.rawItemCount).toBe(3);
    // Partial garbage is still a complete listing, but not an empty board.
    expect(result.outcome).toBe("complete");
    expect(result.authoritativeEmpty).toBe(false);
  });
});

describe("lever", () => {
  it("normalizes a bare array and derives an apply url", () => {
    const { jobs } = adapterFor("lever").parse(
      [
        {
          id: "abc-123",
          text: "Frontend Engineer",
          hostedUrl: "https://jobs.lever.co/acme/abc-123",
          categories: { location: "Berlin, Germany", commitment: "Full-time" },
          descriptionPlain: "Do frontend work.",
          createdAt: 1786000000000,
        },
      ],
      CTX,
    );

    expect(jobs[0].applyUrl).toBe("https://jobs.lever.co/acme/abc-123/apply");
    expect(jobs[0].employmentType).toBe("Full-time");
    expect(jobs[0].locations).toEqual([{ city: "Berlin", country: "Germany" }]);
    expect(jobs[0].postedAt).toBe(new Date(1786000000000).toISOString());
  });
});

describe("smartrecruiters pagination", () => {
  it("returns a cursor when more pages remain, and is partial", () => {
    const page = adapterFor("smartrecruiters").parse(
      {
        offset: 0,
        totalFound: 150,
        content: Array.from({ length: 100 }, (_, i) => ({
          id: `job-${i}`,
          name: `Role ${i}`,
          location: { city: "Madrid", country: "Spain" },
        })),
      },
      CTX,
    );

    expect(page.jobs).toHaveLength(100);
    expect(page.result.nextCursor).toBe("100");
    // A page boundary is NOT a complete listing — absence here proves nothing.
    expect(page.result.outcome).toBe("partial");
    expect(page.result.authoritativeEmpty).toBe(false);
  });

  it("has no cursor on the final page", () => {
    const page = adapterFor("smartrecruiters").parse(
      {
        offset: 100,
        totalFound: 150,
        content: Array.from({ length: 50 }, (_, i) => ({
          id: `job-${i}`,
          name: `Role ${i}`,
          location: {},
        })),
      },
      CTX,
    );

    expect(page.result.nextCursor).toBeUndefined();
    expect(page.result.outcome).toBe("complete");
  });

  it("advances the offset in the listing url", () => {
    expect(adapterFor("smartrecruiters").listUrl("acme", "100")).toContain("offset=100");
    expect(adapterFor("smartrecruiters").listUrl("acme")).toContain("offset=0");
  });
});

describe("ashby", () => {
  it("trusts the explicit isRemote flag over text inference", () => {
    const { jobs } = adapterFor("ashby").parse(
      {
        jobs: [
          {
            id: "j1",
            title: "Engineer",
            jobUrl: "https://jobs.ashbyhq.com/acme/j1",
            location: "London",
            isRemote: true,
          },
        ],
      },
      CTX,
    );
    expect(jobs[0].workplaceType).toBe("remote");
  });
});

describe("recruitee", () => {
  it("joins city and country into a location tuple", () => {
    const { jobs } = adapterFor("recruitee").parse(
      {
        offers: [
          {
            id: 77,
            title: "Frontend Developer",
            careers_url: "https://acme.recruitee.com/o/frontend",
            city: "Lisbon",
            country: "Portugal",
            description: "<p>Work</p>",
          },
        ],
      },
      CTX,
    );
    expect(jobs[0].locations).toEqual([{ city: "Lisbon", country: "Portugal" }]);
    expect(jobs[0].externalId).toBe("77");
  });
});

describe("workable", () => {
  it("uses the shortcode as the external id", () => {
    const { jobs } = adapterFor("workable").parse(
      {
        jobs: [
          {
            shortcode: "ABC123",
            title: "Engineer",
            url: "https://apply.workable.com/acme/j/ABC123",
            city: "Munich",
            country: "Germany",
            telecommuting: true,
          },
        ],
      },
      CTX,
    );
    expect(jobs[0].externalId).toBe("ABC123");
    expect(jobs[0].workplaceType).toBe("remote");
  });
});

describe("personio", () => {
  it("parses XML positions and unwraps CDATA", () => {
    const xml = `<?xml version="1.0"?>
      <workzag-jobs>
        <position>
          <id>9001</id>
          <name><![CDATA[Senior Frontend Engineer]]></name>
          <office>Berlin</office>
          <employmentType>permanent</employmentType>
          <jobDescriptions><![CDATA[<p>Build the UI</p>]]></jobDescriptions>
        </position>
      </workzag-jobs>`;

    const { jobs, result } = adapterFor("personio").parse(xml, CTX);
    expect(result.outcome).toBe("complete");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe("Senior Frontend Engineer");
    expect(jobs[0].externalId).toBe("9001");
    expect(jobs[0].descriptionText).toBe("Build the UI");
    expect(jobs[0].locations).toEqual([{ city: "Berlin" }]);
  });

  it("reports drift on an HTML error page rather than an empty board", () => {
    // A captive portal or error page must not read as "no jobs".
    const { result } = adapterFor("personio").parse(
      "<html><body>502 Bad Gateway</body></html>",
      CTX,
    );
    expect(result.outcome).toBe("failed");
    expect(result.authoritativeEmpty).toBe(false);
  });

  it("counts a position with no name as malformed", () => {
    const xml = `<workzag-jobs><position><id>1</id></position></workzag-jobs>`;
    const { jobs, result } = adapterFor("personio").parse(xml, CTX);
    expect(jobs).toHaveLength(0);
    expect(result.malformedItemCount).toBe(1);
    // Malformed items present means this is not an authoritative empty board.
    expect(result.authoritativeEmpty).toBe(false);
  });
});
