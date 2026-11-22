import io
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from fastapi import HTTPException
from assistant import provider


class ProviderTests(unittest.TestCase):
    @patch.dict("os.environ", {"GEMINI_API_KEY": "synthetic-test-key"})
    @patch("assistant.time.sleep")
    def test_transient_error_retries(self, sleep):
        temporary = HTTPError("https://example.test", 503, "temporary", {}, None)
        with patch("assistant.urlopen", side_effect=[temporary, io.BytesIO(json.dumps({"ok": True}).encode())]) as send:
            self.assertEqual(provider("synthetic-model", {}), {"ok": True})
        self.assertEqual(send.call_count, 2)
        sleep.assert_called_once()

    @patch.dict("os.environ", {"GEMINI_API_KEY": "synthetic-test-key"})
    def test_input_error_does_not_retry(self):
        invalid = HTTPError("https://example.test", 400, "bad request", {}, None)
        with patch("assistant.urlopen", side_effect=invalid) as send:
            with self.assertRaises(HTTPException):
                provider("synthetic-model", {})
        send.assert_called_once()
