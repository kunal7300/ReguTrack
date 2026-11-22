import unittest
from unittest.mock import patch

from comparison import ComparisonInput, compare, run_comparison
from intelligence import SourceChunk


def source(page, ordinal, heading, text):
    return SourceChunk(page=page, ordinal=ordinal, heading=heading, text=text, ocr=False)


class ComparisonTest(unittest.TestCase):
    def test_categories_and_highlights(self):
        old = [
            source(1, 1, "SCOPE", "SCOPE"),
            source(1, 2, "SCOPE", "This applies to banks. Effective from 1 January 2027."),
            source(2, 1, "EXISTING", "Existing rule still applies."),
            source(3, 1, "WITHDRAWN", "This sentence is deleted."),
        ]
        new = [
            source(2, 1, "SCOPE", "SCOPE"),
            source(2, 2, "SCOPE", "This applies to payment banks. Effective from 1 March 2027."),
            source(3, 1, "EXISTING", "Existing rule   still applies."),
            source(4, 1, "NEW RULE", "This is a new provision."),
        ]
        modified, same, added, removed = compare(old, new)
        self.assertEqual([item.category for item in (modified, same, added, removed)],
                         ["modified", "unchanged", "added", "removed"])
        self.assertEqual(modified.old.pages, [1])
        self.assertEqual(modified.new.pages, [2])
        self.assertEqual(modified.oldChanged, [1])
        self.assertEqual(modified.newChanged, [1])
        self.assertEqual(set(modified.signals), {"effective_date", "applicability"})
        self.assertEqual(added.newChanged, [0])
        self.assertEqual(removed.oldChanged, [0])
        self.assertEqual(same.newChanged, [])

    def test_impact_failure_preserves_diff(self):
        payload = ComparisonInput(
            old=[source(1, 1, None, "Existing provision.")],
            new=[source(1, 1, None, "Updated provision.")],
            requirements=[], includeImpact=True,
        )
        with patch.dict("os.environ", {"GEMINI_API_KEY": ""}):
            result = run_comparison(payload)
        self.assertEqual(result.impactStatus, "failed")
        self.assertEqual(result.changes[0].category, "modified")
        payload.includeImpact = False
        with patch("comparison.urlopen") as network:
            self.assertEqual(run_comparison(payload).impactStatus, "skipped")
        network.assert_not_called()
