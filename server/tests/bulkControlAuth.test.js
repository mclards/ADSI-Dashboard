"use strict";

const assert = require("assert");
const {
  getPlantWideAuthKeys,
  isValidPlantWideAuthKey,
  issuePlantWideAuthSession,
  isValidPlantWideAuthSession,
  __resetForTests,
} = require("../bulkControlAuth");

function run() {
  const base = Date.parse("2026-03-13T12:05:30.000Z");

  __resetForTests();
  {
    const keys = [...getPlantWideAuthKeys(base)];
    assert.deepEqual(keys.sort(), ["sacups04", "sacups05"]);
    assert.equal(isValidPlantWideAuthKey("sacups05", base), true);
    assert.equal(isValidPlantWideAuthKey("sacups04", base), true);
    assert.equal(isValidPlantWideAuthKey("sacups03", base), false);
  }

  __resetForTests();
  {
    assert.equal(isValidPlantWideAuthKey("sacups05", base), true);
    assert.equal(
      isValidPlantWideAuthKey("sacups05", base + 5 * 60 * 1000),
      true,
    );
    assert.equal(
      isValidPlantWideAuthKey("sacups05", base + 11 * 60 * 1000),
      false,
    );
  }

  __resetForTests();
  {
    const session = issuePlantWideAuthSession(base);
    assert.equal(
      isValidPlantWideAuthSession(session.token, base + 2 * 60 * 1000),
      true,
    );
    assert.equal(
      isValidPlantWideAuthSession(session.token, base + 11 * 60 * 1000),
      false,
    );
  }

  console.log("bulkControlAuth.test.js: PASS");
}

run();
