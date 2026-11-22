import json
import os
import unittest
from io import BytesIO
from unittest.mock import patch
from urllib.error import HTTPError

from fastapi import HTTPException

from intelligence import AnalysisInput, GeminiDraft, analyze, ground


class IntelligenceTest(unittest.TestCase):
    def setUp(self):
        self.quote = "Banks must comply by 15 January 2027. This is effective from 2026-12-01."
        self.payload = AnalysisInput.model_validate({
            "title": "Synthetic regulation",
            "chunks": [{"page": 12, "ordinal": 1, "heading": "Section 4.2",
                        "text": self.quote, "ocr": False}],
        })
        self.item = {
            "title": "Comply", "description": "Implement the synthetic requirement", "topic": None,
            "requirementType": "mandatory", "applicability": "Banks",
            "effectiveDate": "2026-12-01", "deadline": "2027-01-15", "departments": [],
            "priority": None, "page": 12, "ordinal": 1, "section": "Section 4.2", "quote": self.quote,
        }

    def test_grounding(self):
        raw = GeminiDraft.model_validate({"requirements": [self.item]})
        verified = ground(raw, self.payload.chunks).requirements[0]
        self.assertEqual(verified.deadline, "2027-01-15")
        self.assertEqual(verified.effectiveDate, "2026-12-01")
        self.assertEqual(verified.applicability, "Banks")
        self.assertEqual(verified.section, "Section 4.2")

        misleading = dict(self.item, applicability="All banks", deadline="2026-12-01", section="Bogus")
        verified = ground(GeminiDraft.model_validate({"requirements": [misleading]}),
                          self.payload.chunks).requirements[0]
        self.assertIsNone(verified.deadline)
        self.assertIsNone(verified.applicability)
        self.assertIsNone(verified.section)

    def test_absent_citations_are_rejected(self):
        for change in ({"page": 13}, {"quote": "Invented text"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                ground(GeminiDraft.model_validate({"requirements": [dict(self.item, **change)]}), self.payload.chunks)

    def test_multiline_citation_recovers_wrong_ordinal_and_keeps_supported_items(self):
        first, second = self.quote.split(" This")
        chunks = [
            self.payload.chunks[0].model_copy(update={"text": first}),
            self.payload.chunks[0].model_copy(update={"ordinal": 2,"text": "This" + second}),
        ]
        raw = GeminiDraft.model_validate({"requirements": [
            dict(self.item, ordinal=3, quote=first + "\nThis" + second),
            dict(self.item, quote="Invented text"),
        ]})
        result = ground(raw, chunks)
        self.assertEqual(len(result.requirements), 1)
        self.assertEqual(result.requirements[0].ordinal, 1)
        self.assertEqual(result.requirements[0].quote, self.quote)

    def test_provider_contract_and_original_preserved(self):
        draft = {"requirements": [dict(self.item, section="Invented section")]}
        reply = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": json.dumps(draft)}]}}]}
        with patch.dict(os.environ, {"GEMINI_API_KEY": "synthetic-test-key"}):
            with patch("intelligence.urlopen", return_value=BytesIO(json.dumps(reply).encode())) as provider:
                result = analyze(self.payload)
        self.assertEqual(result.raw.requirements[0].section, "Invented section")
        self.assertIsNone(result.grounded.requirements[0].section)
        self.assertIsNone(result.error)
        request = provider.call_args.args[0]
        self.assertEqual(request.get_header("X-goog-api-key"), "synthetic-test-key")
        self.assertIn("responseJsonSchema", json.loads(request.data)["generationConfig"])

    def test_malformed_provider_output_fails(self):
        reply = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "{}"}]}}]}
        with patch.dict(os.environ, {"GEMINI_API_KEY": "synthetic-test-key"}):
            with patch("intelligence.urlopen", return_value=BytesIO(json.dumps(reply).encode())):
                with self.assertRaises(HTTPException) as outcome:
                    analyze(self.payload)
        self.assertEqual(outcome.exception.status_code, 502)

    def test_temporary_provider_failure_retries(self):
        reply = {"candidates": [{"finishReason": "STOP", "content": {"parts": [
            {"text": json.dumps({"requirements": [self.item]})}]}}]}
        unavailable = HTTPError("https://example.test", 503, "temporary", {}, None)
        with patch.dict(os.environ, {"GEMINI_API_KEY": "synthetic-test-key"}):
            with patch("intelligence.time.sleep"), patch("intelligence.urlopen", side_effect=[
                unavailable, BytesIO(json.dumps(reply).encode())
            ]) as send:
                result = analyze(self.payload)
        self.assertEqual(send.call_count, 2)
        self.assertIsNotNone(result.grounded)
