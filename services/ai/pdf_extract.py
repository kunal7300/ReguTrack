import re
import unicodedata

import pymupdf
from fastapi import HTTPException, Request
from pydantic import BaseModel

MAX_BYTES = 10 * 1024 * 1024
MAX_PAGES = 150


class Chunk(BaseModel):
    page: int
    ordinal: int
    heading: str | None
    text: str
    ocr: bool


class Extraction(BaseModel):
    pages: int
    chunks: list[Chunk]


def open_pdf(data: bytes):
    try:
        if not data.startswith(b"%PDF-"):
            raise ValueError()
        pdf = pymupdf.open(stream=data, filetype="pdf")
        if pdf.needs_pass or pdf.is_repaired or not 0 < len(pdf) <= MAX_PAGES:
            pdf.close()
            raise ValueError()
        return pdf
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(422, "Invalid, encrypted, damaged, or oversized PDF") from exc


async def pdf_body(request: Request) -> bytes:
    body = bytearray()
    async for part in request.stream():
        body.extend(part)
        if len(body) > MAX_BYTES:
            raise HTTPException(413, "PDF exceeds 10 MiB")
    return bytes(body)


def extract(data: bytes) -> Extraction:
    chunks = []
    with open_pdf(data) as pdf:
        for page_number, page in enumerate(pdf, 1):
            text = page.get_text(sort=True)
            ocr = not text.strip() and bool(page.get_image_info())
            if ocr:
                if page.rect.width * page.rect.height > 2_000_000:
                    raise HTTPException(422, f"Scanned page {page_number} exceeds OCR dimensions")
                text_page = page.get_textpage_ocr(language="eng", dpi=150, full=True)
                text = page.get_text(textpage=text_page, sort=True)
                if not text.strip():
                    raise HTTPException(422, f"No text recognized on scanned page {page_number}")
            text = unicodedata.normalize("NFKC", text).replace("\x00", "")
            text = "\n".join(re.sub(r"[^\S\n]+", " ", line).strip() for line in text.splitlines()).strip()
            heading = None
            ordinal = 0
            for line in text.splitlines():
                if 3 <= len(line) <= 110 and (line.isupper() or re.match(r"^\d+(\.\d+)*[.)]?\s+[A-Z]", line)):
                    heading = line
                for start in range(0, len(line), 1800):
                    ordinal += 1
                    chunks.append(Chunk(page=page_number, ordinal=ordinal, heading=heading,
                                        text=line[start:start + 1800], ocr=ocr))
                    if len(chunks) > 20000:
                        raise HTTPException(422, "PDF exceeds extraction limits")
        if not chunks:
            raise HTTPException(422, "No extractable text found")
        return Extraction(pages=len(pdf), chunks=chunks)
