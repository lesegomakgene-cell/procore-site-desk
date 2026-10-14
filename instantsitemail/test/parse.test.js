// Run: node --test     (from the instantsitemail folder)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { parseMsg } = require("../lib/msg");
const { parseEml } = require("../lib/eml");
const { parseDropped } = require("../lib/files");
const { buildAnalyseRequest } = require("../server");

const fx = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n));

test(".msg: headers, body, attachments and forwarded email", () => {
  const m = parseMsg(fx("sample.msg"));
  assert.strictEqual(m.subject, "RE: Level 2 slab – revised edge detail");
  assert.strictEqual(m.from, "Jane Smith <jane.smith@client.example>");
  assert.strictEqual(m.to, "Lesego M");
  assert.strictEqual(m.cc, "QS Team");
  assert.strictEqual(m.date, "2026-10-13T07:45:00.000Z");
  assert.match(m.body, /proceed with the revised edge detail per S-201 Rev C/);
  assert.strictEqual(m.attachments.length, 3);

  const [pdf, png, fwd] = m.attachments;
  assert.strictEqual(pdf.name, "S-201 Rev C.pdf");
  assert.strictEqual(pdf.mime, "application/pdf");
  assert.ok(pdf.data.toString("latin1").startsWith("%PDF"));
  assert.strictEqual(png.name, "site photo.png");
  assert.strictEqual(png.data.length, 20008); // regular-sector stream
  assert.strictEqual(png.data[0], 0x89);

  assert.strictEqual(fwd.embedded.subject, "Level 2 slab - edge detail");
  assert.strictEqual(fwd.embedded.from, "Thabo Nkosi <thabo@engineers.example>");
  assert.strictEqual(fwd.embedded.body, "Please price the revised slab edge. Café drawings to follow.");
});

test(".msg: compressed RTF body with encapsulated HTML", () => {
  const m = parseMsg(fx("rtf-only.msg"));
  assert.strictEqual(m.subject, "Pour on hold");
  assert.strictEqual(m.body, "Concrete pour on gridline C–D is on hold.\nReply by Friday.");
});

test(".eml: MIME parts, encodings and forwarded message", () => {
  const m = parseEml(fx("sample.eml"));
  assert.strictEqual(m.subject, "Façade – instruction to proceed");
  assert.strictEqual(m.from, "Jane Smith <jane.smith@client.example>");
  assert.strictEqual(m.cc, "qs@contractor.example");
  assert.strictEqual(m.date, "2026-10-13T05:45:00.000Z");
  assert.match(m.body, /Please proceed with W4 at 2400 wide – see attached elevation\.\nRégards, Jane/);
  const names = m.attachments.map((a) => a.name);
  assert.deepStrictEqual(names, ["A-301 Élévation Rev B.pdf", "spec.docx", "boq.xlsx", "A-301.dwg", "Façade change.eml"]);
  assert.match(m.attachments[4].embedded.body, /Window W4 now 2400 wide/);
});

test("parseDropped classifies attachments and flattens the thread", () => {
  const r = parseDropped("mail.eml", fx("sample.eml"));
  assert.strictEqual(r.kind, "email");
  assert.strictEqual(r.thread.length, 2);
  assert.strictEqual(r.thread[1].level, 1);
  const byName = Object.fromEntries(r.documents.map((d) => [d.name, d]));
  assert.strictEqual(byName["A-301 Élévation Rev B.pdf"].kind, "pdf");
  assert.strictEqual(byName["spec.docx"].kind, "text");
  assert.match(byName["spec.docx"].text, /Spec clause 4\.2\nAluminium & glazing/);
  assert.match(byName["boq.xlsx"].text, /=== Sheet: BOQ ===\nItem\t\tQty & unit\nRebar Y12\t\t1\.25/);
  assert.strictEqual(byName["A-301.dwg"].kind, "unsupported");
  assert.strictEqual(byName["A-301.dwg"].include, false);

  const msg = parseDropped("x.msg", fx("sample.msg"));
  assert.strictEqual(msg.thread.length, 2);
  assert.deepStrictEqual(msg.documents.map((d) => d.kind), ["pdf", "image"]);
});

test("loose files are treated as documents", () => {
  const r = parseDropped("note.txt", Buffer.from("Gridline 4 setting out query"));
  assert.strictEqual(r.kind, "document");
  assert.strictEqual(r.documents[0].text, "Gridline 4 setting out query");
});

test("analysis request puts documents before the email and lists skipped files", () => {
  const r = parseDropped("mail.eml", fx("sample.eml"));
  const { messages, system } = buildAnalyseRequest({
    thread: r.thread,
    documents: r.documents,
    notes: "We flagged this in EWN 012",
    profile: { name: "Lesego", contract: "JBCC PBA" },
  });
  assert.match(system, /contracts manager/);
  const content = messages[0].content;
  assert.strictEqual(content[0].type, "document");
  assert.strictEqual(content[0].source.media_type, "application/pdf");
  const last = content[content.length - 1].text;
  assert.match(last, /A-301\.dwg .*NOT REVIEWED/);
  assert.match(last, /Form of contract: JBCC PBA/);
  assert.match(last, /EWN 012/);
  assert.match(last, /EMAIL TO ANALYSE[\s\S]*Façade – instruction to proceed/);
});

test("rejects garbage .msg files cleanly", () => {
  assert.throws(() => parseMsg(Buffer.from("not a msg")), /Not an Outlook \.msg file/);
});
