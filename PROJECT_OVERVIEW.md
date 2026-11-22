# ReguTrack

ReguTrack is a web app that helps bank compliance teams turn Reserve Bank of India (RBI) circulars and directions into trackable work.

## How it works

1. **Upload an RBI PDF.** The regulatory library stores the document and its versions.
2. **Review AI suggestions.** Gemini extracts proposed requirements with citations to the PDF. A compliance officer reviews, edits, approves, or rejects each suggestion.
3. **Assess what changed.** Compare document versions, map requirements to internal controls, and identify gaps.
4. **Assign and verify work.** Assign obligations to departments, track deadlines, and review evidence submitted by employees.
5. **Monitor compliance.** Use dashboards, reports, and an audit trail to see progress and trace decisions back to the source. A read-only assistant answers questions using approved documents.

Built with React, Express, FastAPI, PostgreSQL, and Docker.

## Get started

- [Run locally and create your first admin account](README.md#run-locally)
- [Deploy with HTTPS](deploy/README.md)
