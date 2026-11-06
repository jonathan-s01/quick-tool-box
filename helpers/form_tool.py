#!/usr/bin/env python3
"""Form filler helper, using PyMuPDF.

  form_tool.py analyze IN.pdf OUT.json            Finds questions, sections, signature spots and existing content.
  form_tool.py fill    IN.pdf PLAN.json OUT.pdf   Fills answers. Only adds to the file (incremental save).
  form_tool.py verify  ORIG.pdf FILLED.pdf PLAN.json OUT.json
                                                  Checks nothing changed outside the answers.
  form_tool.py crop    IN.pdf PAGE X0 Y0 X1 Y1 OUT.png   Picture of part of a page (for reading handwriting).
  form_tool.py remove-xfa IN.pdf OUT.pdf          Removes the XFA part so the plain form fields are used.

Errors are printed as WRAPPER_ERROR: message.
"""
import json
import re
import statistics
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    print("WRAPPER_ERROR: PyMuPDF is not installed.", flush=True)
    sys.exit(3)


def fail(msg):
    print(f"WRAPPER_ERROR: {msg}", flush=True)
    sys.exit(2)


def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def R(r):
    return [round(v, 2) for v in r]


SIG_RE = re.compile(r"\b(signature|signed|sign here|signataire|signature du)\b", re.I)
DATE_RE = re.compile(r"\b(date|dated|yyyy|aaaa|dd/mm|mm/dd)\b", re.I)


# ---------------------------------------------------------------- page text helpers

class PageText:
    def __init__(self, page):
        self.page = page
        # Text typed into form fields is not part of the printed form, so leave it out.
        self.widget_rects = [fitz.Rect(w.rect) for w in (page.widgets() or [])]
        inside = lambda r: any(wr.contains(fitz.Point((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)) for wr in self.widget_rects)
        self.words = [(fitz.Rect(w[:4]), w[4]) for w in page.get_text("words", sort=True) if not inside(w[:4])]
        self.lines = []  # (rect, text, size, bold)
        d = page.get_text("dict")
        for b in d.get("blocks", []):
            for ln in b.get("lines", []):
                spans = [s for s in ln.get("spans", []) if s.get("text", "").strip()]
                if not spans:
                    continue
                if inside(ln["bbox"]):
                    continue
                text = norm("".join(s["text"] for s in ln["spans"]))
                size = max(s["size"] for s in spans)
                bold = all((s["flags"] & 16) or "bold" in s.get("font", "").lower() for s in spans)
                self.lines.append((fitz.Rect(ln["bbox"]), text, size, bold))
        self.lines.sort(key=lambda l: (round(l[0].y0 / 3), l[0].x0))

    def run_near(self, words, anchor_x, side):
        """Contiguous run of words nearest to anchor_x (breaks at big gaps)."""
        if not words:
            return ""
        words = sorted(words, key=lambda w: w[0].x0)
        if side == "left":
            run = [words[-1]]
            for w in reversed(words[:-1]):
                if run[0][0].x0 - w[0].x1 > 18:
                    break
                run.insert(0, w)
        else:
            run = [words[0]]
            for w in words[1:]:
                if w[0].x0 - run[-1][0].x1 > 18:
                    break
                run.append(w)
        return norm(" ".join(t for _, t in run))

    def left_of(self, r, maxdist=260):
        band = [w for w in self.words if w[0].x1 <= r.x0 + 2 and r.x0 - w[0].x1 < maxdist
                and min(w[0].y1, r.y1) - max(w[0].y0, r.y0) > min(w[0].height, r.height) * 0.4]
        return self.run_near(band, r.x0, "left")

    def right_of(self, r, maxdist=220):
        band = [w for w in self.words if w[0].x0 >= r.x1 - 2 and w[0].x0 - r.x1 < maxdist
                and min(w[0].y1, r.y1) - max(w[0].y0, r.y0) > min(w[0].height, r.height) * 0.4]
        return self.run_near(band, r.x1, "right")

    def above(self, r, gap=16):
        band = [w for w in self.words if r.y0 - gap <= w[0].y1 <= r.y0 + 2
                and w[0].x1 > r.x0 - 4 and w[0].x0 < r.x1 + 4]
        if not band:
            return ""
        bottom = max(w[0].y1 for w in band)
        band = [w for w in band if w[0].y1 > bottom - 4]
        return norm(" ".join(t for _, t in sorted(band, key=lambda w: w[0].x0)))

    def below(self, r, gap=13):
        band = [w for w in self.words if r.y1 - 2 <= w[0].y0 <= r.y1 + gap
                and w[0].x1 > r.x0 - 4 and w[0].x0 < r.x1 + 4]
        if not band:
            return ""
        top = min(w[0].y0 for w in band)
        band = [w for w in band if w[0].y0 < top + 4]
        return norm(" ".join(t for _, t in sorted(band, key=lambda w: w[0].x0)))

    def text_in(self, r):
        return norm(" ".join(t for wr, t in self.words if wr.intersects(r)))

    def lines_above(self, r, stop_rows, height=200, maxchars=900):
        """The paragraph just above a signature spot, for 'what you are signing'.
        Stops at a gap, at a row that holds another question, or at a heading."""
        cands = sorted([l for l in self.lines if r.y0 - height <= l[0].y1 <= r.y0 + 2 and l[0].y0 < r.y0 - 1],
                       key=lambda l: -l[0].y1)
        out = []
        prev_top = r.y0
        for rect, text, size, bold in cands:
            if prev_top - rect.y1 > (45 if not out else 16):
                break
            if any(rect.y0 - 2 <= y <= rect.y1 + 2 for y in stop_rows):
                break
            if SIG_RE.fullmatch(text.strip(" :")):
                continue
            out.insert(0, text)
            prev_top = rect.y0
            if bold:
                break
        return norm(" ".join(out))[-maxchars:]


def clean_label(s):
    s = norm(s).strip(" :.*_-")
    s = re.sub(r"_{2,}", "", s).strip()
    return s


def pretty_name(name):
    n = re.sub(r"\[\d+\]", "", name or "")
    n = n.split(".")[-1]
    n = re.sub(r"([a-z])([A-Z])", r"\1 \2", n).replace("_", " ")
    return norm(n)


# ---------------------------------------------------------------- analysis

def has_xfa(doc):
    try:
        cat = doc.pdf_catalog()
        t, v = doc.xref_get_key(cat, "AcroForm")
        if t == "xref":
            x = int(v.split()[0])
            t2, _ = doc.xref_get_key(x, "XFA")
            return t2 not in ("null", None)
        if t == "dict":
            return "/XFA" in v
    except Exception:  # noqa: BLE001
        pass
    return False


def headings(doc_pages):
    sizes = [l[2] for pt in doc_pages for l in pt.lines]
    med = statistics.median(sizes) if sizes else 10
    found = []
    for pi, pt in enumerate(doc_pages):
        for rect, text, size, bold in pt.lines:
            words = len(text.split())
            if len(text) > 90 or words == 0 or text.endswith(":"):
                continue
            if size >= med * 1.18 or (bold and size >= med * 0.98 and words <= 10 and not text[-1].isdigit()):
                found.append({"page": pi, "y": rect.y0, "text": text})
    return found, med


def section_for(heads, page, y):
    best = None
    for h in heads:
        if (h["page"], h["y"]) <= (page, y + 1):
            best = h
    return best


def analyze(doc):
    pages = [PageText(p) for p in doc]
    heads, _ = headings(pages)
    fields = []
    radios = {}
    used_rects = {}  # page -> rects already covered by widgets

    for pi, page in enumerate(doc):
        pt = pages[pi]
        for wd in page.widgets() or []:
            r = fitz.Rect(wd.rect)
            used_rects.setdefault(pi, []).append(r)
            t = wd.field_type_string
            flags = wd.field_flags or 0
            tip = clean_label(wd.field_label) if wd.field_label and wd.field_label != wd.field_name else ""
            base = {
                "page": pi + 1, "rect": R(r), "xref": wd.xref, "name": wd.field_name or "",
                "required": bool(flags & 2), "readonly": bool(flags & 1),
            }
            if t == "RadioButton":
                g = radios.setdefault(wd.field_name, {"widgets": [], "page": pi + 1, "tip": tip})
                g["widgets"].append({"xref": wd.xref, "on": str(wd.on_state()), "label": clean_label(pt.right_of(r)) or clean_label(pt.left_of(r)),
                                     "rect": R(r), "checked": bool(wd.field_value) and str(wd.field_value) not in ("Off", "False")})
                g.setdefault("first", r)
                g.setdefault("pt", pt)
                g["required"] = base["required"]
                continue
            left = clean_label(pt.left_of(r))
            above = clean_label(pt.above(r))
            below = clean_label(pt.below(r))
            if t == "CheckBox":
                label = tip or clean_label(pt.right_of(r)) or left or above or pretty_name(wd.field_name)
                kind = "checkbox"
            elif t == "Signature":
                label = tip or left or above or below or "Signature"
                kind = "signature"
            else:
                label = tip or left or above or below or pretty_name(wd.field_name)
                kind = {"ComboBox": "select", "ListBox": "select", "Text": "text"}.get(t, "text")
            value = wd.field_value
            if kind == "checkbox":
                value = bool(value) and str(value) not in ("Off", "False")
            f = dict(base, id=f"w{wd.xref}", kind=kind, label=label,
                     context=norm(" ".join(x for x in (above, left, below) if x and x != label)),
                     maxlen=(wd.text_maxlen or 0) if kind == "text" else 0,
                     multiline=bool(flags & 4096) if kind == "text" else False,
                     comb=bool(flags & (1 << 24)) if kind == "text" else False,
                     options=list(wd.choice_values or []) if kind == "select" else [],
                     value=value if value not in (None, "") else ("" if kind != "checkbox" else False))
            if kind == "text" and SIG_RE.search(label) and not DATE_RE.search(label):
                f["kind"] = "signature"
                f["textSignature"] = True
            fields.append(f)

    for name, g in radios.items():
        pt = g.pop("pt")
        first = g.pop("first")
        q = g["tip"] or clean_label(pt.left_of(fitz.Rect(g["widgets"][0]["rect"]))) or clean_label(pt.above(first, 24)) or pretty_name(name)
        opt_labels = {w["label"] for w in g["widgets"]}
        if q in opt_labels:
            q = clean_label(pt.above(first, 24)) or pretty_name(name)
        fields.append({
            "id": "r" + re.sub(r"\W", "_", name)[:40] + str(len(fields)), "kind": "radio", "page": g["page"], "rect": g["widgets"][0]["rect"],
            "name": name, "label": q, "context": "", "required": g.get("required", False), "readonly": False,
            "options": [{"value": w["on"], "label": w["label"] or w["on"]} for w in g["widgets"]],
            "widgets": [w["xref"] for w in g["widgets"]], "rects": [w["rect"] for w in g["widgets"]],
            "value": next((w["on"] for w in g["widgets"] if w["checked"]), ""),
        })

    flat = not any(f for f in fields)
    if flat:
        fields.extend(find_blanks(doc, pages))

    fields.sort(key=lambda f: (f["page"], round(f["rect"][1] / 4), f["rect"][0]))
    for f in fields:
        s = section_for(heads, f["page"] - 1, f["rect"][1])
        f["section"] = s["text"] if s else ""

    # Section notes: text between a heading and the first question under it.
    notes = {}
    for h in heads:
        pt = pages[h["page"]]
        after = [f["rect"][1] for f in fields if f["page"] - 1 == h["page"] and f["rect"][1] > h["y"] + 2]
        after += [g["y"] for g in heads if g["page"] == h["page"] and g["y"] > h["y"] + 2]
        first_y = min(after or [h["y"] + 220])
        txt = [l[1] for l in pt.lines if h["y"] + 2 < l[0].y0 < first_y - 2]
        t = norm(" ".join(txt))
        if t and h["text"] not in notes:
            notes[h["text"]] = t[:900]

    # Signature spots: what you are signing, and a date field next to it.
    sigs = []
    for f in fields:
        if f["kind"] != "signature":
            continue
        pt = pages[f["page"] - 1]
        r = fitz.Rect(f["rect"])
        rows = [(g["rect"][1] + g["rect"][3]) / 2 for g in fields if g is not f and g["page"] == f["page"] and g["rect"][3] < r.y0]
        f["attestation"] = pt.lines_above(r, rows)
        date = None
        for g in fields:
            if g is f or g["page"] != f["page"] or g["kind"] not in ("text", "date"):
                continue
            gr = fitz.Rect(g["rect"])
            if DATE_RE.search(g["label"] + " " + g.get("context", "")) and abs(gr.y0 - r.y0) < 40 and abs(gr.x0 - r.x0) < 450:
                date = g["id"]
                break
        f["dateField"] = date
        sigs.append(f["id"])

    existing = find_existing(doc, pages, fields)
    return {
        "pages": doc.page_count,
        "xfa": has_xfa(doc),
        "flat": flat,
        "hasWidgets": not flat,
        "fields": fields,
        "notes": notes,
        "existing": existing,
        "encrypted": bool(doc.is_encrypted),
        "title": norm((doc.metadata or {}).get("title", "")),
    }


def find_blanks(doc, pages):
    """Blanks on forms without real fields: underscore runs, drawn lines and empty boxes."""
    out = []
    n = 0
    for pi, page in enumerate(doc):
        pt = pages[pi]
        cands = []
        for wr, t in pt.words:
            if re.fullmatch(r"_{4,}[:.]?", t):
                cands.append(("line", fitz.Rect(wr.x0, wr.y0, wr.x1, wr.y1)))
        try:
            drawings = page.get_drawings()
        except Exception:  # noqa: BLE001
            drawings = []
        for d in drawings:
            for it in d.get("items", []):
                if it[0] == "l":
                    p1, p2 = it[1], it[2]
                    if abs(p1.y - p2.y) < 1 and abs(p2.x - p1.x) >= 45:
                        x0, x1 = sorted((p1.x, p2.x))
                        cands.append(("line", fitz.Rect(x0, p1.y - 14, x1, p1.y)))
                elif it[0] == "re":
                    r = fitz.Rect(it[1])
                    if r.height < 2.2 and r.width >= 45:
                        cands.append(("line", fitz.Rect(r.x0, r.y0 - 14, r.x1, r.y0)))
                    elif 7 <= r.width <= 15 and 7 <= r.height <= 15 and abs(r.width - r.height) < 3:
                        cands.append(("check", r))
                    elif r.width >= 40 and 12 <= r.height <= 40:
                        cands.append(("box", r))
        seen = []
        for kind, r in cands:
            if any(abs(r.x0 - s.x0) < 3 and abs(r.y1 - s.y1) < 3 and abs(r.x1 - s.x1) < 6 for s in seen):
                continue
            inner = fitz.Rect(r.x0 + 1, r.y0 + 1, r.x1 - 1, r.y1 - 1)
            if kind in ("box", "check") and pt.text_in(inner):
                continue
            if kind == "line":
                # A line under existing text is an underline or a table border, not a blank.
                if pt.text_in(fitz.Rect(r.x0 + 2, r.y1 - 12, r.x1 - 2, r.y1 - 1)) and not re.fullmatch(r"_+[:.]?", pt.text_in(fitz.Rect(r.x0 + 2, r.y1 - 12, r.x1 - 2, r.y1 - 1))):
                    continue
            seen.append(r)
            if kind == "check":
                label = clean_label(pt.right_of(r)) or clean_label(pt.left_of(r))
            else:
                label = clean_label(pt.left_of(r)) or clean_label(pt.below(r)) or clean_label(pt.above(r, 14))
            if not label:
                continue
            n += 1
            f = {"id": f"b{n}", "page": pi + 1, "rect": R(r), "xref": 0, "name": "", "required": False, "readonly": False,
                 "label": label, "context": "", "maxlen": 0, "multiline": kind == "box" and r.height > 30, "comb": False,
                 "options": [], "value": "", "flat": True,
                 "kind": "checkbox" if kind == "check" else ("signature" if SIG_RE.search(label) and not DATE_RE.search(label) else "text")}
            if f["kind"] == "checkbox":
                f["value"] = False
            out.append(f)
    return out


def find_existing(doc, pages, fields):
    """Things already on the form: typed answers, handwriting, pictures, drawn ink, comments."""
    items = []
    for f in fields:
        if f.get("flat"):
            continue
        v = f.get("value")
        if (isinstance(v, str) and v.strip()) or v is True:
            items.append({"page": f["page"], "rect": f["rect"], "kind": "answer",
                          "text": f"{f['label']}: {'ticked' if v is True else v}"})
    for pi, page in enumerate(doc):
        pt = pages[pi]
        area = page.rect.width * page.rect.height
        try:
            infos = page.get_image_info()
        except Exception:  # noqa: BLE001
            infos = []
        for info in infos:
            r = fitz.Rect(info["bbox"]) & page.rect
            if r.is_empty or r.width < 25 or r.height < 10:
                continue
            if r.width * r.height > area * 0.75:
                items.append({"page": pi + 1, "rect": R(r), "kind": "scan",
                              "text": "This page is a scanned picture. Any handwriting on it can only be read with AI." if not pt.words
                              else "This page has a full-page picture under the text. There may be handwriting on it."})
                continue
            near = clean_label(pt.left_of(r)) or clean_label(pt.above(r, 20)) or clean_label(pt.below(r))
            items.append({"page": pi + 1, "rect": R(r), "kind": "picture",
                          "text": f"A picture, possibly handwriting or a signature{', near: ' + near if near else ''}."})
        for a in page.annots() or []:
            t = a.type[1]
            r = fitz.Rect(a.rect)
            content = norm((a.info or {}).get("content", ""))
            if t in ("Ink",):
                near = clean_label(pt.left_of(r)) or clean_label(pt.above(r, 20)) or clean_label(pt.below(r))
                items.append({"page": pi + 1, "rect": R(r), "kind": "ink", "text": f"Handwriting or a drawn signature{', near: ' + near if near else ''}."})
            elif t in ("FreeText", "Text", "Stamp") and t != "Widget":
                items.append({"page": pi + 1, "rect": R(r), "kind": "note", "text": f"{'Comment' if t == 'Text' else t}: {content or 'no text'}"})
        # Freehand drawing: many curves close together.
        try:
            drawings = page.get_drawings()
        except Exception:  # noqa: BLE001
            drawings = []
        curvy = []
        for d in drawings:
            its = d.get("items", [])
            c = sum(1 for it in its if it[0] == "c")
            straight = sum(1 for it in its if it[0] in ("l", "re", "qu"))
            # Many curves and few straight lines: handwriting, not a rounded box.
            if c >= 3 and straight <= c / 3 and d["rect"].width < page.rect.width * 0.8:
                curvy.append(fitz.Rect(d["rect"]))
        merged = []
        for r in curvy:
            for m in merged:
                if (m + (-15, -15, 15, 15)).intersects(r):
                    m |= r
                    break
            else:
                merged.append(fitz.Rect(r))
        for r in merged:
            if r.width < 20 and r.height < 20:
                continue
            near = clean_label(pt.left_of(r)) or clean_label(pt.above(r, 20)) or clean_label(pt.below(r)) or clean_label(pt.text_in(r))
            items.append({"page": pi + 1, "rect": R(r), "kind": "ink", "text": f"Drawn marks, possibly handwriting or a signature{', near: ' + near if near else ''}."})
    for i, it in enumerate(items):
        it["id"] = f"e{i + 1}"
    return items


# ---------------------------------------------------------------- filling

def fit_size(text, width, start=10.0, minimum=6.0):
    size = start
    while size > minimum and fitz.get_text_length(text, fontname="helv", fontsize=size) > width - 3:
        size -= 0.5
    return size


def fill(path_in, plan, path_out):
    import shutil
    shutil.copyfile(path_in, path_out)
    doc = fitz.open(path_out)
    if doc.needs_pass:
        fail("This PDF is password protected. Remove the password and try again.")
    by_xref = {}
    for page in doc:
        for wd in page.widgets() or []:
            by_xref[wd.xref] = (page.number, wd)
    touched = []  # rects changed, per page
    for item in plan.get("fields", []):
        kind = item["kind"]
        val = item.get("value")
        if item.get("flat"):
            page = doc[item["page"] - 1]
            r = fitz.Rect(item["rect"])
            if kind == "checkbox":
                if val:
                    page.insert_text((r.x0 + r.width * 0.18, r.y1 - r.height * 0.18), "X", fontsize=max(6, r.height * 0.85), fontname="helv")
                    touched.append([item["page"], R(r)])
                continue
            text = str(val or "").strip()
            if not text:
                continue
            if item.get("multiline") and r.height > 20:
                box = fitz.Rect(r.x0 + 2, r.y0 + 2, r.x1 - 2, r.y1 - 1)
                page.insert_textbox(box, text, fontsize=9, fontname="helv")
            else:
                size = fit_size(text, r.width)
                page.insert_text((r.x0 + 2, r.y1 - 2.5), text, fontsize=size, fontname="helv")
            touched.append([item["page"], R(r)])
            continue
        if kind == "radio":
            for x in item.get("widgets", []):
                pn, wd = by_xref.get(x, (None, None))
                if wd is None:
                    continue
                if str(wd.on_state()) == str(val):
                    wd.field_value = True
                    wd.update()
                touched.append([pn + 1, R(wd.rect)])
            continue
        pn, wd = by_xref.get(item.get("xref"), (None, None))
        if wd is None:
            continue
        if kind == "checkbox":
            wd.field_value = wd.on_state() if val else "Off"
        elif kind == "select":
            wd.field_value = str(val or "")
        else:
            text = str(val or "")
            if text == "":
                continue
            wd.field_value = text
        wd.update()
        touched.append([pn + 1, R(wd.rect)])

    sig_png = plan.get("signaturePng")
    for s in plan.get("signatures", []):
        page = doc[s["page"] - 1]
        r = fitz.Rect(s["rect"])
        if s.get("flat") or r.height < 24:
            r = fitz.Rect(r.x0, r.y1 - 34, r.x1, r.y1 - 1)  # space above a signature line
        r = fitz.Rect(r.x0 + 1, r.y0 + 1, r.x1 - 1, r.y1 - 1)
        page.insert_image(r, filename=sig_png, keep_proportion=True, overlay=True)
        touched.append([s["page"], R(r)])
    try:
        doc.saveIncr()
        incremental = True
    except Exception:  # noqa: BLE001
        tmp = path_out + ".full.pdf"
        doc.save(tmp, garbage=0, deflate=True)
        doc.close()
        shutil.move(tmp, path_out)
        incremental = False
    print("RESULT " + json.dumps({"incremental": incremental, "touched": touched}), flush=True)


# ---------------------------------------------------------------- checking

def verify(orig_path, filled_path, plan):
    report = {"checks": [], "ok": True, "requiredEmpty": [], "mismatch": [], "pagesChanged": []}
    with open(orig_path, "rb") as f:
        a = f.read()
    with open(filled_path, "rb") as f:
        b = f.read()
    prefix = b.startswith(a)
    report["checks"].append({"name": "Original file kept byte for byte, answers added after it", "ok": prefix})
    A = fitz.open(orig_path)
    B = fitz.open(filled_path)
    same_pages = A.page_count == B.page_count
    report["checks"].append({"name": f"Same number of pages ({A.page_count})", "ok": same_pages})
    masks = {}
    for pg, r in plan.get("touched", []):
        masks.setdefault(pg - 1, []).append(fitz.Rect(r) + (-4, -4, 4, 4))
    zoom = 60 / 72
    for i in range(min(A.page_count, B.page_count)):
        pa = A[i].get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY, annots=True)
        pb = B[i].get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csGRAY, annots=True)
        if (pa.width, pa.height) != (pb.width, pb.height):
            report["pagesChanged"].append(i + 1)
            continue
        sa, sb = pa.samples, pb.samples
        if sa == sb:
            continue
        w = pa.width
        rects = [fitz.IRect(int(m.x0 * zoom), int(m.y0 * zoom), int(m.x1 * zoom) + 1, int(m.y1 * zoom) + 1) for m in masks.get(i, [])]
        diff = 0
        for idx in range(0, len(sa)):
            if abs(sa[idx] - sb[idx]) > 40:
                x, y = idx % w, idx // w
                if not any(r.x0 <= x <= r.x1 and r.y0 <= y <= r.y1 for r in rects):
                    diff += 1
        if diff > 12:
            report["pagesChanged"].append(i + 1)
    report["checks"].append({"name": "Nothing on the pages changed outside your answers and signatures", "ok": not report["pagesChanged"]})

    by_xref = {}
    for page in B:
        for wd in page.widgets() or []:
            by_xref[wd.xref] = wd
    for item in plan.get("fields", []):
        if item.get("flat") or item["kind"] not in ("text", "select", "checkbox", "date"):
            continue
        wd = by_xref.get(item.get("xref"))
        if wd is None:
            continue
        got = wd.field_value
        want = item.get("value")
        if item["kind"] == "checkbox":
            ok = (bool(got) and str(got) not in ("Off", "False")) == bool(want)
        else:
            if str(want or "") == "":
                continue
            ok = norm(got) == norm(want)
        if not ok:
            report["mismatch"].append({"label": item.get("label", ""), "want": want, "got": got})
    report["checks"].append({"name": "Every answer reads back correctly from the new file", "ok": not report["mismatch"]})
    for page in B:
        for wd in page.widgets() or []:
            if (wd.field_flags or 0) & 2 and wd.field_type_string in ("Text", "ComboBox", "ListBox") and not norm(wd.field_value):
                report["requiredEmpty"].append({"page": page.number + 1, "name": wd.field_label or wd.field_name})
    report["ok"] = all(c["ok"] for c in report["checks"])
    return report


# ---------------------------------------------------------------- main

def main():
    if len(sys.argv) < 3:
        fail("Usage: form_tool.py analyze|fill|verify|crop|remove-xfa ...")
    cmd = sys.argv[1]
    if cmd == "verify":
        with open(sys.argv[4], encoding="utf-8") as f:
            plan = json.load(f)
        out = verify(sys.argv[2], sys.argv[3], plan)
        with open(sys.argv[5], "w", encoding="utf-8") as f:
            json.dump(out, f)
        return
    try:
        doc = fitz.open(sys.argv[2])
    except Exception as e:  # noqa: BLE001
        fail(f"This file could not be opened as a PDF. {e}")
    if doc.needs_pass:
        fail("This PDF is password protected. Remove the password and try again.")
    if cmd == "analyze":
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            json.dump(analyze(doc), f, ensure_ascii=False)
    elif cmd == "fill":
        doc.close()
        with open(sys.argv[3], encoding="utf-8") as f:
            plan = json.load(f)
        fill(sys.argv[2], plan, sys.argv[4])
    elif cmd == "crop":
        pg, x0, y0, x1, y1 = int(sys.argv[3]), *map(float, sys.argv[4:8])
        page = doc[pg - 1]
        clip = (fitz.Rect(x0, y0, x1, y1) + (-12, -12, 12, 12)) & page.rect
        page.get_pixmap(matrix=fitz.Matrix(200 / 72, 200 / 72), clip=clip).save(sys.argv[8])
    elif cmd == "remove-xfa":
        cat = doc.pdf_catalog()
        t, v = doc.xref_get_key(cat, "AcroForm")
        if t == "xref":
            doc.xref_set_key(int(v.split()[0]), "XFA", "null")
        else:
            doc.xref_set_key(cat, "AcroForm/XFA", "null")
        doc.xref_set_key(cat, "NeedsRendering", "null")
        doc.save(sys.argv[3], garbage=0, deflate=True)
    else:
        fail(f"Unknown command {cmd}")


if __name__ == "__main__":
    main()
