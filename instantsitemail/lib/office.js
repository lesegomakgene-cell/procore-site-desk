// Text extraction from Word (.docx) and Excel (.xlsx) files - no dependencies.
// Both are ZIP archives of XML; Node's built-in zlib does the inflating.

const zlib = require("zlib");
const { decodeEntities, tidyText } = require("./text");

function readZip(buf) {
  // Find the End Of Central Directory record (scan back over any comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid ZIP-based Office file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    files.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: () => [...files.keys()],
    read(name) {
      const f = files.get(name);
      if (!f) return null;
      const lh = f.localOff;
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const raw = buf.subarray(start, start + f.compSize);
      if (f.method === 0) return raw;
      if (f.method === 8) return zlib.inflateRawSync(raw);
      throw new Error("Unsupported ZIP compression in " + name);
    },
  };
}

function xmlText(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ""));
}

function docxToText(buf) {
  const zip = readZip(buf);
  const parts = ["word/document.xml", ...zip.names().filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))];
  let out = "";
  for (const name of parts) {
    const xml = zip.read(name);
    if (!xml) continue;
    out +=
      xmlText(
        xml
          .toString("utf8")
          .replace(/<w:tab\/>/g, "\t")
          .replace(/<w:br[^>]*\/>/g, "\n")
          .replace(/<\/w:tc>/g, "\t")
          .replace(/<\/w:p>/g, "\n")
      ) + "\n";
  }
  return tidyText(out);
}

function colIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref || "");
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[0]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxToText(buf) {
  const zip = readZip(buf);
  const shared = [];
  const ss = zip.read("xl/sharedStrings.xml");
  if (ss) {
    for (const m of ss.toString("utf8").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join(""));
    }
  }
  // Sheet names, in workbook order
  const names = [];
  const wb = zip.read("xl/workbook.xml");
  if (wb) for (const m of wb.toString("utf8").matchAll(/<sheet [^>]*name="([^"]*)"/g)) names.push(decodeEntities(m[1]));

  const sheets = zip
    .names()
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  let out = "";
  sheets.forEach((name, i) => {
    out += `\n=== Sheet: ${names[i] || name} ===\n`;
    const xml = zip.read(name).toString("utf8");
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] || "";
        const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
        const type = (/t="([^"]+)"/.exec(attrs) || [])[1];
        const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        let val = "";
        if (type === "s" && v !== undefined) val = shared[Number(v)] || "";
        else if (type === "inlineStr") val = xmlText((/<is>([\s\S]*?)<\/is>/.exec(inner) || [, ""])[1]);
        else if (v !== undefined) val = decodeEntities(v);
        cells[colIndex(ref)] = val.replace(/[\t\n]+/g, " ");
      }
      if (cells.some((x) => x)) out += Array.from(cells, (x) => x || "").join("\t") + "\n";
    }
  });
  return tidyText(out);
}

module.exports = { readZip, docxToText, xlsxToText };
