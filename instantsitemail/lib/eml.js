// .eml (RFC 5322 / MIME) reader - no dependencies.
// Handles multipart nesting, base64 / quoted-printable, RFC 2047 encoded
// headers, RFC 2231 filenames and forwarded emails (message/rfc822).

const { htmlToText, tidyText, decodeBytes } = require("./text");

function splitHeaderBody(buf) {
  const s = buf.toString("latin1");
  let idx = s.search(/\r?\n\r?\n/);
  if (idx < 0) return { headerText: s, body: Buffer.alloc(0) };
  const sep = /\r?\n\r?\n/.exec(s.slice(idx))[0].length;
  return { headerText: s.slice(0, idx), body: buf.subarray(idx + sep) };
}

function parseHeaders(headerText) {
  const headers = {};
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (!(key in headers)) headers[key] = m[2].trim();
  }
  return headers;
}

// =?utf-8?B?...?= / =?iso-8859-1?Q?...?=
function decodeWords(s) {
  if (!s) return "";
  // Header bytes were read as latin1; re-read raw UTF-8 when it is valid.
  let text = s;
  if (/[\x80-\xff]/.test(text)) {
    const utf = Buffer.from(text, "latin1").toString("utf8");
    if (!utf.includes("�")) text = utf;
  }
  return text
    .replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, "$1")
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bq])\?([^?]*)\?=/gi, (m, cs, enc, data) => {
      try {
        const bytes =
          enc.toLowerCase() === "b"
            ? Buffer.from(data, "base64")
            : Buffer.from(
                data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))),
                "latin1"
              );
        return decodeBytes(bytes, cs);
      } catch {
        return m;
      }
    });
}

// Parse `type/sub; a=b; c="d"` including RFC 2231 continuations (name*0*=...)
function parseParams(value) {
  const parts = [];
  let cur = "";
  let q = false;
  for (const ch of value || "") {
    if (ch === '"') q = !q;
    if (ch === ";" && !q) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const main = parts.shift().trim().toLowerCase();
  const params = {};
  const ext = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(k);
    if (m) {
      (ext[m[1]] = ext[m[1]] || []).push({ n: Number(m[2] || 0), v, encoded: !!m[3] || (!m[2] && k.endsWith("*")) });
    } else params[k] = v;
  }
  for (const [k, segs] of Object.entries(ext)) {
    segs.sort((a, b) => a.n - b.n);
    let charset = "utf-8";
    const bytes = [];
    segs.forEach((seg, i) => {
      let v = seg.v;
      if (seg.encoded) {
        if (i === 0) {
          const mm = /^([^']*)'[^']*'(.*)$/.exec(v);
          if (mm) {
            charset = mm[1] || charset;
            v = mm[2];
          }
        }
        bytes.push(Buffer.from(v.replace(/%([0-9a-f]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))), "latin1"));
      } else bytes.push(Buffer.from(v, "latin1"));
    });
    params[k] = decodeBytes(Buffer.concat(bytes), charset);
  }
  return { value: main, params };
}

function decodeTransfer(body, encoding) {
  const enc = (encoding || "").trim().toLowerCase();
  if (enc === "base64") return Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable") {
    const s = body
      .toString("latin1")
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(s, "latin1");
  }
  return body;
}

function splitMultipart(body, boundary) {
  const s = body.toString("latin1");
  const delim = "--" + boundary;
  const parts = [];
  let pos = s.indexOf(delim);
  while (pos >= 0) {
    let start = pos + delim.length;
    if (s.startsWith("--", start)) break; // closing delimiter
    start = s.indexOf("\n", start);
    if (start < 0) break;
    start += 1;
    const next = s.indexOf(delim, start);
    const end = next < 0 ? s.length : next;
    let partEnd = end;
    if (s[partEnd - 1] === "\n") partEnd--;
    if (s[partEnd - 1] === "\r") partEnd--;
    parts.push(body.subarray(start, Math.max(start, partEnd)));
    pos = next;
  }
  return parts;
}

function walk(buf, out, depth) {
  const { headerText, body } = splitHeaderBody(buf);
  const h = parseHeaders(headerText);
  const ct = parseParams(h["content-type"] || "text/plain");
  const cd = parseParams(h["content-disposition"] || "");
  const filename = decodeWords(cd.params.filename || ct.params.name || "");

  if (ct.value.startsWith("multipart/") && ct.params.boundary && depth < 20) {
    for (const part of splitMultipart(body, ct.params.boundary)) walk(part, out, depth + 1);
    return;
  }
  const data = decodeTransfer(body, h["content-transfer-encoding"]);

  if (ct.value === "message/rfc822" && depth < 20) {
    const inner = parseEml(data, depth + 1);
    out.attachments.push({ name: (filename || inner.subject || "forwarded").replace(/\.eml$/i, "") + ".eml", embedded: inner });
    return;
  }
  const isAttachment = cd.value === "attachment" || (!!filename && !ct.value.startsWith("text/"));
  if (!isAttachment && ct.value === "text/plain" && !out.text) {
    out.text = decodeBytes(data, ct.params.charset);
    return;
  }
  if (!isAttachment && ct.value === "text/html" && !out.html) {
    out.html = decodeBytes(data, ct.params.charset);
    return;
  }
  if (ct.value === "text/calendar" && !filename) {
    out.attachments.push({ name: "invite.ics", mime: ct.value, data, contentId: "" });
    return;
  }
  if (!isAttachment && ct.value.startsWith("text/")) return;
  out.attachments.push({
    name: filename || "attachment",
    mime: ct.value,
    contentId: (h["content-id"] || "").replace(/[<>]/g, ""),
    inline: cd.value === "inline",
    data,
  });
}

function parseEml(buf, depth = 0) {
  const { headerText } = splitHeaderBody(buf);
  const h = parseHeaders(headerText);
  const out = { text: "", html: "", attachments: [] };
  walk(buf, out, depth);
  let date = h.date || "";
  const d = new Date(date);
  if (date && !Number.isNaN(d.getTime())) date = d.toISOString();
  return {
    subject: decodeWords(h.subject || ""),
    from: decodeWords(h.from || ""),
    to: decodeWords(h.to || ""),
    cc: decodeWords(h.cc || ""),
    date,
    body: tidyText(out.text || (out.html ? htmlToText(out.html) : "")),
    html: out.html,
    attachments: out.attachments,
  };
}

module.exports = { parseEml, decodeWords, parseParams };
