import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.LOCALSTREAM_PORT) || 47821;
const HOST = process.env.LOCALSTREAM_HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_ROOT = path.join(os.tmpdir(), "localstream-shares");

/** @type {Map<string, { kind: "path" | "upload"; root: string; name: string; createdAt: number }>} */
const shares = new Map();

await fsp.mkdir(UPLOAD_ROOT, { recursive: true });

function lanIPv4Addresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push(info.address);
    }
  }
  return out;
}

function newShareId() {
  return randomBytes(6).toString("hex");
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
  };
  return map[ext] ?? "application/octet-stream";
}

function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

async function serveStatic(reqPath, res) {
  let rel = decodeURIComponent(reqPath.split("?")[0] || "/");
  rel = rel.replace(/\\/g, "/");
  if (rel === "/" || rel === "") rel = "/index.html";
  rel = rel.replace(/^\/+/, "");
  if (rel.includes("..")) {
    sendText(res, 403, "Forbidden");
    return;
  }
  const filePath = path.join(PUBLIC_DIR, ...rel.split("/").filter(Boolean));
  if (!isInside(PUBLIC_DIR, filePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Content-Length": data.length,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function streamFile(filePath, req, res) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendText(res, 404, "File not found");
    return;
  }
  if (!stat.isFile()) {
    sendText(res, 400, "Not a file");
    return;
  }

  const total = stat.size;
  const type = contentTypeFor(filePath);
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` });
      res.end();
      return;
    }
    end = Math.min(end, total - 1);
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": type,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Length": total,
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  fs.createReadStream(filePath).pipe(res);
}

function parseMultipart(buffer, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = buffer.indexOf(marker) + marker.length;
  while (start < buffer.length) {
    if (buffer[start] === 45 && buffer[start + 1] === 45) break; // --
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf("\r\n\r\n", start);
    if (headerEnd < 0) break;
    const headers = buffer.subarray(start, headerEnd).toString("utf8");
    const bodyStart = headerEnd + 4;
    let next = buffer.indexOf(marker, bodyStart);
    if (next < 0) break;
    let bodyEnd = next - 2; // strip \r\n before boundary
    const nameMatch = /name="([^"]+)"/.exec(headers);
    const fileMatch = /filename="([^"]*)"/.exec(headers);
    parts.push({
      name: nameMatch?.[1] ?? "",
      filename: fileMatch
        ? fileMatch[1].replace(/\\/g, "/").replace(/^\/+/, "")
        : null,
      data: buffer.subarray(bodyStart, bodyEnd),
    });
    start = next + marker.length;
  }
  return parts;
}

async function readBody(req, limit = 1024 * 1024 * 512) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function shareUrls(id) {
  const ips = lanIPv4Addresses();
  return {
    local: `http://127.0.0.1:${PORT}/s/${id}/`,
    lan: ips.map((ip) => `http://${ip}:${PORT}/s/${id}/`),
  };
}

async function createPathShare(rawPath) {
  const resolved = path.resolve(rawPath.trim());
  const stat = await fsp.stat(resolved);
  const id = newShareId();
  const name = path.basename(resolved) || resolved;
  shares.set(id, {
    kind: "path",
    root: resolved,
    name,
    createdAt: Date.now(),
    isDirectory: stat.isDirectory(),
  });
  return { id, name, isDirectory: stat.isDirectory(), urls: shareUrls(id) };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/info") {
    sendJson(res, 200, {
      port: PORT,
      lanAddresses: lanIPv4Addresses(),
      shareCount: shares.size,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/shares") {
    sendJson(
      res,
      200,
      [...shares.entries()].map(([id, s]) => ({
        id,
        name: s.name,
        kind: s.kind,
        urls: shareUrls(id),
        createdAt: s.createdAt,
      })),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/share-path") {
    try {
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw.toString("utf8") || "{}");
      if (!body.path || typeof body.path !== "string") {
        sendJson(res, 400, { error: "path is required" });
        return;
      }
      const share = await createPathShare(body.path);
      sendJson(res, 200, share);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    try {
      const ctype = req.headers["content-type"] || "";
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
      if (!boundaryMatch) {
        sendJson(res, 400, { error: "Expected multipart form data" });
        return;
      }
      const boundary = boundaryMatch[1] || boundaryMatch[2];
      const buffer = await readBody(req);
      const parts = parseMultipart(buffer, boundary);
      const files = parts.filter((p) => p.filename);
      if (files.length === 0) {
        sendJson(res, 400, { error: "No files uploaded" });
        return;
      }
      const id = newShareId();
      const root = path.join(UPLOAD_ROOT, id);
      await fsp.mkdir(root, { recursive: true });
      for (const file of files) {
        const rel = file.filename
          .replace(/^[/\\]+/, "")
          .replace(/\0/g, "")
          .split("/")
          .filter((p) => p && p !== "." && p !== "..")
          .join(path.sep);
        if (!rel) continue;
        const dest = path.join(root, rel);
        if (!isInside(root, dest)) continue;
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, file.data);
      }
      const name = files.length === 1 ? files[0].filename : `${files.length} files`;
      shares.set(id, { kind: "upload", root, name, createdAt: Date.now(), isDirectory: true });
      sendJson(res, 200, { id, name, isDirectory: true, urls: shareUrls(id) });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/shares/")) {
    const id = url.pathname.slice("/api/shares/".length);
    const share = shares.get(id);
    if (!share) {
      sendJson(res, 404, { error: "Share not found" });
      return;
    }
    shares.delete(id);
    if (share.kind === "upload") {
      await fsp.rm(share.root, { recursive: true, force: true }).catch(() => {});
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function listDirectory(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dirPath, entry.name);
    let size = null;
    try {
      if (entry.isFile()) size = (await fsp.stat(full)).size;
    } catch {
      continue;
    }
    items.push({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file",
      size,
    });
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return items;
}

function renderBrowsePage({ shareId, relPath, title, items, parentHref, fileHrefPrefix }) {
  const rows = items
    .map((item) => {
      const href =
        item.type === "dir"
          ? `${fileHrefPrefix}${encodeURI(item.name)}/`
          : `${fileHrefPrefix}${encodeURI(item.name)}`;
      const size =
        item.type === "file" && item.size != null
          ? `<span class="meta">${formatBytes(item.size)}</span>`
          : `<span class="meta">${item.type === "dir" ? "folder" : ""}</span>`;
      return `<li><a href="${href}"><span class="name">${escapeHtml(item.name)}</span>${size}</a></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — LocalStream</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body class="browse">
  <header class="browse-header">
    <a class="brand" href="/">LocalStream</a>
    <h1>${escapeHtml(title)}</h1>
    <p class="path">${escapeHtml(relPath || "/")}</p>
  </header>
  <main>
    ${parentHref ? `<p class="up"><a href="${parentHref}">↑ Parent folder</a></p>` : ""}
    <ul class="listing">${rows || "<li class='empty'>Empty folder</li>"}</ul>
  </main>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function handleShare(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["s", id, ...rel]
  const id = parts[1];
  const share = shares.get(id);
  if (!share) {
    sendText(res, 404, "Share expired or not found");
    return;
  }

  const relParts = parts.slice(2).map((p) => decodeURIComponent(p));
  const rel = relParts.join(path.sep);
  const target = rel ? path.join(share.root, rel) : share.root;
  if (!isInside(share.root, target)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    sendText(res, 404, "Not found");
    return;
  }

  if (stat.isDirectory()) {
    if (!url.pathname.endsWith("/")) {
      res.writeHead(302, { Location: url.pathname + "/" + (url.search || "") });
      res.end();
      return;
    }
    const items = await listDirectory(target);
    const relPosix = relParts.join("/") || "";
    let up = null;
    if (relParts.length > 0) {
      const parentRel = relParts.slice(0, -1).map(encodeURIComponent).join("/");
      up = `/s/${id}/${parentRel}${parentRel ? "/" : ""}`;
    }
    const prefix = `/s/${id}/${relParts.map(encodeURIComponent).join("/")}${relParts.length ? "/" : ""}`;
    const html = renderBrowsePage({
      shareId: id,
      relPath: "/" + relPosix,
      title: share.name,
      items,
      parentHref: up,
      fileHrefPrefix: prefix,
    });
    sendText(res, 200, html, "text/html; charset=utf-8");
    return;
  }

  await streamFile(target, req, res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${PORT}`}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/s/")) {
      await handleShare(req, res, url);
      return;
    }
    await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    sendText(res, 500, "Internal server error");
  }
});

server.listen(PORT, HOST, () => {
  const ips = lanIPv4Addresses();
  console.log(`LocalStream listening on http://127.0.0.1:${PORT}`);
  for (const ip of ips) {
    console.log(`  LAN: http://${ip}:${PORT}`);
  }
  console.log("Open the local URL on this PC, share a path or files, then open the LAN link on your phone.");
});
