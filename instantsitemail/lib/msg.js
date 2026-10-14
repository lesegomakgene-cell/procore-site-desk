// Outlook .msg reader (no dependencies).
//
// A .msg file is an OLE "Compound File Binary" (CFB) container - a tiny FAT
// filesystem inside one file - holding MAPI properties as streams. This file
// implements just enough of [MS-CFB] and [MS-OXMSG] to pull out the subject,
// people, dates, body (plain, HTML or compressed RTF) and every attachment,
// including emails forwarded as attachments (embedded .msg).

const { htmlToText, tidyText, decodeBytes, decodeCp1252, codepageLabel } = require("./text");

const END_OF_CHAIN = 0xfffffffe;
const MAX_REG_SECT = 0xfffffffa;
const NO_STREAM = 0xffffffff;

// --- Compound File Binary reader -----------------------------------------
function readCfb(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) {
    throw new Error("Not an Outlook .msg file (missing compound-file signature)");
  }
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buf.readUInt16LE(0x20);
  const numFatSectors = buf.readUInt32LE(0x2c);
  const firstDirSector = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const firstMiniFatSector = buf.readUInt32LE(0x3c);
  const firstDifatSector = buf.readUInt32LE(0x44);
  const numDifatSectors = buf.readUInt32LE(0x48);

  const sectorOffset = (n) => (n + 1) * sectorSize;
  const perSector = sectorSize / 4;

  // Locate the FAT sectors: 109 in the header, the rest in the DIFAT chain.
  const fatSectorIds = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s < MAX_REG_SECT) fatSectorIds.push(s);
  }
  let difat = firstDifatSector;
  for (let n = 0; difat < MAX_REG_SECT && n < numDifatSectors; n++) {
    const off = sectorOffset(difat);
    for (let i = 0; i < perSector - 1; i++) {
      const s = buf.readUInt32LE(off + i * 4);
      if (s < MAX_REG_SECT) fatSectorIds.push(s);
    }
    difat = buf.readUInt32LE(off + (perSector - 1) * 4);
  }
  if (fatSectorIds.length < numFatSectors) {
    throw new Error("Damaged .msg file (FAT is incomplete)");
  }

  const fat = [];
  for (const s of fatSectorIds) {
    const off = sectorOffset(s);
    if (off + sectorSize > buf.length) break;
    for (let i = 0; i < perSector; i++) fat.push(buf.readUInt32LE(off + i * 4));
  }

  function chain(start, table) {
    const out = [];
    let s = start;
    while (s < MAX_REG_SECT) {
      if (out.length > table.length) throw new Error("Damaged .msg file (sector loop)");
      out.push(s);
      s = table[s];
      if (s === undefined) throw new Error("Damaged .msg file (bad sector reference)");
    }
    return out;
  }

  function readRegular(start, size) {
    const parts = chain(start, fat).map((s) => buf.subarray(sectorOffset(s), sectorOffset(s) + sectorSize));
    const all = Buffer.concat(parts);
    return size === undefined ? all : all.subarray(0, size);
  }

  // Directory entries (128 bytes each)
  const dirBuf = readRegular(firstDirSector);
  const entries = [];
  for (let o = 0; o + 128 <= dirBuf.length; o += 128) {
    const nameLen = dirBuf.readUInt16LE(o + 0x40);
    entries.push({
      name: dirBuf.toString("utf16le", o, o + Math.max(0, Math.min(64, nameLen) - 2)),
      type: dirBuf[o + 0x42], // 1 storage, 2 stream, 5 root
      left: dirBuf.readUInt32LE(o + 0x44),
      right: dirBuf.readUInt32LE(o + 0x48),
      child: dirBuf.readUInt32LE(o + 0x4c),
      start: dirBuf.readUInt32LE(o + 0x74),
      size: dirBuf.readUInt32LE(o + 0x78),
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw new Error("Damaged .msg file (no root entry)");

  const miniStream = root.start < MAX_REG_SECT ? readRegular(root.start, root.size) : Buffer.alloc(0);
  const miniFat = [];
  if (firstMiniFatSector < MAX_REG_SECT) {
    const mf = readRegular(firstMiniFatSector);
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
  }

  function readStream(entry) {
    if (entry.size === 0) return Buffer.alloc(0);
    if (entry.size < miniCutoff) {
      const parts = chain(entry.start, miniFat).map((s) =>
        miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize)
      );
      return Buffer.concat(parts).subarray(0, entry.size);
    }
    return readRegular(entry.start, entry.size);
  }

  // Build a tree of storages; children of a storage sit in a red-black tree.
  function build(id, seen) {
    const e = entries[id];
    const node = { name: e.name, type: e.type, entry: e, children: new Map() };
    if (e.type === 1 || e.type === 5) {
      const stack = [e.child];
      while (stack.length) {
        const cid = stack.pop();
        if (cid === NO_STREAM || cid >= entries.length || seen.has(cid)) continue;
        seen.add(cid);
        const c = entries[cid];
        stack.push(c.left, c.right);
        if (c.type === 1 || c.type === 2) node.children.set(c.name, build(cid, seen));
      }
    }
    return node;
  }

  return { root: build(0, new Set([0])), readStream };
}

// --- Compressed RTF ([MS-OXRTFCP]) ---------------------------------------
const RTF_PREBUF =
  "{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx";

function decompressRtf(buf) {
  if (buf.length < 16) return "";
  const compSize = buf.readUInt32LE(0);
  const rawSize = buf.readUInt32LE(4);
  const magic = buf.readUInt32LE(8);
  if (magic === 0x414c454d) return buf.subarray(16, 16 + rawSize).toString("latin1"); // "MELA" = stored
  if (magic !== 0x75465a4c) return ""; // not "LZFu"
  const dict = Buffer.alloc(4096);
  dict.write(RTF_PREBUF, 0, "latin1");
  let w = RTF_PREBUF.length;
  const out = [];
  const end = Math.min(buf.length, compSize + 4);
  let i = 16;
  outer: while (i < end) {
    const control = buf[i++];
    for (let bit = 0; bit < 8 && i < end; bit++) {
      if (control & (1 << bit)) {
        if (i + 1 >= end) break outer;
        const word = (buf[i] << 8) | buf[i + 1];
        i += 2;
        const offset = word >> 4;
        const len = (word & 0xf) + 2;
        if (offset === w) break outer;
        for (let k = 0; k < len; k++) {
          const b = dict[(offset + k) % 4096];
          out.push(b);
          dict[w] = b;
          w = (w + 1) % 4096;
        }
      } else {
        const b = buf[i++];
        out.push(b);
        dict[w] = b;
        w = (w + 1) % 4096;
      }
    }
  }
  return Buffer.from(out).toString("latin1");
}

const RTF_SKIP = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "footer",
  "headerl", "headerr", "footerl", "footerr", "listtable", "listoverridetable",
  "rsidtbl", "generator", "themedata", "colorschememapping", "datastore",
  "latentstyles", "xmlnstbl", "mmathPr", "filetbl", "revtbl",
]);

// Good-enough RTF -> text. Handles Outlook's HTML-in-RTF encapsulation.
function rtfToText(rtf) {
  const fromHtml = /\\fromhtml1/.test(rtf);
  let state = { skip: false, htmlrtf: false, fresh: false, uc: 1 };
  const stack = [];
  let out = "";
  let pendingSkip = 0;
  const emit = (s) => {
    if (pendingSkip > 0) {
      const n = Math.min(pendingSkip, s.length);
      pendingSkip -= n;
      s = s.slice(n);
    }
    if (s && !state.skip && !state.htmlrtf) out += s;
  };
  let i = 0;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === "{") {
      stack.push(state);
      state = { ...state, fresh: true };
      i++;
      continue;
    }
    if (c === "}") {
      state = stack.pop() || state;
      i++;
      continue;
    }
    if (c === "\\") {
      const n = rtf[i + 1];
      if (n === undefined) break;
      if (/[a-zA-Z]/.test(n)) {
        let j = i + 1;
        while (j < rtf.length && /[a-zA-Z]/.test(rtf[j])) j++;
        const word = rtf.slice(i + 1, j);
        let k = j;
        while (k < rtf.length && /[-0-9]/.test(rtf[k])) k++;
        const param = k > j ? parseInt(rtf.slice(j, k), 10) : null;
        if (rtf[k] === " ") k++;
        i = k;
        const wasFresh = state.fresh;
        state.fresh = false;
        if (wasFresh && RTF_SKIP.has(word)) state.skip = true;
        else if (word === "htmlrtf") state.htmlrtf = param !== 0;
        else if (word === "par" || word === "line") emit("\n");
        else if (word === "tab") emit("\t");
        else if (word === "uc") state.uc = param == null ? 1 : param;
        else if (word === "u" && param != null) {
          emit(String.fromCharCode(param < 0 ? param + 65536 : param));
          pendingSkip = state.uc;
        } else if (word === "emdash") emit("—");
        else if (word === "endash") emit("–");
        else if (word === "bullet") emit("•");
        else if (word === "lquote") emit("‘");
        else if (word === "rquote") emit("’");
        else if (word === "ldblquote") emit("“");
        else if (word === "rdblquote") emit("”");
        continue;
      }
      state.fresh = false;
      if (n === "*") {
        // Optional destination: keep encapsulated HTML tags, skip the rest.
        const m = /^\\\*\\([a-zA-Z]+)/.exec(rtf.slice(i, i + 40));
        if (!(fromHtml && m && m[1] === "htmltag")) state.skip = true;
        else {
          i += m[0].length;
          while (/[-0-9]/.test(rtf[i])) i++;
          if (rtf[i] === " ") i++;
          continue;
        }
        i += 2;
        continue;
      }
      if (n === "'") {
        const byte = parseInt(rtf.substr(i + 2, 2), 16);
        if (!Number.isNaN(byte)) emit(decodeCp1252([byte]));
        i += 4;
        continue;
      }
      if (n === "~") emit(" ");
      else if (n === "\n" || n === "\r") emit("\n");
      else if (n === "\\" || n === "{" || n === "}") emit(n);
      i += 2;
      continue;
    }
    if (c !== "\r" && c !== "\n") emit(c);
    i++;
  }
  return fromHtml ? htmlToText(out) : tidyText(out);
}

// --- MAPI property access ------------------------------------------------
const PT_LONG = 0x0003;
const PT_BOOLEAN = 0x000b;
const PT_SYSTIME = 0x0040;

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

function filetimeToDate(lo, hi) {
  const ms = (hi * 4294967296 + lo) / 10000 - 11644473600000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function propertyReader(cfb, storage, headerSize) {
  const fixed = new Map();
  const propsNode = storage.children.get("__properties_version1.0");
  if (propsNode) {
    const p = cfb.readStream(propsNode.entry);
    for (let o = headerSize; o + 16 <= p.length; o += 16) {
      const tag = p.readUInt32LE(o);
      fixed.set(tag >>> 16, { type: tag & 0xffff, buf: p.subarray(o + 8, o + 16) });
    }
  }
  const cp = (() => {
    const v = fixed.get(0x3ffd); // PR_MESSAGE_CODEPAGE
    return v && v.type === PT_LONG ? v.buf.readInt32LE(0) : 0;
  })();

  const stream = (id, type) => {
    const n = storage.children.get(`__substg1.0_${hex4(id)}${hex4(type)}`);
    return n && n.type === 2 ? cfb.readStream(n.entry) : null;
  };
  return {
    str(id) {
      const u = stream(id, 0x001f);
      if (u) return u.toString("utf16le").replace(/\0+$/, "");
      const a = stream(id, 0x001e);
      if (a) return decodeBytes(a, codepageLabel(cp)).replace(/\0+$/, "");
      return "";
    },
    bin(id) {
      return stream(id, 0x0102);
    },
    long(id) {
      const v = fixed.get(id);
      return v && v.type === PT_LONG ? v.buf.readInt32LE(0) : null;
    },
    bool(id) {
      const v = fixed.get(id);
      return v && v.type === PT_BOOLEAN ? v.buf.readUInt16LE(0) !== 0 : null;
    },
    time(id) {
      const v = fixed.get(id);
      return v && v.type === PT_SYSTIME ? filetimeToDate(v.buf.readUInt32LE(0), v.buf.readUInt32LE(4)) : null;
    },
    codepage: cp,
  };
}

function headerValue(headers, name) {
  const m = new RegExp(`^${name}:[ \\t]*(.*(?:\\r?\\n[ \\t].*)*)`, "im").exec(headers || "");
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
}

function parseMessageStorage(cfb, storage, headerSize, depth) {
  const p = propertyReader(cfb, storage, headerSize);
  const transportHeaders = p.str(0x007d);

  let fromEmail = p.str(0x5d01) || p.str(0x0c1f) || p.str(0x0065);
  if (/^\/o=/i.test(fromEmail)) fromEmail = p.str(0x5d01) || ""; // Exchange X.500 address, not useful
  const fromName = p.str(0x0c1a) || p.str(0x0042);
  const from = fromName && fromEmail && fromName !== fromEmail ? `${fromName} <${fromEmail}>` : fromName || fromEmail || headerValue(transportHeaders, "From");

  let body = p.str(0x1000);
  let html = "";
  const htmlBin = p.bin(0x1013);
  if (htmlBin) {
    const cpid = p.long(0x3fde); // PR_INTERNET_CPID
    html = decodeBytes(htmlBin, cpid ? codepageLabel(cpid) : "utf-8");
  } else {
    html = p.str(0x1013);
  }
  if (!body && html) body = htmlToText(html);
  if (!body) {
    const rtf = p.bin(0x1009);
    if (rtf) body = rtfToText(decompressRtf(rtf));
  }

  const attachments = [];
  const attachStorages = [...storage.children.values()]
    .filter((n) => n.type === 1 && n.name.startsWith("__attach_version1.0_#"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const a of attachStorages) {
    const ap = propertyReader(cfb, a, 8);
    const name = ap.str(0x3707) || ap.str(0x3704) || ap.str(0x3001) || "attachment";
    const embedded = a.children.get("__substg1.0_3701000D");
    if (embedded && embedded.type === 1) {
      if (depth < 5) {
        const inner = parseMessageStorage(cfb, embedded, 24, depth + 1);
        attachments.push({ name: (inner.subject || name) + ".msg", embedded: inner });
      }
      continue;
    }
    const data = ap.bin(0x3701);
    if (!data) continue; // linked/by-reference attachments have no bytes
    attachments.push({
      name,
      mime: ap.str(0x370e),
      contentId: ap.str(0x3712),
      hidden: ap.bool(0x7ffe) === true,
      data,
    });
  }

  return {
    subject: p.str(0x0037) || headerValue(transportHeaders, "Subject"),
    from,
    to: p.str(0x0e04) || headerValue(transportHeaders, "To"),
    cc: p.str(0x0e03) || headerValue(transportHeaders, "Cc"),
    date: p.time(0x0039) || p.time(0x0e06) || headerValue(transportHeaders, "Date"),
    body: tidyText(body || ""),
    html,
    attachments,
  };
}

function parseMsg(buf) {
  const cfb = readCfb(buf);
  return parseMessageStorage(cfb, cfb.root, 32, 0);
}

module.exports = { parseMsg, readCfb, decompressRtf, rtfToText };
