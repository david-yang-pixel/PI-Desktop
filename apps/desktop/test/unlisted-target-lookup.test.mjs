import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { unlistedBranchQuery, unlistedRepositoryQuery } = await import(
  "../src/features/chat/session-target/unlisted-target-lookup.ts"
);

// The pickers ask GitHub for one exact name only when the search names it and
// the loaded (capped) list does not already have it.

const repo = (fullName) => {
  const [owner, name] = fullName.split("/");
  return { owner, name, fullName, private: false, defaultBranch: "main", archived: false };
};

test("an exact owner/name that the list lacks is looked up", () => {
  const listed = [repo("octo/app"), repo("octo/docs")];
  assert.deepEqual(unlistedRepositoryQuery(" big-org/hidden.repo ", listed), { owner: "big-org", name: "hidden.repo" });
  assert.equal(unlistedRepositoryQuery("OCTO/App", listed), null, "already listed, compared like GitHub, without case");
  for (const query of ["", "octo", "octo/", "/app", "octo/app/extra", "octo app/x", "-octo/app", "octo/..", "octo/app.git"]) {
    assert.equal(unlistedRepositoryQuery(query, listed), null, query);
  }
  assert.equal(unlistedRepositoryQuery("big-org/hidden", undefined), null, "nothing is looked up before the list loads");
});

test("an exact branch name that the list lacks is looked up", () => {
  const listed = [{ name: "main", protected: true }, { name: "release/1", protected: false }];
  assert.equal(unlistedBranchQuery(" release/2026.11 ", listed), "release/2026.11");
  assert.equal(unlistedBranchQuery("main", listed), null);
  assert.equal(unlistedBranchQuery("Main", listed), "Main", "branch names are case-sensitive");
  for (const query of ["", "  ", "a..b", "feature branch", "-x", "@", "x.lock"]) {
    assert.equal(unlistedBranchQuery(query, listed), null, query);
  }
  assert.equal(unlistedBranchQuery("develop", undefined), null);
});
