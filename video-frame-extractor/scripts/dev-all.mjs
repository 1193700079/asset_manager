// Tiny zero-dep launcher: runs the API server and Vite dev server side-by-side.
// Streams both stdouts with a colored prefix and forwards Ctrl-C to children.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const palette = {
  api: "\x1b[38;5;208m",   // amber
  web: "\x1b[38;5;81m",    // cyan
  reset: "\x1b[0m",
  dim: "\x1b[2m",
};

function tag(name, color) {
  return `${color}${name.padEnd(3)}${palette.reset}${palette.dim}│${palette.reset} `;
}

function pipe(stream, prefix) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      process.stdout.write(prefix + line + "\n");
    }
  });
  stream.on("end", () => {
    if (buf) process.stdout.write(prefix + buf + "\n");
  });
}

function launch(name, color, cmd, args) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const prefix = tag(name, color);
  pipe(child.stdout, prefix);
  pipe(child.stderr, prefix);
  child.on("exit", (code, signal) => {
    process.stdout.write(prefix + `exited (code=${code}, signal=${signal ?? "-"})\n`);
    // If one dies, take the other with it so the user notices.
    for (const c of children) if (c !== child && c.exitCode == null) c.kill("SIGTERM");
    process.exitCode = code ?? 1;
  });
  return child;
}

const viteBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vite.cmd" : "vite",
);

const children = [];
children.push(launch("api", palette.api, process.execPath, ["server/index.mjs"]));
children.push(launch("web", palette.web, viteBin, []));

function shutdown(signal) {
  for (const c of children) if (c.exitCode == null) c.kill(signal);
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
