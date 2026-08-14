import assert from "node:assert/strict";
import test from "node:test";
import { missingScopes, scopeCapabilities, SPOTIFY_SCOPES } from "./scopes";

test("scope capabilities degrade independently", () => {
  const capabilities = scopeCapabilities("user-library-read user-top-read");
  assert.equal(capabilities.libraryRead, true);
  assert.equal(capabilities.topItems, true);
  assert.equal(capabilities.playback, false);
  assert.equal(capabilities.libraryWrite, false);
});

test("a complete grant reports no missing scopes", () => {
  assert.deepEqual(missingScopes(SPOTIFY_SCOPES.join(" ")), []);
});
