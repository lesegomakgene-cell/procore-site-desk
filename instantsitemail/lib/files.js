// Turns a dropped file (email or document) into something the analyser can use.

const path = require("path");
const { parseMsg } = require("./msg");
const { parseEml } = require("./eml");
const { docxToText, xlsxToText } = require("./office");
const { decodeBytes, htmlToText, tidyText } = require("./text");

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const TEXT_EXT = new Set(["txt", "csv", "md", "ics", "json", "xml", "log"]);
const CAD_EXT = new Set(["dwg", "dxf", "rvt", "rfa", "ifc", "nwd", "nwc", "dgn", "skp", "3dm", "pln"]);

function sniff(data) {
  const b = data.subarray(0, 12);
  if (b.toString("latin1", 0, 4) === "%PDF") return "application/pdf";
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "image/tiff";
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "application/x-cfb";
  if (b[0] === 0x50 && b[1] === 0x4b) return "application/zip";
  return "";
}

function looksLikeEml(data) {
  const head = data.subarray(0, 4096).toString("latin1");
  return /^(received|return-path|from|to|subject|date|message-id|mime-version|delivered-to|x-[\w-]+):/im.test(head) &&
    /^(from|subject|date):/im.test(head);
}

// Classify one document and prepare it for the model.
function prepareDocument({ name, mime, data, contentId, inline, hidden }) {
  const ext = path.extname(name || "").slice(1).toLowerCase();
  const sniffed = sniff(data);
  const doc = { name, size: data.length, mime: sniffed || mime || "application/octet-stream" };

  // Signature logos and other small inline images are noise for the analysis.
  const tinyInline = (inline || hidden || contentId) && data.length < 40_000;

  if (doc.mime === "application/pdf") {
    return { ...doc, kind: "pdf", include: true, data: data.toString("base64") };
  }
  if (doc.mime.startsWith("image/") && Object.values(IMAGE_TYPES).includes(doc.mime)) {
    return {
      ...doc,
      kind: "image",
      include: !tinyInline && data.length > 8_000,
      note: tinyInline ? "Looks like an inline image or signature logo - excluded by default." : undefined,
      data: data.toString("base64"),
    };
  }
  if (doc.mime === "image/tiff" || ext === "tif" || ext === "tiff") {
    return { ...doc, kind: "unsupported", include: false, note: "TIFF drawings can't be read directly. Re-save or print to PDF and drop the PDF in." };
  }
  if (CAD_EXT.has(ext)) {
    return { ...doc, kind: "unsupported", include: false, note: "Native CAD/BIM file - can't be read. Ask for a PDF print, or export one and drop it in. This will be flagged as an information gap." };
  }
  try {
    if (ext === "docx" || ext === "docm") return { ...doc, kind: "text", include: true, text: docxToText(data) };
    if (ext === "xlsx" || ext === "xlsm") return { ...doc, kind: "text", include: true, text: xlsxToText(data) };
  } catch (e) {
    return { ...doc, kind: "unsupported", include: false, note: "Could not read this Office file: " + e.message };
  }
  if (ext === "htm" || ext === "html") return { ...doc, kind: "text", include: true, text: htmlToText(decodeBytes(data, "utf-8")) };
  if (TEXT_EXT.has(ext) || doc.mime.startsWith("text/")) {
    return { ...doc, kind: "text", include: true, text: tidyText(decodeBytes(data, "utf-8")) };
  }
  const hint =
    ext === "doc" || ext === "xls" || ext === "ppt"
      ? "Old-format Office file - re-save as .docx/.xlsx or PDF and drop it in."
      : "This file type can't be read. Convert to PDF if it matters.";
  return { ...doc, kind: "unsupported", include: false, note: hint };
}

// Flatten an email (and any emails forwarded inside it) into a thread list
// plus a single list of attachments tagged with the email they came from.
function flattenEmail(email, thread, docs, level) {
  const index = thread.length;
  thread.push({
    level,
    subject: email.subject,
    from: email.from,
    to: email.to,
    cc: email.cc,
    date: email.date,
    body: email.body,
  });
  for (const a of email.attachments) {
    if (a.embedded) {
      flattenEmail(a.embedded, thread, docs, level + 1);
      continue;
    }
    docs.push({ ...prepareDocument(a), fromEmail: index });
  }
}

function parseDropped(name, data) {
  const ext = path.extname(name || "").slice(1).toLowerCase();
  const sniffed = sniff(data);
  let email = null;
  if (ext === "msg" || (sniffed === "application/x-cfb" && ext !== "doc" && ext !== "xls")) email = parseMsg(data);
  else if (ext === "eml" || ext === "mht" || (!sniffed && looksLikeEml(data))) email = parseEml(data);

  if (email) {
    const thread = [];
    const docs = [];
    flattenEmail(email, thread, docs, 0);
    return { kind: "email", thread, documents: docs };
  }
  return { kind: "document", documents: [prepareDocument({ name, data })] };
}

module.exports = { parseDropped, prepareDocument, sniff, IMAGE_TYPES };
