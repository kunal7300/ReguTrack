import unittest

import pymupdf
from fastapi import HTTPException

from pdf_extract import extract, open_pdf


class PdfExtractionTest(unittest.TestCase):
    def test_page_references_and_headings(self):
        with pymupdf.open() as pdf:
            pdf.new_page()
            page = pdf.new_page()
            page.insert_text((40, 60), "SYNTHETIC HEADING")
            page.insert_text((40, 90), "Example text on page two.")
            result = extract(pdf.tobytes())
        self.assertEqual(result.pages, 2)
        self.assertEqual(result.chunks[1].page, 2)
        self.assertEqual(result.chunks[1].heading, "SYNTHETIC HEADING")

    def test_scanned_page_uses_ocr(self):
        with pymupdf.open() as original, pymupdf.open() as scanned:
            page = original.new_page(width=420, height=240)
            page.insert_text((40, 80), "SYNTHETIC SCAN", fontsize=25)
            image = page.get_pixmap(dpi=160)
            scanned_page = scanned.new_page(width=420, height=240)
            scanned_page.insert_image(scanned_page.rect, pixmap=image)
            result = extract(scanned.tobytes())
        self.assertTrue(result.chunks[0].ocr)
        self.assertIn("SYNTHETIC SCAN", result.chunks[0].text)

    def test_invalid_and_empty_documents_fail(self):
        with self.assertRaises(HTTPException):
            open_pdf(b"%PDF-1.4 broken")
        with pymupdf.open() as pdf:
            pdf.new_page()
            with self.assertRaisesRegex(HTTPException, "No extractable text"):
                extract(pdf.tobytes())
