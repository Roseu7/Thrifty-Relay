import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function runtimeError(code) {
  return Object.assign(new Error(code), { code });
}

function relevantAddress(address) {
  const value = String(address).toLowerCase();
  return value === "127.0.0.1" || value === "0.0.0.0" || value === "*" || value === "::" || value === "::1" ||
    value === "0:0:0:0:0:0:0:0" || value === "0:0:0:0:0:0:0:1" || value === "::ffff:127.0.0.1";
}

function parseAddress(value, port) {
  const text = String(value);
  const index = text.lastIndexOf(":");
  if (index < 0) return null;
  const address = text.slice(0, index).replace(/^\[|\]$/g, "") || "*";
  const parsedPort = Number(text.slice(index + 1));
  if (parsedPort !== port || !relevantAddress(address)) return null;
  return { address, family: address.includes(":") ? "ipv6" : "ipv4", port: parsedPort };
}

// A bind probe answers "is this address free?" without trusting the visibility of the
// process table. It is the only pre-start check that also works when lsof hides other
// users' sockets.
export async function bindProbe(port, { host = "127.0.0.1", createServer = net.createServer } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw runtimeError("RUNTIME_OWNER_UNKNOWN");
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true }, resolve);
    });
    return true;
  } catch (error) {
    if (error?.code === "EADDRINUSE" || error?.code === "EACCES") throw runtimeError("LOCAL_ENDPOINT_IN_USE");
    throw runtimeError("RUNTIME_OWNER_UNKNOWN");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(() => resolve()));
  }
}

// `ss -H -ltnp "sport = :8080"` prints one LISTEN row per socket. The local address is
// column 4; the owners are pid= fields inside users:(...). A listening row with no pid
// means the owner is not visible, which is unknown rather than free.
export function parseSsListeners(stdout, port) {
  const owners = [];
  let listening = false;
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0] !== "LISTEN") continue;
    const address = parseAddress(fields[3], port);
    if (!address) continue;
    listening = true;
    const pids = [...line.matchAll(/pid=(\d+)/g)].map(match => Number(match[1]));
    if (!pids.length) throw runtimeError("RUNTIME_OWNER_UNKNOWN");
    for (const pid of pids) owners.push({ ...address, pid });
  }
  return { listening, owners };
}

// lsof -Fpn prints a p<pid> record followed by one or more n<address> records.
export function parseLsofListeners(stdout, port) {
  const owners = [];
  let listening = false;
  let pid = null;
  for (const line of String(stdout).split("\n")) {
    if (!line) continue;
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
      continue;
    }
    if (line.startsWith("n")) {
      const address = parseAddress(line.slice(1), port);
      if (!address) continue;
      if (!Number.isSafeInteger(pid) || pid < 1) throw runtimeError("RUNTIME_OWNER_UNKNOWN");
      listening = true;
      owners.push({ ...address, pid });
    }
  }
  return { listening, owners };
}

async function runOwnerCommand(executable, args, { run = exec, allowNoMatch = false } = {}) {
  try {
    const { stdout } = await run(executable, args, {
      timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    if (typeof stdout !== "string") throw runtimeError("RUNTIME_OWNER_UNKNOWN");
    return stdout;
  } catch (error) {
    if (error?.code === "ENOENT") throw runtimeError("RUNTIME_DEPENDENCY_MISSING");
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    // lsof exits 1 when the filter matches nothing. That is the only non-zero exit
    // that means "no listener", and it must have no partial stdout either.
    if (allowNoMatch && Number(error?.code) === 1 && stderr.trim() === "" && stdout.trim() === "") return stdout;
    throw runtimeError("RUNTIME_OWNER_UNKNOWN");
  }
}

function windowsOwners(port, { run } = {}) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$connections = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort ${port} -ErrorAction SilentlyContinue)`,
    "$ids = @($connections | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)",
    "[pscustomobject]@{ pids = $ids } | ConvertTo-Json -Compress",
  ].join("\n");
  return runOwnerCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { run })
    .then(output => {
      const text = String(output).trim();
      if (!text) return { listening: false, owners: [] };
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.pids)) throw runtimeError("RUNTIME_OWNER_UNKNOWN");
      const pids = [...new Set(parsed.pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
      return {
        listening: pids.length > 0,
        owners: pids.map(pid => ({ address: "127.0.0.1", family: "ipv4", port, pid })),
      };
    })
    .catch(error => {
      if (error?.code) throw error;
      throw runtimeError("RUNTIME_OWNER_UNKNOWN");
    });
}

export async function probeListenerOwners(port, { platform = process.platform, run } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw runtimeError("RUNTIME_OWNER_UNKNOWN");
  if (platform === "win32") return windowsOwners(port, { run });
  if (platform === "linux") {
    const stdout = await runOwnerCommand("ss", ["-H", "-ltnp", `sport = :${port}`], { run });
    return parseSsListeners(stdout, port);
  }
  if (platform === "darwin") {
    const stdout = await runOwnerCommand("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
      { run, allowNoMatch: true });
    return parseLsofListeners(stdout, port);
  }
  throw runtimeError("REMOTE_PLATFORM_UNSUPPORTED");
}

// Compatibility surface: the runtime core only needs the PIDs. An occupied port with
// no visible owner stays an error instead of looking free.
export async function probeListeningProcessIds(port, options = {}) {
  const result = await probeListenerOwners(port, options);
  if (result.listening && result.owners.length === 0) throw runtimeError("RUNTIME_OWNER_UNKNOWN");
  return [...new Set(result.owners.map(owner => owner.pid))];
}
