"""Runs Docling on one file and saves its result as JSON, for the Quick Tool Box "Smart document reader".

Called by tools/docling.js with the Python that Docling is installed in.
Prints progress and errors to stderr. Lines starting with WRAPPER_ERROR: are shown to the user.
"""
import argparse
import json
import sys


def say(msg):
    print(msg, file=sys.stderr, flush=True)


def fail(msg, code=3):
    say(f"WRAPPER_ERROR: {msg}")
    sys.exit(code)


p = argparse.ArgumentParser()
p.add_argument("input")
p.add_argument("output")
p.add_argument("--ocr-engine", choices=["mac", "tesseract", "auto"], default="mac")
p.add_argument("--force-ocr", action="store_true")
p.add_argument("--lang", choices=["en", "fr", "en+fr"], default="en")
p.add_argument("--tables", choices=["accurate", "fast"], default="accurate")
p.add_argument("--no-hierarchy", action="store_true")
args = p.parse_args()

try:
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel import pipeline_options as po
except ImportError as e:
    fail(f"Docling could not be loaded: {e}")

opts = po.PdfPipelineOptions()
opts.do_ocr = True
opts.do_table_structure = True
try:
    opts.table_structure_options.mode = po.TableFormerMode.ACCURATE if args.tables == "accurate" else po.TableFormerMode.FAST
    opts.table_structure_options.do_cell_matching = True
except Exception:
    pass

# OCR engine and languages.
langs = {"en": ["en"], "fr": ["fr"], "en+fr": ["en", "fr"]}[args.lang]
if args.ocr_engine == "mac":
    try:
        import ocrmac  # noqa: F401
    except ImportError:
        fail("Apple Vision OCR needs the ocrmac package. Reinstall Docling with: uv tool install docling --with ocrmac --force")
    mac_langs = {"en": "en-US", "fr": "fr-FR"}
    opts.ocr_options = po.OcrMacOptions(force_full_page_ocr=args.force_ocr, lang=[mac_langs[l] for l in langs])
elif args.ocr_engine == "tesseract":
    tess_langs = {"en": "eng", "fr": "fra"}
    opts.ocr_options = po.TesseractCliOcrOptions(force_full_page_ocr=args.force_ocr, lang=[tess_langs[l] for l in langs])
else:
    try:
        opts.ocr_options = po.OcrAutoOptions(force_full_page_ocr=args.force_ocr)
    except AttributeError:
        opts.ocr_options.force_full_page_ocr = args.force_ocr

# Heading levels: newer Docling versions can work them out from bookmarks, numbering and font size.
heading_levels = False
if not args.no_hierarchy and hasattr(po, "HeadingHierarchyOptions"):
    try:
        opts.heading_hierarchy_options = po.HeadingHierarchyOptions(enabled=True)
        opts.generate_parsed_pages = True  # needed for the font-size signal
        heading_levels = True
    except Exception as e:
        say(f"Heading levels not available in this Docling version: {e}")

say("Loading layout models. The first run downloads them, which can take a few minutes.")
converter = DocumentConverter(format_options={
    InputFormat.PDF: PdfFormatOption(pipeline_options=opts),
})
say("Reading the document.")
try:
    result = converter.convert(args.input, raises_on_error=False)
except TypeError:
    result = converter.convert(args.input)
except Exception as e:
    fail(f"Docling could not read this file: {e}")

status = str(getattr(result, "status", ""))
if "FAILURE" in status.upper() and not getattr(result, "document", None):
    errs = "; ".join(str(getattr(e, "error_message", e)) for e in getattr(result, "errors", []) or [])
    fail(f"Docling could not read this file. {errs}")

data = result.document.export_to_dict()
data["_wrapper"] = {
    "heading_levels": heading_levels,
    "status": status,
    "errors": [str(getattr(e, "error_message", e)) for e in (getattr(result, "errors", None) or [])],
}
with open(args.output, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False)
say("Done.")
