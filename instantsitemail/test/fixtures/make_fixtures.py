"""Generate the .msg / .eml test fixtures for InstantSiteMail.

Standard library only (compressed RTF fixture needs `pip install compressed-rtf`).
The .msg writer is an independent, spec-based implementation of [MS-CFB] /
[MS-OXMSG] so the JS reader is tested against something it didn't produce.
Run:  python3 test/fixtures/make_fixtures.py
"""

import io
import os
import struct
import zipfile
from email.message import EmailMessage
from email.policy import SMTP

HERE = os.path.dirname(os.path.abspath(__file__))
SECTOR = 512
MINI = 64
CUTOFF = 4096
FREESECT, ENDOFCHAIN, FATSECT, NOSTREAM = 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFF


# --- tiny CFB writer ------------------------------------------------------
class Node:
    def __init__(self, name, data=None, children=None):
        self.name, self.data = name, data
        self.children = children if children is not None else ([] if data is None else None)


def write_cfb(root_children):
    root = Node("Root Entry", children=root_children)
    nodes = []

    def collect(n):
        n.id = len(nodes)
        nodes.append(n)
        for c in n.children or []:
            collect(c)

    collect(root)

    # sibling trees: balanced BST ordered by (length, upper-case name)
    for n in nodes:
        n.left = n.right = n.child = NOSTREAM
    for n in nodes:
        if not n.children:
            continue
        kids = sorted(n.children, key=lambda c: (len(c.name), c.name.upper()))

        def bst(lo, hi):
            if lo >= hi:
                return NOSTREAM
            mid = (lo + hi) // 2
            kids[mid].left = bst(lo, mid)
            kids[mid].right = bst(mid + 1, hi)
            return kids[mid].id

        n.child = bst(0, len(kids))

    streams = [n for n in nodes if n.data is not None]
    small = [s for s in streams if len(s.data) < CUTOFF]
    big = [s for s in streams if len(s.data) >= CUTOFF]

    # mini stream + mini FAT
    ministream = bytearray()
    minifat = []
    for s in small:
        if not s.data:
            s.start = ENDOFCHAIN
            continue
        count = (len(s.data) + MINI - 1) // MINI
        s.start = len(minifat)
        minifat += [s.start + i + 1 for i in range(count - 1)] + [ENDOFCHAIN]
        ministream += s.data + b"\0" * (count * MINI - len(s.data))

    def nsec(n_bytes):
        return (n_bytes + SECTOR - 1) // SECTOR

    dir_secs = nsec(len(nodes) * 128)
    minifat_secs = nsec(len(minifat) * 4)
    mini_secs = nsec(len(ministream))
    big_secs = [nsec(len(s.data)) for s in big]
    data_secs = dir_secs + minifat_secs + mini_secs + sum(big_secs)
    fat_secs = 1
    while fat_secs * (SECTOR // 4) < data_secs + fat_secs:
        fat_secs += 1
    assert fat_secs <= 109

    fat = [FATSECT] * fat_secs
    cursor = fat_secs

    def alloc(count):
        nonlocal cursor
        if count == 0:
            return ENDOFCHAIN
        start = cursor
        fat.extend([cursor + i + 1 for i in range(count - 1)] + [ENDOFCHAIN])
        cursor += count
        return start

    dir_start = alloc(dir_secs)
    minifat_start = alloc(minifat_secs)
    mini_start = alloc(mini_secs)
    for s, c in zip(big, big_secs):
        s.start = alloc(c)
    fat += [FREESECT] * (fat_secs * (SECTOR // 4) - len(fat))

    root.start, root.size = (mini_start, len(ministream)) if ministream else (ENDOFCHAIN, 0)

    d = bytearray()
    for n in nodes:
        name = n.name.encode("utf-16-le")
        entry = bytearray(128)
        entry[0 : len(name)] = name
        struct.pack_into("<H", entry, 0x40, len(name) + 2)
        entry[0x42] = 5 if n is root else (2 if n.data is not None else 1)
        entry[0x43] = 1  # black
        struct.pack_into("<III", entry, 0x44, n.left, n.right, n.child)
        start = root.start if n is root else (n.start if n.data is not None else 0)
        size = root.size if n is root else (len(n.data) if n.data is not None else 0)
        struct.pack_into("<II", entry, 0x74, start, size)
        d += entry

    header = bytearray(512)
    header[0:8] = bytes.fromhex("D0CF11E0A1B11AE1")
    struct.pack_into("<HHHHH", header, 0x18, 0x3E, 3, 0xFFFE, 9, 6)
    struct.pack_into("<I", header, 0x2C, fat_secs)
    struct.pack_into("<I", header, 0x30, dir_start)
    struct.pack_into("<I", header, 0x38, CUTOFF)
    struct.pack_into("<II", header, 0x3C, minifat_start if minifat else ENDOFCHAIN, minifat_secs)
    struct.pack_into("<II", header, 0x44, ENDOFCHAIN, 0)
    difat = list(range(fat_secs)) + [FREESECT] * (109 - fat_secs)
    struct.pack_into("<109I", header, 0x4C, *difat)

    def pad(b):
        return bytes(b) + b"\0" * (-len(b) % SECTOR)

    out = bytearray(header)
    out += pad(struct.pack(f"<{len(fat)}I", *fat))
    out += pad(d + b"\0" * (dir_secs * SECTOR - len(d)))
    out += pad(struct.pack(f"<{len(minifat)}I", *minifat) + struct.pack("<I", FREESECT) * (minifat_secs * 128 - len(minifat)))
    out += pad(ministream)
    for s in big:
        out += pad(s.data)
    return bytes(out)


# --- MSG helpers ----------------------------------------------------------
def u(pid, text):
    return Node(f"__substg1.0_{pid:04X}001F", (text + "\0").encode("utf-16-le"))


def a(pid, text, enc="cp1252"):
    return Node(f"__substg1.0_{pid:04X}001E", text.encode(enc) + b"\0")


def b(pid, data):
    return Node(f"__substg1.0_{pid:04X}0102", data)


def props(header_size, fixed):
    out = bytearray(header_size)
    for pid, ptype, value in fixed:
        out += struct.pack("<II", (pid << 16) | ptype, 6) + value.ljust(8, b"\0")
    return Node("__properties_version1.0", bytes(out))


def filetime(year, month, day, hour, minute):
    import datetime

    dt = datetime.datetime(year, month, day, hour, minute, tzinfo=datetime.timezone.utc)
    ticks = int((dt - datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)).total_seconds() * 10_000_000)
    return struct.pack("<Q", ticks)


TINY_PDF = (
    b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
)
BIG_PNG = b"\x89PNG\r\n\x1a\n" + bytes((i * 37) % 251 for i in range(20_000))  # > 4096 -> regular sectors


def make_msg():
    embedded = Node(
        "__substg1.0_3701000D",
        children=[
            props(24, [(0x3FFD, 0x0003, struct.pack("<i", 1252))]),
            a(0x0037, "Level 2 slab - edge detail"),
            a(0x0C1A, "Thabo Nkosi"),
            a(0x5D01, "thabo@engineers.example"),
            a(0x1000, "Please price the revised slab edge. Café drawings to follow."),
        ],
    )
    attach0 = Node(
        "__attach_version1.0_#00000000",
        children=[
            props(8, [(0x3705, 0x0003, struct.pack("<i", 1))]),
            u(0x3707, "S-201 Rev C.pdf"),
            u(0x370E, "application/pdf"),
            b(0x3701, TINY_PDF),
        ],
    )
    attach1 = Node(
        "__attach_version1.0_#00000001",
        children=[
            props(8, [(0x3705, 0x0003, struct.pack("<i", 1))]),
            u(0x3707, "site photo.png"),
            b(0x3701, BIG_PNG),
        ],
    )
    attach2 = Node(
        "__attach_version1.0_#00000002",
        children=[props(8, [(0x3705, 0x0003, struct.pack("<i", 5))]), u(0x3001, "FW original"), embedded],
    )
    root = [
        props(
            32,
            [
                (0x0039, 0x0040, filetime(2026, 10, 13, 7, 45)),
                (0x3FFD, 0x0003, struct.pack("<i", 65001)),
            ],
        ),
        u(0x0037, "RE: Level 2 slab – revised edge detail"),
        u(0x0C1A, "Jane Smith"),
        u(0x5D01, "jane.smith@client.example"),
        u(0x0E04, "Lesego M"),
        u(0x0E03, "QS Team"),
        u(0x1000, "Hi Lesego,\r\n\r\nPlease proceed with the revised edge detail per S-201 Rev C. No cost implication is expected.\r\n\r\nRegards\r\nJane"),
        Node("__nameid_version1.0", children=[]),
        attach0,
        attach1,
        attach2,
    ]
    return write_cfb(root)


def make_rtf_msg():
    import compressed_rtf

    rtf = (
        b"{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}"
        b"{\\*\\htmltag19 <html>}{\\*\\htmltag34 <head>}{\\*\\htmltag41 </head>}"
        b"{\\*\\htmltag50 <body>}\\htmlrtf {\\htmlrtf0 "
        b"{\\*\\htmltag64 <p>}Concrete pour on gridline C\\'96D is on hold.{\\*\\htmltag72 </p>}"
        b"\\htmlrtf\\par\\htmlrtf0 {\\*\\htmltag64 <p>}Reply by Friday.{\\*\\htmltag72 </p>}"
        b"\\htmlrtf }\\htmlrtf0 {\\*\\htmltag58 </body>}{\\*\\htmltag27 </html>}}"
    )
    root = [
        props(32, []),
        u(0x0037, "Pour on hold"),
        a(0x0C1A, "Site Engineer"),
        b(0x1009, compressed_rtf.compress(rtf, compressed=True)),
    ]
    return write_cfb(root)


def make_docx(text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr(
            "word/document.xml",
            '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>'
            + "".join(f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>" for line in text)
            + "</w:body></w:document>",
        )
    return buf.getvalue()


def make_xlsx():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/workbook.xml", '<workbook><sheets><sheet name="BOQ" sheetId="1"/></sheets></workbook>')
        z.writestr("xl/sharedStrings.xml", "<sst><si><t>Item</t></si><si><t>Rebar Y12</t></si><si><t>Qty &amp; unit</t></si></sst>")
        z.writestr(
            "xl/worksheets/sheet1.xml",
            '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>'
            '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>1.25</v></c></row></sheetData></worksheet>',
        )
    return buf.getvalue()


def make_eml():
    fwd = EmailMessage()
    fwd["From"] = "Architect <arch@design.example>"
    fwd["To"] = "jane.smith@client.example"
    fwd["Subject"] = "Façade change"
    fwd["Date"] = "Mon, 12 Oct 2026 09:00:00 +0200"
    fwd.set_content("Window W4 now 2400 wide.\n")

    m = EmailMessage()
    m["From"] = "Jane Smith <jane.smith@client.example>"
    m["To"] = "Lesego M <lesego@contractor.example>"
    m["Cc"] = "qs@contractor.example"
    m["Subject"] = "Façade – instruction to proceed"
    m["Date"] = "Tue, 13 Oct 2026 07:45:00 +0200"
    m.set_content("Please proceed with W4 at 2400 wide – see attached elevation.\nRégards, Jane\n", cte="quoted-printable")
    m.add_alternative("<p>Please proceed with <b>W4</b> at 2400 wide &ndash; see attached elevation.</p>", subtype="html")
    m.add_attachment(TINY_PDF, maintype="application", subtype="pdf", filename="A-301 Élévation Rev B.pdf")
    m.add_attachment(make_docx(["Spec clause 4.2", "Aluminium &amp; glazing"]), maintype="application",
                     subtype="vnd.openxmlformats-officedocument.wordprocessingml.document", filename="spec.docx")
    m.add_attachment(make_xlsx(), maintype="application", subtype="octet-stream", filename="boq.xlsx")
    m.add_attachment(b"AC1032 fake dwg", maintype="application", subtype="octet-stream", filename="A-301.dwg")
    m.add_attachment(fwd)
    return m.as_bytes(policy=SMTP)


if __name__ == "__main__":
    for name, data in [("sample.msg", make_msg()), ("rtf-only.msg", make_rtf_msg()), ("sample.eml", make_eml())]:
        with open(os.path.join(HERE, name), "wb") as f:
            f.write(data)
        print("wrote", name, len(data), "bytes")
