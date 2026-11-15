import { describe, expect, it } from "vitest";

import * as entry from "../src/index";

// workerd accepts only a function, a class or an ExportedHandler as a named
// export of the Worker entry. Another kind of value (a string constant, for
// example) stops the runtime at startup. The test pool loads the entry as a
// plain module and does not apply that rule, so without this test only
// `wrangler dev` or a deploy shows the error.
describe("Worker entry exports", () => {
  it("has only functions and classes as named exports", () => {
    const named = Object.entries(entry).filter(([name]) => name !== "default");
    // The CoachStore class is always there: an empty list means the import broke.
    expect(named.map(([name]) => name)).toContain("CoachStore");

    const refused = named.filter(([, value]) => typeof value !== "function").map(([name]) => name);
    expect(refused).toEqual([]);
  });

  it("has the handler object as the default export", () => {
    expect(typeof entry.default).toBe("object");
    expect(typeof entry.default.fetch).toBe("function");
  });
});
