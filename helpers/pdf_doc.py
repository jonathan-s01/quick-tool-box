#!/usr/bin/env python3
"""Shared PDF document model, plus finding and truly removing private information.

Uses PyMuPDF (import name: fitz). Commands:

  pdf_doc.py model   IN.pdf OUT.json             Pages, lines, words with positions, form fields, metadata.
  pdf_doc.py find    IN.pdf EXTRA.json OUT.json  Finds private information. EXTRA.json holds text found by the
                                                 AI and the user's own terms: {"ai": [{"group","text"}], "terms": [..]}
  pdf_doc.py redact  IN.pdf PLAN.json OUT.pdf    Removes the chosen items for real and checks the result.

The model is the start of the shared format for later tools (accessible document editor, form filler):
every page has its size, its lines of text with word positions, and its form fields.
Progress lines start with PROGRESS, errors with WRAPPER_ERROR, so the Node side can read them.
"""
import json
import re
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    print("WRAPPER_ERROR: PyMuPDF is not installed.", flush=True)
    sys.exit(3)


def say(msg):
    print(msg, flush=True)


def fail(msg):
    say(f"WRAPPER_ERROR: {msg}")
    sys.exit(2)


# ---------------------------------------------------------------- the document model

def page_model(page):
    """Lines of text with the words in them, in reading order, plus form fields."""
    words = page.get_text("words", sort=True)  # x0, y0, x1, y1, text, block, line, word
    lines = []
    current_key = None
    for w in words:
        key = (w[5], w[6])
        if key != current_key:
            lines.append({"words": []})
            current_key = key
        lines[-1]["words"].append({"text": w[4], "rect": [round(v, 2) for v in w[:4]]})
    fields = []
    for wd in page.widgets() or []:
        fields.append({
            "name": wd.field_name or "",
            "label": wd.field_label or "",
            "type": wd.field_type_string,
            "value": wd.field_value if isinstance(wd.field_value, str) else str(wd.field_value or ""),
            "rect": [round(v, 2) for v in wd.rect],
            "xref": wd.xref,
        })
    for ln in lines:
        ln["text"] = " ".join(w["text"] for w in ln["words"])
    return {
        "boxes": drawn_boxes(page),
        "number": page.number + 1,
        "width": round(page.rect.width, 2),
        "height": round(page.rect.height, 2),
        "lines": lines,
        "fields": fields,
        "images": len(page.get_images(full=False)),
    }


def drawn_boxes(page, limit=4000):
    """Rectangles drawn on the page, such as the boxes on a T4 slip. Very small, very large
    and duplicate rectangles are left out."""
    out = []
    seen = set()
    pw, ph = page.rect.width, page.rect.height
    try:
        drawings = page.get_drawings()
    except Exception:  # noqa: BLE001
        return out
    for d in drawings:
        rects = []
        items = d.get("items", [])
        for it in items:
            if it[0] == "re":
                rects.append(fitz.Rect(it[1]))
            elif it[0] == "qu":
                rects.append(fitz.Quad(it[1]).rect)
        # Boxes drawn as separate lines: use the outline of the drawing.
        if not rects and len(items) >= 3 and all(it[0] == "l" for it in items):
            rects.append(fitz.Rect(d["rect"]))
        for r in rects:
            if r.width < 10 or r.height < 7 or r.width > pw * 0.97 or r.height > ph * 0.9:
                continue
            key = tuple(round(v) for v in r)
            if key in seen:
                continue
            seen.add(key)
            out.append([round(v, 2) for v in r])
            if len(out) >= limit:
                return out
    return out


def doc_model(doc):
    return {
        "format": "cli-wrappers-doc/1",
        "pages": [page_model(p) for p in doc],
        "metadata": {k: v for k, v in (doc.metadata or {}).items() if v},
        "is_form": bool(doc.is_form_pdf),
    }


# ---------------------------------------------------------------- finding private information

def luhn_ok(digits):
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


MONTHS = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|janv(?:ier)?|f[ée]vr(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|d[ée]c(?:embre)?)\.?"
DATE_RE = re.compile(
    r"\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}"
    r"|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}"
    rf"|{MONTHS}\s+\d{{1,2}},?\s+\d{{4}}"
    rf"|\d{{1,2}}\s+{MONTHS},?\s+\d{{4}})\b", re.I)
BIRTH_RE = re.compile(r"(birth|\bdob\b|\bborn\b|naissance|\bd\.o\.b)", re.I)
SIN_RE = re.compile(r"(?<![\d\w])(\d{3})[ \-]?(\d{3})[ \-]?(\d{3})(?![\d\w])")
SIN_WORD_RE = re.compile(r"(\bsin\b|social insurance|\bnas\b|assurance sociale)", re.I)
CARD_RE = re.compile(r"(?<!\d)(?:\d[ \-]?){12,18}\d(?!\d)")
BANK_RE = re.compile(r"(?<!\d)\d{5}[ \-]\d{3}[ \-]\d{5,12}(?!\d)")
ACCOUNT_RE = re.compile(
    r"(?:account|acct|a/c|compte|transit|institution|routing)\s*(?:number|no\.?|num(?:ber)?|#|n°|numéro)?\s*[:#]?\s*"
    r"((?:[A-Z]{0,3}[\d][\d \-]{3,22}\d))", re.I)
ID_RE = re.compile(
    r"(?:policy|member|client|customer|reference|ref\.?|identification|licen[cs]e|health|\bphn\b|\buli\b|passport|"
    r"business number|\bbn\b|employee|payroll|certificate|contract|claim|file|case|card|plan|tax)\s*"
    r"(?:id|number|no\.?|num(?:ber)?|#|n°)?\s*[:#]?\s*([A-Z0-9][A-Z0-9 \-]{3,24}[0-9][A-Z0-9]*)", re.I)
PHONE_RE = re.compile(r"(?<![\d])(?:\+?1[ .\-]?)?\(?\d{3}\)?[ .\-]?\d{3}[ .\-]\d{4}(?![\d])")
EMAIL_RE = re.compile(r"[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+")
POSTAL_RE = re.compile(r"\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ \-]?\d[ABCEGHJ-NPRSTV-Z]\d\b", re.I)
STREET_RE = re.compile(
    r"\b\d{1,6}[A-Z]?(?:[ \-]\d{1,5})?\s+(?:[A-Z0-9][\w'.]*\s+){0,4}"
    r"(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|crescent|cres|court|ct|way|lane|ln|place|pl|trail|trl|"
    r"close|cl|circle|cir|terrace|terr|gate|park|parkway|pkwy|highway|hwy|square|sq|landing|link|wynd|bay|green|grove|rise|view|"
    r"rue|chemin|route)\b\.?(?:\s+(?:NW|NE|SW|SE|N|S|E|W)\b)?(?:,?\s*(?:unit|suite|apt|#)\s*\w+)?", re.I)
MONEY_NEAR = re.compile(r"[$€£]\s*$")

# Group id -> (heading shown to the user, short label put in the black box, ticked by default)
GROUPS = {
    "sin": ("Social insurance numbers", "SIN removed", True),
    "card": ("Card numbers", "card number removed", True),
    "bank": ("Bank and account numbers", "account removed", True),
    "id": ("ID and reference numbers", "ID removed", True),
    "name": ("Names", "name removed", True),
    "address": ("Addresses and postal codes", "address removed", True),
    "birth": ("Dates of birth", "birth date removed", True),
    "phone": ("Phone numbers", "phone removed", True),
    "email": ("Email addresses", "email removed", True),
    "term": ("Your own words to find", "removed", True),
    "date": ("Other dates (not ticked, because most are not private)", "date removed", False),
}
ORDER = list(GROUPS)


def page_text_index(page):
    """Builds the page text (lines joined with newlines) and a map from characters to words."""
    words = page.get_text("words", sort=True)
    text_parts = []
    spans = []  # (start, end, rect)
    pos = 0
    prev_key = None
    for w in words:
        key = (w[5], w[6])
        if prev_key is not None:
            sep = " " if key == prev_key else "\n"
            text_parts.append(sep)
            pos += 1
        start = pos
        text_parts.append(w[4])
        pos += len(w[4])
        spans.append((start, pos, fitz.Rect(w[:4])))
        prev_key = key
    # Form field values count as text too (fillable tax forms keep their answers here).
    # Most fields already show up in the words above; only add the ones that do not.
    shown = norm(" ".join(text_parts))
    for wd in page.widgets() or []:
        val = wd.field_value
        if isinstance(val, str) and val.strip() and wd.field_type_string in ("Text", "ComboBox", "ListBox") and norm(val) not in shown:
            text_parts.append("\n")
            pos += 1
            start = pos
            text_parts.append(val)
            pos += len(val)
            spans.append((start, pos, fitz.Rect(wd.rect)))
    return "".join(text_parts), spans


def rects_for(page, spans, start, end, matched):
    """Exact boxes for a piece of text: search inside the words it covers, else use the word boxes."""
    covered = [r for (s, e, r) in spans if s < end and e > start]
    if not covered:
        return []
    area = fitz.Rect(covered[0])
    for r in covered[1:]:
        area |= r
    area = area + (-2, -2, 2, 2)
    found = []
    for piece in [p for p in matched.split("\n") if p.strip()]:
        hits = page.search_for(piece.strip(), clip=area)
        found.extend(hits)
    if found:
        return [fitz.Rect(r) for r in found]
    # Group word boxes per line.
    lines = []
    for r in covered:
        for ln in lines:
            if abs(ln.y0 - r.y0) < 2 and abs(ln.y1 - r.y1) < 2:
                ln |= r
                break
        else:
            lines.append(fitz.Rect(r))
    return lines


def norm(s):
    return re.sub(r"\s+", " ", s).strip()


def norm_key(group, s):
    s = norm(s).lower()
    if group in ("sin", "card", "bank", "phone"):
        return re.sub(r"\D", "", s)
    return s


def flexible_pattern(text):
    """Regex that finds text even if spaces or line breaks differ."""
    parts = [re.escape(p) for p in re.split(r"\s+", text.strip()) if p]
    return re.compile(r"(?<![\w])" + r"[\s,]+".join(parts) + r"(?![\w])", re.I)


def find(doc, extra):
    items = {}  # (group, key) -> item

    def add(group, text, page, rects, context):
        text = norm(text)
        if not text or not rects:
            return
        key = (group, norm_key(group, text))
        item = items.get(key)
        if item is None:
            item = items[key] = {"group": group, "text": text, "context": context, "occurrences": []}
        item["occurrences"].append({"page": page.number + 1, "rects": [[round(v, 2) for v in r] for r in rects]})

    ai = [a for a in extra.get("ai", []) if isinstance(a, dict) and a.get("text", "").strip()]
    terms = [t for t in extra.get("terms", []) if isinstance(t, str) and t.strip()]

    for page in doc:
        say(f"PROGRESS {page.number + 1} {doc.page_count}")
        text, spans = page_text_index(page)
        used = []  # character ranges already reported, so one number is not listed twice

        def free(s, e):
            return all(e <= a or s >= b for a, b in used)

        def context_of(s, e):
            a = max(0, s - 40)
            b = min(len(text), e + 40)
            return norm(text[a:b])

        def take(group, s, e):
            matched = text[s:e]
            used.append((s, e))
            add(group, matched, page, rects_for(page, spans, s, e, matched), context_of(s, e))

        for m in EMAIL_RE.finditer(text):
            take("email", m.start(), m.end())
        for m in BANK_RE.finditer(text):
            if free(m.start(), m.end()):
                take("bank", m.start(), m.end())
        for m in CARD_RE.finditer(text):
            digits = re.sub(r"\D", "", m.group())
            if 13 <= len(digits) <= 19 and luhn_ok(digits) and free(m.start(), m.end()):
                take("card", m.start(), m.end())
        for m in SIN_RE.finditer(text):
            if not free(m.start(), m.end()):
                continue
            digits = "".join(m.groups())
            before = text[max(0, m.start() - 60):m.start()]
            if MONEY_NEAR.search(before):
                continue
            labelled = bool(SIN_WORD_RE.search(before))
            if labelled or (luhn_ok(digits) and digits[0] not in "08" and (" " in m.group() or "-" in m.group() or labelled)):
                take("sin", m.start(), m.end())
            elif luhn_ok(digits) and digits[0] not in "08":
                take("id", m.start(), m.end())  # 9 digits that pass the SIN check but are not labelled
        for m in ACCOUNT_RE.finditer(text):
            s, e = m.start(1), m.end(1)
            if len(re.sub(r"\D", "", m.group(1))) >= 5 and free(s, e):
                take("bank", s, e)
        for m in PHONE_RE.finditer(text):
            if free(m.start(), m.end()):
                take("phone", m.start(), m.end())
        for m in ID_RE.finditer(text):
            s, e = m.start(1), m.end(1)
            val = m.group(1).strip()
            if len(re.sub(r"\D", "", val)) >= 5 and not re.fullmatch(r"(19|20)\d\d", val) and free(s, e):
                take("id", s, s + len(m.group(1).rstrip()))
        # Text the AI found (names, addresses, birth dates), and your own words. Search the whole page.
        for entry in ai + [{"group": "term", "text": t} for t in terms]:
            group = entry.get("group") if entry.get("group") in GROUPS else "name"
            for line in [l for l in str(entry["text"]).split("\n") if l.strip()]:
                if len(line.strip()) < 2:
                    continue
                for m in flexible_pattern(line).finditer(text):
                    if group != "term" and not free(m.start(), m.end()):
                        continue
                    take(group, m.start(), m.end())

        for m in DATE_RE.finditer(text):
            if not free(m.start(), m.end()):
                continue
            # A birth date is the first date after a word like "birth" on the same line.
            line_start = text.rfind("\n", 0, m.start()) + 1
            before = text[line_start:m.start()]
            kw = None
            for kw in BIRTH_RE.finditer(before):
                pass
            is_birth = kw is not None and not DATE_RE.search(before[kw.end():])
            take("birth" if is_birth else "date", m.start(), m.end())
        for m in STREET_RE.finditer(text):
            if free(m.start(), m.end()):
                take("address", m.start(), m.end())
        for m in POSTAL_RE.finditer(text):
            if free(m.start(), m.end()):
                take("address", m.start(), m.end())

    # Shape the result for the page: one entry per distinct piece of text, grouped.
    out_groups = []
    counter = 0
    for g in ORDER:
        group_items = [i for i in items.values() if i["group"] == g]
        if not group_items:
            continue
        group_items.sort(key=lambda i: (i["occurrences"][0]["page"], i["occurrences"][0]["rects"][0][1]))
        heading, label, checked = GROUPS[g]
        entries = []
        for it in group_items:
            counter += 1
            pages = sorted({o["page"] for o in it["occurrences"]})
            entries.append({
                "id": f"i{counter}",
                "text": it["text"],
                "count": len(it["occurrences"]),
                "pages": pages,
                "context": it["context"],
                "checked": checked,
                "label": label,
                "occurrences": it["occurrences"],
            })
        out_groups.append({"id": g, "name": heading, "items": entries})
    return {"groups": out_groups, "pages": doc.page_count}


# ---------------------------------------------------------------- removing for real

def fit_label(rect, label):
    """Font size so the label fits in the box, or no label if the box is too small."""
    h = rect.height
    size = min(8.0, max(0.0, h * 0.7))
    if size < 4:
        return None, 0
    width = fitz.get_text_length(label, fontname="helv", fontsize=size)
    if width > rect.width - 1:
        size = size * (rect.width - 1) / width
        if size < 4:
            short = "removed"
            size = min(8.0, h * 0.7)
            if fitz.get_text_length(short, fontname="helv", fontsize=size) > rect.width - 1:
                return None, 0
            return short, size
    return label, size


def redact(doc, plan):
    labels_on = plan.get("labels", True)
    chosen = plan.get("items", [])
    extra = [t for t in plan.get("extra", []) if t.strip()]
    secrets = [c["text"] for c in chosen] + extra
    total_boxes = 0

    per_page = {}
    for item in chosen:
        for occ in item["occurrences"]:
            for r in occ["rects"]:
                per_page.setdefault(occ["page"] - 1, []).append((fitz.Rect(r), item.get("label", "removed")))
    for page in doc:
        say(f"PROGRESS {page.number + 1} {doc.page_count}")
        # Your extra text: search every page.
        for t in extra:
            for line in [l.strip() for l in t.split("\n") if l.strip()]:
                for r in page.search_for(line):
                    per_page.setdefault(page.number, []).append((r, "removed"))
        boxes = per_page.get(page.number, [])
        # Fillable forms: clear the answers in fields that hold removed text or sit under a black box.
        for wd in page.widgets() or []:
            val = wd.field_value if isinstance(wd.field_value, str) else ""
            hit = any(norm(s).lower() in norm(val).lower() for s in secrets if s.strip()) if val else False
            hit = hit or (val and any(fitz.Rect(wd.rect).intersects(r) for r, _ in boxes))
            if hit and not any(fitz.Rect(wd.rect).intersects(r) for r, _ in boxes):
                boxes.append((fitz.Rect(wd.rect), "removed"))
            if hit:
                # PyMuPDF ignores an empty value, so set a space to redraw the field, then empty it for real.
                wd.field_value = " "
                wd.update()
                doc.xref_set_key(wd.xref, "V", "()")
        for r, label in boxes:
            r = fitz.Rect(r) + (-2.5, -2, 2.5, 2)  # a little extra so scanned letters are fully covered
            if labels_on:
                text, size = fit_label(r, label)
            else:
                text, size = None, 0
            if text:
                page.add_redact_annot(r, text=text, fontname="helv", fontsize=size, align=fitz.TEXT_ALIGN_CENTER,
                                      fill=(0, 0, 0), text_color=(1, 1, 1), cross_out=False)
            else:
                page.add_redact_annot(r, fill=(0, 0, 0), cross_out=False)
            total_boxes += 1
        if boxes:
            # Remove the text under the boxes, black out the pixels of pictures (scans) under them,
            # and leave lines and form borders alone so the page still looks official.
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                                  text=fitz.PDF_REDACT_TEXT_REMOVE)
        # Notes and comments that mention removed text are deleted.
        for annot in list(page.annots() or []):
            content = (annot.info or {}).get("content", "")
            if content and any(norm(s).lower() in norm(content).lower() for s in secrets):
                page.delete_annot(annot)

    # Document details (title, author, subject, keywords) that contain removed text are cleared.
    meta = doc.metadata or {}
    changed = False
    for k, v in list(meta.items()):
        if isinstance(v, str) and v and any(norm(s).lower() in v.lower() for s in secrets):
            meta[k] = ""
            changed = True
    if changed:
        doc.set_metadata(meta)
        doc.del_xml_metadata()
    return secrets, total_boxes


def still_present(path, secrets):
    """Opens the finished file again and looks for every removed item in all of its text."""
    doc = fitz.open(path)
    texts = []
    for p in doc:
        texts.append(p.get_text("text"))
        for wd in p.widgets() or []:
            if isinstance(wd.field_value, str):
                texts.append(wd.field_value)
        for a in p.annots() or []:
            texts.append((a.info or {}).get("content", ""))
    texts.extend(str(v) for v in (doc.metadata or {}).values() if v)
    blob = norm(" ".join(texts)).lower()
    digits_blob = re.sub(r"\D", "", blob)
    left = []
    for s in secrets:
        n = norm(s).lower()
        if not n:
            continue
        digits = re.sub(r"\D", "", n)
        if n in blob or (len(digits) >= 7 and digits == re.sub(r"[\s\-().]", "", n) and digits in digits_blob):
            left.append(s)
    doc.close()
    return left


def main():
    if len(sys.argv) < 4:
        fail("Usage: pdf_doc.py model|find|redact ...")
    cmd = sys.argv[1]
    try:
        doc = fitz.open(sys.argv[2])
    except Exception as e:  # noqa: BLE001
        fail(f"This file could not be opened as a PDF. {e}")
    if doc.needs_pass:
        fail("This PDF is password protected. Remove the password and try again.")
    if cmd == "model":
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            json.dump(doc_model(doc), f, ensure_ascii=False)
    elif cmd == "find":
        with open(sys.argv[3], encoding="utf-8") as f:
            extra = json.load(f)
        with open(sys.argv[4], "w", encoding="utf-8") as f:
            json.dump(find(doc, extra), f, ensure_ascii=False)
    elif cmd == "redact":
        with open(sys.argv[3], encoding="utf-8") as f:
            plan = json.load(f)
        out = sys.argv[4]
        secrets, boxes = redact(doc, plan)
        # garbage=3 throws away the old, now unused text so it cannot be recovered from the file.
        doc.save(out, garbage=3, deflate=True, clean=True)
        left = still_present(out, secrets)
        say("RESULT " + json.dumps({"boxes": boxes, "left": left}, ensure_ascii=False))
    else:
        fail(f"Unknown command {cmd}")


if __name__ == "__main__":
    main()
