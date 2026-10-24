#!/usr/bin/env node
/**
 * kiro-keys — manage Kiro API keys from the terminal.
 *
 * Exists because the Kiro dashboard's key management is broken. Uses your
 * kiro-cli SSO login, which is the *only* credential that can manage keys:
 * an API key cannot mint or list its siblings ("Unsupported token type"),
 * so this is also the bootstrap path for a machine with no key yet.
 *
 *   node kiro-keys.mjs list
 *   node kiro-keys.mjs create <label>
 *   node kiro-keys.mjs delete <keyId>
 *
 * Requires kiro-cli to be installed and logged in (`kiro-cli login`).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const REGION = process.env.KIRO_REGION ?? "us-east-1";
const MANAGEMENT = `https://management.${REGION}.kiro.dev/`;
const USER_AGENT =
  "aws-sdk-js/1.0.0 KiroCLI/2.21.4 KAS/0.63.3 os/windows md/appVersion-2.21.4 app/AmazonQ-For-CLI";

const DB_CANDIDATES = [
  process.env.KIRO_DB,
  join(homedir(), "AppData/Local/kiro-cli/data.sqlite3"),
  join(homedir(), ".local/share/kiro-cli/data.sqlite3"),
  join(homedir(), "Library/Application Support/kiro-cli/data.sqlite3"),
].filter(Boolean);

function readToken() {
  const path = DB_CANDIDATES.find(existsSync);
  if (!path) throw new Error("kiro-cli store not found. Install kiro-cli and run `kiro-cli login`.");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("select value from auth_kv where key = 'kirocli:odic:token'").get();
    if (!row) throw new Error("Not logged in. Run `kiro-cli login`.");
    return JSON.parse(row.value);
  } finally {
    db.close();
  }
}

/** SSO tokens last ~1h; kiro-cli owns refresh, so let it do the work. */
function ssoToken() {
  let token = readToken();
  if (Date.parse(token.expires_at) - Date.now() < 60_000) {
    try {
      execFileSync("kiro-cli", ["whoami"], { stdio: "ignore", timeout: 30_000 });
      token = readToken();
    } catch {
      /* fall through to the expiry check */
    }
  }
  if (Date.parse(token.expires_at) <= Date.now()) throw new Error("Token expired. Run `kiro-cli login`.");
  return token.access_token;
}

async function rpc(operation, body) {
  const response = await fetch(MANAGEMENT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ssoToken()}`,
      TokenType: "SSO_OIDC",
      "content-type": "application/x-amz-json-1.0",
      "x-amz-target": `KiroControlPlaneBearerService.${operation}`,
      "User-Agent": USER_AGENT,
      "x-amz-user-agent": USER_AGENT,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} ${response.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function profileArn() {
  if (process.env.KIRO_PROFILE_ARN) return process.env.KIRO_PROFILE_ARN;
  const { profiles } = await rpc("ListAvailableProfiles", {});
  if (!profiles?.length) throw new Error("No profiles available for this account.");
  return profiles[0].arn;
}

const date = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") : "-");

const [command, argument] = process.argv.slice(2);

try {
  if (command === "list") {
    const { keys = [] } = await rpc("ListApiKeys", { profileArn: await profileArn() });
    if (!keys.length) {
      console.log("No API keys.");
    } else {
      console.log(["KEY ID".padEnd(40), "PREFIX".padEnd(14), "LABEL".padEnd(22), "CREATED".padEnd(17), "LAST USED"].join(""));
      for (const key of keys) {
        console.log(
          [
            (key.keyId ?? "-").padEnd(40),
            (key.keyPrefix ?? "-").padEnd(14),
            (key.label ?? "-").padEnd(22),
            date(key.createdAt).padEnd(17),
            date(key.lastUsedAt),
          ].join(""),
        );
      }
    }
  } else if (command === "create") {
    if (!argument) throw new Error("usage: create <label>");
    const key = await rpc("CreateApiKey", { profileArn: await profileArn(), label: argument });
    console.log(`\n  ${key.rawKey}\n`);
    console.log(`keyId: ${key.keyId}`);
    console.log("This is the only time the key is shown. Save it now, e.g. set KIRO_API_KEY.");
  } else if (command === "delete") {
    if (!argument) throw new Error("usage: delete <keyId>");
    await rpc("DeleteApiKey", { profileArn: await profileArn(), keyId: argument });
    console.log(`Deleted ${argument}`);
  } else {
    console.log("usage: kiro-keys.mjs list | create <label> | delete <keyId>");
    process.exit(1);
  }
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
