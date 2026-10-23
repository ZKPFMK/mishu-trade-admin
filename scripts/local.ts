import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ROOT, loadEnv } from "../packages/core/src/config.js";
const state = path.join(ROOT, ".local");
fs.mkdirSync(state, { recursive: true, mode: 0o700 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const services = [
  { name: "postgres", entry: "scripts/postgres.ts", port: 8922 },
  { name: "api", entry: "apps/api/src/main.ts", port: 8920 },
  { name: "worker", entry: "apps/worker/src/main.ts", port: 0 },
];
type Service = (typeof services)[number];
function owned(s: Service) {
  const file = path.join(state, s.name + ".pid");
  if (!fs.existsSync(file)) return null;
  const pid = Number(fs.readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 2)
    throw new Error("Invalid PID file");
  try {
    process.kill(pid, 0);
  } catch {
    fs.rmSync(file);
    return null;
  }
  const inspected = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "stat=", "-o", "args="],
    {
      encoding: "utf8",
    },
  );
  if (inspected.error) throw inspected.error;
  const command = inspected.stdout.trim();
  // A child can exit between kill(pid, 0) and ps, or briefly remain a zombie after SIGTERM.
  if ((!command && inspected.status === 1) || /^Z\S*\s/.test(command)) {
    fs.rmSync(file);
    return null;
  }
  if (inspected.status !== 0)
    throw new Error(`${s.name}: unable to inspect PID`);
  if (!command.includes(path.join(ROOT, s.entry)))
    throw new Error(`${s.name}: PID belongs to another process`);
  return pid;
}
async function portFree(port: number) {
  if (!port) return;
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Port ${port} is occupied`)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}
async function start(s: Service) {
  if (owned(s)) {
    console.log(`${s.name}: already running`);
    return;
  }
  await portFree(s.port);
  const binary = process.execPath;
  const fd = fs.openSync(path.join(state, s.name + ".log"), "a", 0o600);
  const child = spawn(
    binary,
    [...["--import", "tsx"], path.join(ROOT, s.entry)],
    {
      cwd: ROOT,
      env: process.env,
      detached: true,
      stdio: ["ignore", fd, fd],
    },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  fs.writeFileSync(path.join(state, s.name + ".pid"), String(child.pid), {
    mode: 0o600,
  });
  fs.closeSync(fd);
  child.unref();
  if (s.port) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (!owned(s))
        throw new Error(`${s.name} stopped; inspect .local/${s.name}.log`);
      const ok = await new Promise<boolean>((resolve) => {
        const c = net.connect(s.port, "127.0.0.1");
        c.once("connect", () => {
          c.destroy();
          resolve(true);
        });
        c.once("error", () => resolve(false));
      });
      if (ok) {
        console.log(`${s.name}: ready`);
        return;
      }
      await sleep(300);
    }
    throw new Error(`${s.name} startup timed out`);
  }
  console.log(`${s.name}: started; see .local/${s.name}.log`);
}
async function stop(s: Service) {
  const pid = owned(s);
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 120; i++) {
    if (!owned(s)) return;
    await sleep(250);
  }
  throw new Error(`${s.name} is still stopping`);
}
const action = process.argv[2] || "status";
if (action === "setup") {
  const env = path.join(ROOT, ".env");
  if (!fs.existsSync(env))
    fs.writeFileSync(
      env,
      `DATABASE_URL=postgres://trade:${randomBytes(24).toString("hex")}@127.0.0.1:8922/trade_admin\nTRADE_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nDATA_DIR=./data\nHOST=127.0.0.1\nPORT=8920\nSOURCE_MODE=mock\n`,
      { mode: 0o600 },
    );
  loadEnv();
  const native = path.join(
    ROOT,
    `node_modules/@embedded-postgres/${process.platform}-${process.arch}`,
  );
  if (fs.existsSync(path.join(native, "scripts/hydrate-symlinks.js")))
    execFileSync(process.execPath, ["scripts/hydrate-symlinks.js"], {
      cwd: native,
      stdio: "inherit",
    });
  await start(services[0]);
  execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(ROOT, "scripts/bootstrap.ts")],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    },
  );
  console.log(
    "Setup complete. Build with npm run build, then npm run local:start.",
  );
} else if (action === "start") {
  loadEnv();
  for (const s of services) {
    await start(s);
  }
  console.log(
    "Console: http://localhost:8920 · Credentials: .local/credentials.json",
  );
} else if (action === "stop") {
  for (const s of [...services].reverse()) await stop(s);
} else if (action === "restart") {
  loadEnv();
  for (const s of [...services].reverse().filter((s) => s.name !== "postgres"))
    await stop(s);
  for (const s of services) await start(s);
  console.log("Restarted API and worker. Console: http://localhost:8920");
} else if (action === "status") {
  for (const s of services)
    console.log(`${s.name}: ${owned(s) ? "running" : "stopped"}`);
} else if (action === "credentials") {
  if (!process.stdout.isTTY)
    console.log(
      "Credentials are in .local/credentials.json; open locally or run this command in your terminal.",
    );
  else
    console.log(fs.readFileSync(path.join(state, "credentials.json"), "utf8"));
} else throw new Error("Use setup|start|restart|stop|status|credentials");
