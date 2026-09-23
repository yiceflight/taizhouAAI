import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const windows = process.platform === "win32";

function listeners(port) {
  let output;
  try {
    output = execFileSync(
      windows ? "netstat.exe" : "lsof",
      windows ? ["-ano", "-p", "tcp"] : ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    // lsof exits with 1 when no process is listening.
    if (!windows && error.status === 1 && !error.stderr?.toString().trim()) return [];
    throw error;
  }

  const pids = windows
    ? output.split(/\r?\n/).flatMap((line) => {
        const columns = line.trim().split(/\s+/);
        return columns[0] === "TCP" && columns[1]?.endsWith(`:${port}`) && columns[3] === "LISTENING"
          ? [Number(columns[4])]
          : [];
      })
    : output.trim().split(/\s+/).map(Number);
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function terminate(pid, force) {
  if (pid === process.pid || pid === process.ppid) {
    throw new Error(`端口被启动进程自身占用（PID ${pid}），无法自动结束。`);
  }
  try {
    if (windows) {
      execFileSync("taskkill.exe", ["/PID", String(pid), ...(force ? ["/F"] : [])], {
        stdio: "pipe",
      });
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch (error) {
    if (error.code === "ESRCH") return;
    // Windows applications may require /F; retry after the grace period.
    if (windows && !force && Number.isInteger(error.status)) return;
    throw error;
  }
}

async function waitUntilFree(port, timeout) {
  const deadline = Date.now() + timeout;
  do {
    if (listeners(port).length === 0) return true;
    await setTimeout(100);
  } while (Date.now() < deadline);
  return listeners(port).length === 0;
}

try {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const ports = [Number(new URL(config.build.devUrl).port)];
  if (process.env.TAURI_DEV_HOST) ports.push(1451);

  for (const port of ports) {
    const pids = listeners(port);
    if (pids.length === 0) continue;
    console.log(`[dev] 端口 ${port} 被占用，正在结束进程：${pids.join(", ")}`);
    for (const pid of pids) terminate(pid, false);
    if (!(await waitUntilFree(port, 3000))) {
      const remaining = listeners(port);
      console.log(`[dev] 端口 ${port} 尚未释放，强制结束进程：${remaining.join(", ")}`);
      for (const pid of remaining) terminate(pid, true);
      if (!(await waitUntilFree(port, 2000))) throw new Error(`端口 ${port} 仍被占用。`);
    }
    console.log(`[dev] 端口 ${port} 已释放，继续启动。`);
  }
} catch (error) {
  console.error(`[dev] 清理开发端口失败：${error.message}`);
  process.exitCode = 1;
}
