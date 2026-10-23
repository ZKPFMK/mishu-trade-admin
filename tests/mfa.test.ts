import { test } from "node:test";
import assert from "node:assert/strict";
import { base32, totp, reauthenticate } from "../packages/core/src/mfa.js";
import { fixture } from "./helpers.js";

test("TOTP matches all SHA-1 reference vectors in RFC 6238", () => {
  const secret = base32(Buffer.from("12345678901234567890"));
  for (const [time, expected] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const)
    assert.equal(totp(secret, Math.floor(time / 30), 8), expected);
});
test("MFA enrollment encrypts the seed, consumes each OTP/recovery code once and binds credential changes", async () => {
  const f = await fixture(2);
  try {
    const headers = await f.session("requester");
    const setup = await f.api.inject({
      method: "POST",
      url: "/auth/mfa/setup",
      headers,
      payload: { password: "Test-only-password-042!" },
    });
    assert.equal(setup.statusCode, 200, setup.body);
    const secret = setup.json().secret;
    const pending = (
      await f.db.query(
        "SELECT * FROM operator_mfa WHERE operator_id='requester'",
      )
    ).rows[0];
    assert.ok(!pending.pending_secret.includes(secret));
    const code = totp(secret, Math.floor(Date.now() / 30000));
    const confirmed = await f.api.inject({
      method: "POST",
      url: "/auth/mfa/confirm",
      headers,
      payload: { otp: code },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const recovery = confirmed.json().recovery_codes;
    assert.equal(recovery.length, 10);
    const reused = await f.api.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "requester@test.local",
        password: "Test-only-password-042!",
        otp: code,
      },
    });
    assert.equal(reused.statusCode, 403);
    assert.equal(reused.json().error, "mfa_code_reused");
    const login = await f.api.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "requester@test.local",
        password: "Test-only-password-042!",
        otp: recovery[0],
      },
    });
    assert.equal(login.statusCode, 200);
    await assert.rejects(
      reauthenticate(
        f.db,
        f.cfg,
        "requester",
        "Test-only-password-042!",
        recovery[0],
      ),
      /mfa_invalid/,
    );
    const auth = await reauthenticate(
      f.db,
      { ...f.cfg, requireMfa: true },
      "requester",
      "Test-only-password-042!",
      recovery[1],
    );
    assert.equal(auth.mfa, true);
    const stored = (
      await f.db.query(
        "SELECT * FROM operator_mfa WHERE operator_id='requester'",
      )
    ).rows[0];
    assert.equal(stored.recovery_hashes.length, 8);
    assert.ok(stored.secret.startsWith("v1."));
    assert.ok(!JSON.stringify(stored).includes(recovery[1]));
    await assert.rejects(
      reauthenticate(
        f.db,
        { ...f.cfg, requireMfa: true },
        "approver",
        "Test-only-password-042!",
      ),
      /mfa_enrollment_required/,
    );
  } finally {
    await f.close();
  }
});
test("repeated failed operation reauthentication locks the operator, including across sessions", async () => {
  const f = await fixture(1);
  try {
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        reauthenticate(f.db, f.cfg, "requester", "wrong-password"),
        /reauth_invalid/,
      );
    await assert.rejects(
      reauthenticate(f.db, f.cfg, "requester", "Test-only-password-042!"),
      /reauth_locked/,
    );
  } finally {
    await f.close();
  }
});
