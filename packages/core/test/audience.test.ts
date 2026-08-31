import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodePin, decodeZone, type WirePin, type WireZone } from "../src/domain/types.js";

/**
 * These cover the client's handling of the audience field only.
 *
 * The visibility RULES themselves live in `soso.can_see_post` in the database
 * and are deliberately not reimplemented here: a client-side copy of an access
 * control rule is a copy that can drift out of sync with the one that actually
 * enforces anything. What the client must get right is not deciding who may
 * see a post, but correctly representing what the server already decided.
 */

const basePin: WirePin = {
  i: "post-1",
  c: "incident",
  s: null,
  g: [139.7671, 35.6812],
  t: 1_800_000_000,
  x: 1_800_003_600,
  n: 0,
  m: false,
};

describe("pin audience decoding", () => {
  it("leaves audience undefined for a public post", () => {
    // The server omits the field entirely for public posts to keep the
    // viewport payload small, so absence must mean public, not unknown.
    const pin = decodePin(basePin);
    assert.equal(pin.audience, undefined);
  });

  it("carries a private audience through", () => {
    for (const audience of ["friends", "close_friends", "custom"] as const) {
      const pin = decodePin({ ...basePin, a: audience });
      assert.equal(pin.audience, audience);
    }
  });

  it("treats an explicit null as public rather than as a private marker", () => {
    // PostgREST can serialise the absent case as null rather than omitting it.
    // Getting this wrong would badge every public pin as private.
    const pin = decodePin({ ...basePin, a: null });
    assert.equal(pin.audience, undefined);
  });

  it("does not disturb the rest of the pin", () => {
    const pin = decodePin({ ...basePin, a: "friends" });
    assert.equal(pin.id, "post-1");
    assert.equal(pin.category, "incident");
    assert.equal(pin.lng, 139.7671);
    assert.equal(pin.expiresAt, 1_800_003_600);
  });
});

describe("zone decoding", () => {
  const wire: WireZone = {
    id: "zone-1",
    name: "Shibuya crew",
    lng: 139.7016,
    lat: 35.658,
    radius_m: 800,
    audience: "close_friends",
    members: 4,
  };

  it("maps snake_case wire fields to the domain shape", () => {
    const zone = decodeZone(wire);
    assert.equal(zone.radiusM, 800);
    assert.equal(zone.audience, "close_friends");
    assert.equal(zone.members, 4);
    assert.equal(zone.name, "Shibuya crew");
  });

  it("coerces coordinates to numbers", () => {
    // PostGIS numerics can arrive as strings through PostgREST; a string
    // longitude would silently break every distance comparison downstream.
    const zone = decodeZone({ ...wire, lng: "139.7016" as unknown as number });
    assert.equal(typeof zone.lng, "number");
    assert.equal(zone.lng, 139.7016);
  });
});
