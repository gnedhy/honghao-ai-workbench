from __future__ import annotations

import json
import sys
from pathlib import Path

from pypdf import PdfReader


def extract(path: Path) -> dict[str, str]:
    try:
        reader = PdfReader(path)
        if reader.is_encrypted:
            return {"status": "encrypted", "reason": "encrypted_pdf"}
        text = "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()
        if not text:
            return {"status": "awaiting_ocr", "reason": "no_extractable_text"}
        return {"status": "parsed", "text": text}
    except Exception:
        return {"status": "parse_failed", "reason": "invalid_or_damaged_pdf"}


if __name__ == "__main__":
    print(json.dumps(extract(Path(sys.argv[1])), ensure_ascii=False))
