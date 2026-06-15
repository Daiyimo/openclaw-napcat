#!/usr/bin/env node
// new-cron.cjs — Interactive cron job creation for NapCat.
//
// Prompts the user for:
//   - Job name
//   - Cron expression
//   - Mode: "default" (OpenClaw announce delivery) or "napcat" (direct curl delivery)
//
// In "napcat" mode the cron uses:
//   delivery.mode = "none" + command payload that calls NapCat send_group_msg directly
//
// Uses `openclaw cron add` CLI.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

// ─── Same helpers as fix-cron.cjs ──────────────────────────────────────────

function findConfigPath() {
  const override = process.env.OPENCLAW_CONFIG?.trim();
  if (override && fs.existsSync(override)) return override;
  const home = process.env.HOME || "/root";
  for (const p of [
    path.join(home, ".openclaw", "openclaw.json"),
    "/root/.openclaw/openclaw.json",
    "/home/node/.openclaw/openclaw.json",
    "/home/openclaw/.openclaw/openclaw.json",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("Cannot find openclaw.json. Set OPENCLAW_CONFIG env var.");
}

function loadConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

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
  return { host: c.host ?? c.napcatHost ?? "127.0.0.1", port: c.port ?? c.napcatPort ?? 3000 };
}

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
  return "openclaw";
}

function runCli(args) {
  const bin = findCliBin();
  const env = { ...process.env };
  const configPath = findConfigPath();
  env.OPENCLAW_CONFIG = configPath;
  const stateDir = path.join(path.dirname(configPath), "..");
  if (!env.OPENCLAW_STATE_DIR) env.OPENCLAW_STATE_DIR = stateDir;

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(`CLI exit ${code}: ${stderr || stdout}`);
        err.code = code; err.stdout = stdout; err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
    proc.on("error", (e) => reject(e));
  });
}

// ─── Prompt helpers ────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function buildNapcatCommandScript(haHost, haPort, ncHost, ncPort, groupId, customScript) {
  // If user provides a custom script, use it directly (wrapped in sh -lc)
  if (customScript) {
    return ["sh", "-lc", customScript];
  }
  // Default: HA electricity report → NapCat
  return [
    "sh", "-lc",
    [
      `RESP=$(curl -s -X POST "http://${haHost}:${haPort}/api/services/recorder/get_significant_statistics" \\`,
      `  -H "Authorization: Bearer $HA_TOKEN" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '{"statistic_ids":["sensor.xiaoxin_0002_electricity_charging"],"period":{"start":"now()-24h","end":"now()"}}' 2>/dev/null)`,
      ``,
      `SUMMARY="📊 电费水费报告\\n\\n"`,
      `if [ -n "$RESP" ]; then SUMMARY="$SUMMARY$RESP"; fi`,
      ``,
      `curl -s -X POST "http://${ncHost}:${ncPort}/send_group_msg" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d "{\\"group_id\\":${groupId},\\"message\\":[{\\"type\\":\\"text\\",\\"data\\":{\\"text\\":\\"$SUMMARY\\"}}]}" > /dev/null`,
      `echo "done"`,
    ].join(" "),
  ];
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== new-cron: Create NapCat cron job ===\n");

  // Config
  const configPath = findConfigPath();
  const config = loadConfig(configPath);
  const haToken = extractHaToken(config);
  if (!haToken) {
    console.error("ERROR: Cannot find HA token in config.");
    process.exit(1);
  }
  const nc = findNapcatEndpoint(config);

  // Verify CLI
  try {
    await runCli(["--version"]);
  } catch (err) {
    console.error(`ERROR: Cannot run openclaw CLI: ${err.message}`);
    process.exit(1);
  }

  // ── Interactive prompts ──────────────────────────────────────────────

  const name = (await prompt("Job name: ")).trim();
  if (!name) { console.log("Cancelled."); rl.close(); process.exit(0); }

  const cronExpr = (await prompt("Cron expression (e.g. '0 9 * * *'): ")).trim();
  if (!cronExpr) { console.log("Cancelled."); rl.close(); process.exit(0); }

  // Mode selection
  console.log(`
  Delivery mode:
    [1] default   — OpenClaw announce delivery (message tool → napcat plugin)
    [2] napcat    — Direct curl to NapCat (no OpenClaw delivery fallback)
  `);
  const modeChoice = (await prompt("Choose mode [1/2] (default: 2): ")).trim() || "2";

  const isNapcatMode = modeChoice === "2";

  // Group ID
  const groupId = (await prompt("Group ID (default 1081646667): ")).trim() || "1081646667";

  // Custom command script (optional)
  if (isNapcatMode) {
    console.log(`
  Optional: paste a custom shell script for step 7.
  $HA_TOKEN is available in env. Leave empty for default (HA electricity report).
  `);
    const customScript = (await prompt("Custom script (empty = default): ")).trim();
    // If empty, use default

    const argv = buildNapcatCommandScript(
      "192.168.110.185", 8123,
      nc.host, nc.port,
      groupId,
      customScript || undefined
    );

    // ── 安全确认：展示将要执行的完整命令 ──────────────────────
    console.log("\n⚠️  即将执行的命令：");
    console.log(`  程序: ${argv[0]} ${argv[1]}`);
    console.log(`  脚本: ${argv[2]}`);
    console.log("");
    const confirm = (await prompt("确认执行？[y/N]: ")).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      console.log("已取消。");
      process.exit(0);
    }

    console.log("\nCreating cron job…");
    const args = [
      "cron", "add",
      "--name", name,
      "--cron", cronExpr,
      "--session", "isolated",
      "--no-deliver",
      `--command-argv`, JSON.stringify(argv),
      `--command-env`, `HA_TOKEN=${haToken}`,
      "--timeout-seconds", "120",
    ];

    try {
      const { stdout } = await runCli(args);
      // Extract job ID from output
      const idMatch = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (idMatch) {
        console.log(`✓ Created: ${name}`);
        console.log(`  ID:   ${idMatch[0]}`);
        console.log(`  Mode: napcat (direct curl, delivery=none)`);
      } else {
        console.log(`✓ Created: ${name}`);
        console.log(`  Output: ${stdout.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`✗ Failed: ${err.message}`);
      if (err.stderr) console.error(`  stderr: ${err.stderr.slice(0, 300)}`);
      process.exit(1);
    }
  } else {
    // Default mode: announce delivery
    console.log("\nCreating cron job (default announce mode)…");
    const args = [
      "cron", "add",
      "--name", name,
      "--cron", cronExpr,
      "--session", "isolated",
      "--announce",
      "--channel", "napcat",
      "--to", groupId,
    ];

    try {
      const { stdout } = await runCli(args);
      const idMatch = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (idMatch) {
        console.log(`✓ Created: ${name}`);
        console.log(`  ID:   ${idMatch[0]}`);
        console.log(`  Mode: default (announce → napcat)`);
      } else {
        console.log(`✓ Created: ${name}`);
        console.log(`  Output: ${stdout.slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`✗ Failed: ${err.message}`);
      if (err.stderr) console.error(`  stderr: ${err.stderr.slice(0, 300)}`);
      process.exit(1);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
