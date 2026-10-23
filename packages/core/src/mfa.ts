import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { transaction, type Sql } from "../../database/src/index.js";
import type { Config } from "./config.js";
import { Vault, hash, insist, verifyPassword } from "./security.js";
import { audit } from "./audit.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes: Buffer) {
  let bits = 0,
    value = 0,
    output = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function decode(secret: string) {
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const c of secret.replace(/=+$/, "")) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw Error("invalid_totp_secret");
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
/** RFC 6238 / RFC 4226, 30-second counter, 6 digits for authenticator compatibility. */
export function totp(secret: string, counter: number, digits = 6) {
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", decode(secret)).update(time).digest(),
    offset = mac[mac.length - 1] & 15;
  return String(
    (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits,
  ).padStart(digits, "0");
}
function matched(secret: string, code: string) {
  if (!/^\d{6}$/.test(code)) return -1;
  const now = Math.floor(Date.now() / 30000);
  for (const counter of [now, now - 1, now + 1])
    if (timingSafeEqual(Buffer.from(totp(secret, counter)), Buffer.from(code)))
      return counter;
  return -1;
}
export async function securityState(sql: Sql, actor: string) {
  const row = (
    await sql.query(
      "SELECT o.password_hash,o.enabled,m.secret FROM operators o LEFT JOIN operator_mfa m ON m.operator_id=o.id WHERE o.id=$1",
      [actor],
    )
  ).rows[0];
  return row
    ? {
        enabled: row.enabled,
        mfa: !!row.secret,
        fingerprint: hash(row.password_hash + ":" + (row.secret || "")),
      }
    : null;
}
async function consumeCode(
  db: pg.Pool,
  cfg: Config,
  actor: string,
  code: string,
  required: boolean,
) {
  return transaction(db, async (sql) => {
    const m = (
      await sql.query(
        "SELECT * FROM operator_mfa WHERE operator_id=$1 FOR UPDATE",
        [actor],
      )
    ).rows[0];
    if (!m?.secret) {
      insist(!required, 403, "mfa_enrollment_required");
      return false;
    }
    const secret = new Vault(cfg.encryptionKey).open<string>(
        m.secret,
        "mfa:" + actor,
      ),
      counter = matched(secret, code);
    if (counter >= 0) {
      insist(BigInt(counter) > BigInt(m.last_counter), 403, "mfa_code_reused");
      await sql.query(
        "UPDATE operator_mfa SET last_counter=$2 WHERE operator_id=$1",
        [actor, counter],
      );
    } else {
      const h = hash(code.replace(/\s/g, ""));
      insist(m.recovery_hashes.includes(h), 403, "mfa_invalid");
      await sql.query(
        "UPDATE operator_mfa SET recovery_hashes=array_remove(recovery_hashes,$2) WHERE operator_id=$1",
        [actor, h],
      );
      await audit(sql, null, actor, "auth.recovery_used", actor);
    }
    return true;
  });
}
export async function verifySecondFactor(
  db: pg.Pool,
  cfg: Config,
  actor: string,
  code: string,
  required = false,
) {
  return consumeCode(db, cfg, actor, code, required);
}
export async function reauthenticate(
  db: pg.Pool,
  cfg: Config,
  actor: string,
  password: string,
  code = "",
) {
  const locked = (
    await db.query(
      "SELECT 1 FROM security_failures WHERE operator_id=$1 AND locked_until>now()",
      [actor],
    )
  ).rowCount;
  insist(!locked, 429, "reauth_locked");
  const row = (
    await db.query(
      "SELECT o.password_hash,o.enabled,m.secret FROM operators o LEFT JOIN operator_mfa m ON m.operator_id=o.id WHERE o.id=$1",
      [actor],
    )
  ).rows[0];
  try {
    insist(
      row?.enabled && (await verifyPassword(password, row.password_hash)),
      403,
      "reauth_invalid",
    );
    const mfa = await consumeCode(db, cfg, actor, code, cfg.requireMfa);
    const current = await securityState(db, actor);
    insist(
      current?.enabled &&
        current.fingerprint ===
          hash(row.password_hash + ":" + (row.secret || "")),
      403,
      "operator_permission_changed",
    );
    await db.query("DELETE FROM security_failures WHERE operator_id=$1", [
      actor,
    ]);
    return { fingerprint: current.fingerprint, mfa };
  } catch (e) {
    await db.query(
      "INSERT INTO security_failures(operator_id,failures) VALUES($1,1) ON CONFLICT(operator_id) DO UPDATE SET failures=CASE WHEN security_failures.locked_until<now() THEN 1 ELSE security_failures.failures+1 END,locked_until=CASE WHEN security_failures.locked_until<now() THEN NULL WHEN security_failures.failures>=4 THEN now()+interval '15 minutes' ELSE security_failures.locked_until END",
      [actor],
    );
    await audit(db, null, actor, "auth.reauthentication_failed", actor);
    throw e;
  }
}
export async function beginMfa(
  db: pg.Pool,
  cfg: Config,
  actor: string,
  password: string,
  email: string,
) {
  insist(/^[a-f0-9]{64}$/i.test(cfg.encryptionKey), 503, "mfa_not_configured");
  const auth = await reauthenticate(
    db,
    { ...cfg, requireMfa: false },
    actor,
    password,
  );
  insist(!auth.mfa, 409, "mfa_already_enabled");
  const secret = base32(randomBytes(20)),
    vault = new Vault(cfg.encryptionKey);
  await transaction(db, async (sql) => {
    await sql.query("SELECT id FROM operators WHERE id=$1 FOR UPDATE", [actor]);
    insist(
      (await securityState(sql, actor))?.fingerprint === auth.fingerprint,
      409,
      "operator_permission_changed",
    );
    const old = (
      await sql.query("SELECT secret FROM operator_mfa WHERE operator_id=$1", [
        actor,
      ])
    ).rows[0];
    insist(!old?.secret, 409, "mfa_already_enabled");
    await sql.query(
      "INSERT INTO operator_mfa(operator_id,pending_secret,pending_until) VALUES($1,$2,now()+interval '10 minutes') ON CONFLICT(operator_id) DO UPDATE SET pending_secret=$2,pending_until=now()+interval '10 minutes'",
      [actor, vault.seal(secret, "mfa:" + actor)],
    );
    await audit(sql, null, actor, "auth.mfa_setup_started", actor);
  });
  return {
    secret,
    uri: `otpauth://totp/${encodeURIComponent("MiShu Trade:" + email)}?secret=${secret}&issuer=MiShu%20Trade&algorithm=SHA1&digits=6&period=30`,
  };
}
export async function confirmMfa(
  db: pg.Pool,
  cfg: Config,
  actor: string,
  code: string,
  keepSession?: string,
) {
  return transaction(db, async (sql) => {
    await sql.query("SELECT id FROM operators WHERE id=$1 FOR UPDATE", [actor]);
    const m = (
      await sql.query(
        "SELECT * FROM operator_mfa WHERE operator_id=$1 FOR UPDATE",
        [actor],
      )
    ).rows[0];
    insist(
      m?.pending_secret &&
        !m.secret &&
        new Date(m.pending_until).getTime() > Date.now(),
      409,
      "mfa_setup_expired",
    );
    const counter = matched(
      new Vault(cfg.encryptionKey).open<string>(
        m.pending_secret,
        "mfa:" + actor,
      ),
      code,
    );
    insist(counter >= 0, 403, "mfa_invalid");
    const recovery_codes = Array.from({ length: 10 }, () =>
      randomBytes(12).toString("hex"),
    );
    await sql.query(
      "UPDATE operator_mfa SET secret=pending_secret,pending_secret=NULL,pending_until=NULL,last_counter=$2,recovery_hashes=$3,updated_at=now() WHERE operator_id=$1",
      [actor, counter, recovery_codes.map(hash)],
    );
    await sql.query(
      "DELETE FROM sessions WHERE operator_id=$1 AND ($2::text IS NULL OR token_hash<>$2)",
      [actor, keepSession || null],
    );
    await audit(sql, null, actor, "auth.mfa_enabled", actor);
    return { recovery_codes };
  });
}
