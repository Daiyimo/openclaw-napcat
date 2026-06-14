#!/usr/bin/env node
// fix-cron.cjs — Repair existing OpenClaw cron jobs for NapCat direct delivery.
//
// Per-job fixes:
//   1. delivery.mode = "none"  (skip OpenClaw fallback delivery)
//   2. payload = { kind: "command", argv: [sh, -lc, <script>] }
//        The script reads $HA_TOKEN from env and calls NapCat directly.
//   3. Full HA token injected via --command-env HA_TOKEN=<full_token>
//
// Uses `openclaw cron edit` CLI for all mutations.
// Idempotent: safe to re-run.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ─── Config resolution ─────────────────────────────────────────────────────

/** Find the active openclaw.json, checking env override then common paths. */
function findConfigPath() {
  const override = process.env.OPENCLAW_CONFIG?.trim();
  if (override && fs.existsSync(override)) return override;

  const home = process.env.HOME || "/root";
  const candidates = [
    path.join(home, ".openclaw", "openclaw.json"),
    "/root/.openclaw/openclaw.json",
    "/home/node/.openclaw/openclaw.json",
    "/home/openclaw/.openclaw/openclaw.json",
    "/etc/openclaw/openclaw.json",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    "Cannot find openclaw.json. Set OPENCLAW_CONFIG env var to its path."
  );
}

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/** Walk config to find a long JWT-looking HA token. */
function extractHaToken(config) {
  const search = (obj, depth = 0) => {
    if (depth > 8 || !obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = search(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    for (const v of Object.values(obj)) {
      if (
        typeof v === "string" &&
        v.length > 40 &&
        /^[A-Za-z0-9_\-]+$/.test(v) &&
        v.startsWith("eyJ")
      ) {
        return v;
      }
      const found = search(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return search(config);
}

function findNapcatEndpoint(config) {
  const entry = config?.plugins?.entries?.napcat;
  if (!entry) return { host: "127.0.0.1", port: 3000 };
  const c = entry.config ?? entry;
  return {
    host: c.host ?? c.napcatHost ?? "127.0.0.1",
    port: c.port ?? c.napcatPort ?? 3000,
  };
}

function findHaEndpoint(config) {
  // Look for HA base_url in config
  const search = (obj, depth = 0) => {
    if (depth > 8 || !obj || typeof obj !== "object") return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = search(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof obj.base_url === "string") return obj.base_url;
    for (const v of Object.values(obj)) {
      const found = search(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const baseUrl = search(config);
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      return { host: u.hostname, port: parseInt(u.port) || 8123 };
    } catch { /* fall through */ }
  }
  return { host: process.env.HA_HOST ?? "127.0.0.1", port: parseInt(process.env.HA_PORT ?? "8123", 10) };
}

// ─── CLI execution ─────────────────────────────────────────────────────────

function findCliBin() {
  const candidates = [
    process.env.OPENCLAW_BIN?.trim(),
    path.join(process.env.HOME || "/root", ".local", "bin", "openclaw"),
    "/usr/local/bin/openclaw",
    "/usr/bin/openclaw",
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return "openclaw"; // rely on PATH
}

/** Run openclaw CLI with OPENCLAW_CONFIG set so it finds the gateway. */
function runCli(args) {
  const bin = findCliBin();
  const env = { ...process.env };
  const configPath = findConfigPath();
  env.OPENCLAW_CONFIG = configPath;
  const stateDir = path.join(path.dirname(configPath), "..");
  if (!env.OPENCLAW_STATE_DIR) env.OPENCLAW_STATE_DIR = stateDir;

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`CLI exit ${code}: ${stderr || stdout}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
    proc.on("error", (e) => reject(e));
  });
}

// ─── Build the replacement command script ──────────────────────────────────

/**
 * Build the shell one-liner that:
 *   1. Reads $HA_TOKEN (from cron env)
 *   2. Calls HA API to fetch electricity data
 *   3. Formats the report text
 *   4. Sends via NapCat send_group_msg HTTP API
 */
function buildCommandScript(haHost, haPort, napcatHost, napcatPort, groupId) {
  // Using escaped double-quotes for JSON payload inside sh -lc
  const haUrl = `http://${haHost}:${haPort}/api/services/recorder/get_significant_statistics`;
  const ncUrl = `http://${napcatHost}:${napcatPort}/send_group_msg`;

  return [
    `sh`, `-lc`,
    [
      // Fetch HA electricity data
      `RESP=$(curl -s -X POST "${haUrl}" \\`,
      `  -H "Authorization: Bearer $HA_TOKEN" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"statistic_ids":["sensor.xiaoxin_0002_electricity_charging"],"period":{"start":"now()-24h","end":"now()"}}' 2>/dev/null)`,
      ``,
      // Build summary
      `SUMMARY="📊 电费水费报告\\n\\n"`,
      `if [ -n "$RESP" ]; then SUMMARY="$SUMMARY$RESP"; fi`,
      ``,
      // Send to QQ group via NapCat
      `curl -s -X POST "${ncUrl}" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d "{\\"group_id\\":${groupId},\\"message\\":[{\\"type\\":\\"text\\",\\"data\\":{\\"text\\":\\"$SUMMARY\\"}}]}" > /dev/null`,
      `echo "done"`,
    ].join(" "),
  ];
}

// ─── Edit a single cron job ────────────────────────────────────────────────

async function fixOneJob(jobId, jobName, haToken, haEndpoint, ncEndpoint, groupId) {
  const argv = buildCommandScript(
    haEndpoint.host, haEndpoint.port,
    ncEndpoint.host, ncEndpoint.port,
    groupId
  );

  console.log(`\n  [${jobName}]`);
  console.log(`    id: ${jobId.slice(0, 8)}…`);
  console.log(`    napcat: ${ncEndpoint.host}:${ncEndpoint.port}`);
  console.log(`    ha: ${haEndpoint.host}:${haEndpoint.port}`);
  console.log(`    token: ${haToken.slice(0, 10)}…${haToken.slice(-6)} (${haToken.length}c)`);

  try {
    const args = [
      "cron", "edit", jobId,
      "--no-deliver",
      `--command-argv`, JSON.stringify(argv),
      `--command-env`, `HA_TOKEN=${haToken}`,
      `--timeout-seconds`, "120",
    ];

    const { stdout } = await runCli(args);

    // Detect success — cron.edit prints "cron: job updated…" or the new job JSON
    if (
      stdout.includes("job updated") ||
      stdout.includes('"id"') ||
      stdout.includes("ok") ||
      stdout.length < 50 // short output = success (just "cron: job updated")
    ) {
      console.log(`    ✓ patched (delivery=none, command+curl, env HA_TOKEN injected)`);
      return true;
    }

    // Unexpected output
    console.log(`    ⚠ unexpected output: ${stdout.slice(0, 200)}`);
    return false;
  } catch (err) {
    console.log(`    ✗ failed: ${err.message.slice(0, 200)}`);
    if (err.stdout) console.log(`       stdout: ${err.stdout.slice(0, 200)}`);
    if (err.stderr) console.log(`       stderr: ${err.stderr.slice(0, 200)}`);
    return false;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== fix-cron: Repair NapCat cron jobs ===\n");

  // Resolve config
  const configPath = findConfigPath();
  console.log(`Config: ${configPath}`);
  const config = loadConfig(configPath);

  // Extract HA token (the full, non-truncated one from config)
  const haToken = extractHaToken(config);
  if (!haToken) {
    console.error("ERROR: Cannot find HA token in config.");
    process.exit(1);
  }
  console.log(
    `HA token: ${haToken.slice(0, 10)}…${haToken.slice(-8)} (${haToken.length} chars)`
  );

  // NapCat and HA endpoints
  const nc = findNapcatEndpoint(config);
  const ha = findHaEndpoint(config);
  console.log(`NapCat:  ${nc.host}:${nc.port}`);
  console.log(`HA:      ${ha.host}:${ha.port}`);

  // Verify CLI works
  try {
    const { stdout } = await runCli(["--version"]);
    console.log(`CLI:     ${stdout.split("\n")[0]}`);
  } catch (err) {
    console.error(`ERROR: Cannot run openclaw CLI: ${err.message}`);
    process.exit(1);
  }

  // List cron jobs
  console.log("\nListing cron jobs…");
  let jobs;
  try {
    const { stdout } = await runCli(["cron", "list", "--json"]);
    const parsed = JSON.parse(stdout);
    jobs = parsed.jobs || (Array.isArray(parsed) ? parsed : []);
  } catch {
    // Fallback: try gateway RPC
    try {
      const { default: { WebSocket } } = require("ws");
      const stateDir = path.join(path.dirname(configPath), "..");
      const authPath = path.join(stateDir, "identity", "device-auth.json");
      let authToken = null;
      try {
        const authData = JSON.parse(fs.readFileSync(authPath, "utf8"));
        authToken = authData.token ?? authData.accessToken ?? Object.values(authData)[0];
      } catch { /* no auth file */ }

      const wsUrl = `ws://127.0.0.1:${config?.gateway?.port || 18789}`;
      // Use a simple inline gateway call
      const result = await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
        });
        const msgId = `list-${Date.now()}`;
        let done = false;
        const timer = setTimeout(() => {
          if (!done) { done = true; ws.close(); reject(new Error("timeout")); }
        }, 15000);
        ws.on("message", (e) => {
          try {
            const msg = JSON.parse(e.data.toString());
            if (msg.id === msgId) {
              done = true;
              clearTimeout(timer);
              ws.close();
              resolve(msg.result);
            }
          } catch { /* ignore */ }
        });
        ws.on("open", () => ws.send(JSON.stringify({ id: msgId, method: "cron.list", params: { includeDisabled: true, limit: 200 } })));
        ws.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
      });
      jobs = result.jobs || [];
    } catch (e) {
      console.error("ERROR: Cannot list cron jobs:", e.message);
      process.exit(1);
    }
  }

  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.log("No cron jobs found. Nothing to fix.");
    return;
  }

  console.log(`\nFound ${jobs.length} cron job(s):\n`);
  for (const j of jobs) {
    const d = j.delivery?.mode || "(default)";
    const p = j.payload?.kind || "(unknown)";
    console.log(`  ${j.id?.slice(0, 8) ?? "?"}…  "${j.name}"  delivery=${d}  payload=${p}`);
  }

  // Determine group ID: use the first job's delivery target if available
  let groupId = "1081646667"; // default
  for (const j of jobs) {
    const to = j.delivery?.to;
    if (to && /^\d+$/.test(to)) {
      groupId = to;
      break;
    }
  }
  console.log(`\nGroup ID target: ${groupId}`);

  // Apply fixes
  console.log("\nApplying fixes…\n");
  let fixed = 0, skipped = 0, failed = 0;

  for (const job of jobs) {
    const jobId = job.id;
    if (!jobId) continue;

    const deliveryMode = job.delivery?.mode;
    const payloadKind = job.payload?.kind;

    // Skip if already correctly configured
    if (deliveryMode === "none" && payloadKind === "command") {
      // Still check if HA_TOKEN env is present
      const hasToken = job.payload?.env?.HA_TOKEN && job.payload.env.HA_TOKEN.length > 40;
      if (hasToken) {
        console.log(`\n  [${job.name}] already fixed, skipping`);
        skipped++;
        continue;
      }
      console.log(`\n  [${job.name}] mode correct but missing HA_TOKEN, re-patching…`);
    }

    const ok = await fixOneJob(jobId, job.name, haToken, ha, nc, groupId);
    if (ok) fixed++;
    else failed++;
  }

  console.log("\n=== Summary ===");
  console.log(`  Fixed:   ${fixed}`);
  console.log(`  Skipped: ${skipped} (already correct)`);
  console.log(`  Failed:  ${failed}`);
  if (failed > 0) {
    console.log("\n  ⚠ Some jobs failed. Check errors above.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
