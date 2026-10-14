// Small text helpers shared by the email/document parsers.

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  hellip: "…", bull: "•", middot: "·", deg: "°", plusmn: "±", times: "×",
  divide: "÷", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
  sup2: "²", sup3: "³", frac12: "½", frac14: "¼", frac34: "¾", micro: "µ",
};

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

// Turn an HTML email body into readable plain text, keeping paragraph and
// table structure roughly intact (tables matter: schedules, BOQs, registers).
function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head|title|xml)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|pre)>/gi, "\n");
  s = s.replace(/<li[^>]*>/gi, "• ");
  s = s.replace(/<hr[^>]*>/gi, "\n----------\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return tidyText(s);
}

function tidyText(s) {
  return String(s)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Windows-1252 bytes 0x80-0x9F (smart quotes, dashes, euro...). Node's
// TextDecoder treats "windows-1252" as plain Latin-1, which loses these.
const CP1252_HIGH =
  "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f" +
  "\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178";
const LATIN_LABELS = new Set(["windows-1252", "cp1252", "iso-8859-1", "latin1", "latin-1", "iso8859-1", "ascii"]);

function decodeCp1252(buf) {
  let out = "";
  for (const b of buf) out += b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b);
  return out;
}

// Decode bytes in a named charset, falling back to Windows-1252 for unknown ones.
function decodeBytes(buf, charset) {
  const cs = String(charset || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  if (LATIN_LABELS.has(cs)) return decodeCp1252(buf);
  try {
    return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(buf);
  } catch {
    return decodeCp1252(buf);
  }
}

// Map of Windows code pages used by Outlook (PR_MESSAGE_CODEPAGE) to labels.
function codepageLabel(cp) {
  if (!cp) return "windows-1252";
  if (cp === 65001) return "utf-8";
  if (cp === 20127) return "utf-8";
  if (cp === 28591) return "iso-8859-1";
  if (cp >= 1250 && cp <= 1258) return "windows-" + cp;
  if (cp === 932) return "shift_jis";
  if (cp === 936) return "gbk";
  if (cp === 949) return "euc-kr";
  if (cp === 950) return "big5";
  return "windows-1252";
}

module.exports = { decodeEntities, htmlToText, tidyText, decodeBytes, decodeCp1252, codepageLabel };
