// Selvtest av versjonssammenligningen: node scripts/test-version.mjs
import assert from "node:assert/strict";
import { compareVersions } from "../src/version.ts";

assert.ok(compareVersions("0.4.0", "0.3.0") > 0);
assert.ok(compareVersions("v0.10.0", "0.9.9") > 0);
assert.ok(compareVersions("1.0", "0.99.99") > 0);
assert.equal(compareVersions("v0.3.0", "0.3.0"), 0);
assert.equal(compareVersions("0.3", "0.3.0"), 0);
assert.ok(compareVersions("0.3.0", "0.3.1") < 0);
console.log("version: OK");
