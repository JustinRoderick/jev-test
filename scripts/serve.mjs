import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import handler from "../dist/server/server.js";

const root = path.resolve("dist/client");
const mime = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  try {
    const url = new URL(req.url, "http://127.0.0.1:3000");
    const filename = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (filename.startsWith(root + path.sep) && ["GET", "HEAD"].includes(req.method)) {
      const file = await stat(filename).catch(() => null);
      if (file?.isFile()) {
        res.setHeader("Content-Type", mime[path.extname(filename)] ?? "application/octet-stream");
        res.setHeader("Content-Length", file.size);
        res.setHeader(
          "Cache-Control",
          url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        );
        if (req.method === "HEAD") return res.end();
        await pipeline(createReadStream(filename), res);
        return;
      }
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const init = { method: req.method, headers, signal: abort.signal };
    if (!["GET", "HEAD"].includes(req.method)) {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }
    const response = await handler.fetch(new Request(url, init));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && req.method !== "HEAD")
      await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Request failed. See the server log.");
    console.error(error instanceof Error ? error.message : "Request failed");
  }
});
server.listen(3000, "127.0.0.1", () =>
  console.log("Silverline: http://127.0.0.1:3000 (start pnpm worker separately)"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.close(() => process.exit(0)));
