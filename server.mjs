// Production entry point. A thin wrapper around Next.js whose only job is to
// record the real client IP from the TCP socket, so admin IP allowlists and
// login lockouts cannot be bypassed with a forged X-Forwarded-For header.
// Set TRUST_PROXY=1 only when running behind your own reverse proxy (Nginx/Caddy).
import { createServer } from "node:http";
import next from "next";

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const trustProxy = process.env.TRUST_PROXY === "1";
process.env.SL_CUSTOM_SERVER = "1";

const app = next({ dev: false, hostname: host, port });
const handle = app.getRequestHandler();
await app.prepare();

const server = createServer((req, res) => {
  let ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (fwd) ip = String(fwd).split(",")[0].trim();
  } else {
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-real-ip"];
  }
  req.headers["x-sl-client-ip"] = ip;
  handle(req, res);
});

server.listen(port, host, () => console.log(`[system] 信号灯已启动：http://${host}:${port}`));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`[system] 收到 ${sig}，正在停止…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
