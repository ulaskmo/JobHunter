const https = require("https");
const http = require("http");
const zlib = require("zlib");

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function request(url, { method = "GET", headers = {}, body = null, timeout = 20000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const reqHeaders = {
      "User-Agent": DEFAULT_UA,
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate",
      ...headers,
    };
    const req = lib.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        headers: reqHeaders,
        timeout,
      },
      (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          const nextUrl = new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(request(nextUrl, { method, headers, body, timeout, redirects: redirects - 1 }));
        }

        const chunks = [];
        let stream = res;
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());

        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString("utf8") });
        });
        stream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("Request timed out")); });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJSON(url, opts = {}) {
  const res = await request(url, {
    ...opts,
    headers: { "Accept": "application/json", ...(opts.headers || {}) },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return JSON.parse(res.body);
}

async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.body;
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function stripHTML(s) {
  if (!s) return "";
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { request, fetchJSON, fetchText, stripHTML, decodeEntities, sleep, DEFAULT_UA };
