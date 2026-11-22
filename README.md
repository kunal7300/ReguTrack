# ReguTrack

ReguTrack is an RBI regulatory compliance management project with a read-only assistant and a production HTTPS deployment profile.

## Project walkthrough

ReguTrack turns a regulatory PDF into traceable compliance work. Upload a regulation and process its PDF, then review the AI-extracted requirements with their source citations. Compare versions, map approved requirements to controls, and validate gaps. Approved obligations become department tasks. Employees submit evidence, and independent reviewers verify completion. Auditors can trace each completed task back to its original requirement and PDF page.

The app includes role-based dashboards, CSV reports, deadline reminders, and a read-only assistant for approved sources. The repository contains the React frontend, Express API and workers, FastAPI services, PostgreSQL migrations, and Docker deployment configuration. Start with the local setup below, or review the production and testing sections for release details.

See [Production deployment](deploy/README.md) for release configuration, HTTPS, and backup and restore instructions.

## Run locally

Start Docker Desktop in Linux container mode and run these PowerShell commands from the repository root. Keep the existing `.env` when upgrading from Phase 0 so the PostgreSQL password still matches the database volume. Node.js is used to generate the JWT signing key.

```powershell
$regutrackPassword = [guid]::NewGuid().ToString('N')
if (-not (Test-Path .env)) {
    (Get-Content .env.example -Raw).Replace('POSTGRES_PASSWORD=', "POSTGRES_PASSWORD=$regutrackPassword") | Set-Content -Encoding ascii .env
}
if (-not (Select-String -Path .env -Pattern '^JWT_SECRET=[0-9a-fA-F]{64}$' -Quiet)) {
    $regutrackKey = node -p "require('node:crypto').randomBytes(32).toString('hex')"
    $regutrackSettings = Get-Content .env | Where-Object { $_ -notmatch '^JWT_SECRET=' }
    @($regutrackSettings) + "JWT_SECRET=$regutrackKey" | Set-Content -Encoding ascii .env
    Remove-Variable regutrackKey
}
foreach ($regutrackSetting in 'PDF_SERVICE_TOKEN', 'S3_SECRET_KEY', 'REGUTRACK_DB_APP_PASSWORD') {
    if (-not (Select-String -Path .env -Pattern ('^' + $regutrackSetting + '=.+$') -Quiet)) {
        $regutrackValue = node -p "require('node:crypto').randomBytes(32).toString('hex')"
        $regutrackSettings = Get-Content .env | Where-Object { $_ -notmatch ('^' + $regutrackSetting + '=') }
        @($regutrackSettings) + "$regutrackSetting=$regutrackValue" | Set-Content -Encoding ascii .env
    }
}
docker compose up --build --wait
docker compose ps --all
```

Open [ReguTrack](http://127.0.0.1:5173) to sign in. Edit `WEB_PORT`, `API_PORT`, or `AI_PORT` in `.env` if a default host port is occupied and update the matching URLs below.

### Create the first Super Admin

Run this once after the migration has completed. The bootstrap command reads the password from standard input, rejects subsequent bootstrap attempts, and creates an audit entry.

```powershell
$regutrackAdminEmail = Read-Host 'Super Admin email'
$regutrackAdminName = Read-Host 'Super Admin full name'
$regutrackAdminPassword = Read-Host 'Super Admin password (12–128 characters)' -AsSecureString
$regutrackPasswordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($regutrackAdminPassword)
try {
    $regutrackOutputEncoding = $OutputEncoding
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($regutrackPasswordPointer) |
        docker compose exec -T api node apps/api/dist/identity/bootstrap.js $regutrackAdminEmail $regutrackAdminName
} finally {
    $OutputEncoding = $regutrackOutputEncoding
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($regutrackPasswordPointer)
    Remove-Variable regutrackAdminPassword
}
```

Sign in with the new account. Create departments before assigning Department Managers or Department Employees. The forgot-password page directs users to their administrator. Self-service password recovery is a placeholder.

## Verify the stack

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health/live
Invoke-RestMethod http://127.0.0.1:3000/api/health/ready | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:5173/api/health/ready | ConvertTo-Json
docker compose logs migrate
docker compose run --rm --no-deps migrate psql -X -v ON_ERROR_STOP=1 -c 'SELECT extname, extversion FROM pg_extension WHERE extname = $$vector$$'
docker compose exec redis redis-cli ping
```

Expect HTTP 200 on all four requests, identical readiness JSON through the API and web ports, an exited migration service with code 0, a `vector` extension row, and `PONG` from Redis. To stop the stack and keep its volumes, run `docker compose down`.

## HTTP endpoints

| Service | Endpoint | Success | Failure |
| --- | --- | --- | --- |
| Express | `GET /api/health/live` | 200 with `{"status":"ok","service":"api"}` | Connection failure if Express is stopped |
| Express | `GET /api/health/ready` | 200 with `status: "ready"` and `checks` containing `postgres`, `redis`, `ai`, and `storage` all set to `"up"` | 503 with `status: "unavailable"` and failed checks set to `"down"` |
| FastAPI | `GET /health` | 200 with `{"status":"ok","service":"ai"}` | Connection failure if FastAPI is stopped |

FastAPI also exposes its generated [API docs](http://127.0.0.1:8000/docs). Vite proxies browser requests under `/api` to Express. Express validates FastAPI's health response, pings Redis, and evaluates a pgvector cast in PostgreSQL.

### Identity endpoints

All paths below start with `/api/v1`. Send JSON bodies with `Content-Type: application/json`. The protected endpoints require `Authorization: Bearer <access token>`. Login and refresh return `accessToken`, `expiresIn`, and `user`, and set the refresh cookie. Account responses include `id`, `name`, `email`, `departmentId`, `active`, `roles`, and `permissions`.

| Method and path | Inputs and result |
| --- | --- |
| `POST /auth/login` | `email`, `password`. Returns 200 with session data. |
| `POST /auth/refresh` | Refresh cookie and JSON body `{}`. Returns 200 with a rotated cookie and session data. |
| `POST /auth/logout` | Refresh cookie and JSON body `{}`. Revokes that session and returns 204. |
| `GET /auth/me` | Returns the current account. |
| `GET /users` | Optional `limit` (1–100) and `offset`. Returns `users` and `hasMore` within the caller's scope. |
| `POST /users` | `name`, `email`, `password`, nullable `departmentId`, and `roles` as an array of role codes. Returns 201 with the account. |
| `GET /users/:id` | Returns the account if in scope. Out-of-scope account IDs return 404. |
| `PATCH /users/:id` | One or more of `name`, `email`, `departmentId`, or `roles`. Returns the updated account. |
| `PATCH /users/:id/status` | `active` boolean. Returns the account and revokes sessions when disabling it. |
| `GET /roles` | Returns role names, codes, and permission grants. |
| `GET /departments` | Returns `departments` within the caller's scope. |
| `POST /departments` | `name` and a unique uppercase `code`. Returns 201 with the department. |

Unauthenticated access returns 401. Missing permissions return 403. Invalid requests return 400 and duplicate account emails or department codes return 409.

| Role | User directory | Departments | Role catalog |
| --- | --- | --- | --- |
| Super Admin | Bank-wide read and manage | Bank-wide read and create | Read |
| Chief Compliance Officer | Bank-wide read | Bank-wide read | Read |
| Compliance Officer | | Bank-wide read | |
| Department Manager | Assigned department read | Assigned department read | |
| Department Employee | | Assigned department read | |
| Internal Auditor | Bank-wide read | Bank-wide read | Read |

Users can view their own profile. Multiple roles combine permissions. Phase 1 fixes role-to-permission mappings in migration 002 and lets Super Admins change account role assignments. Access JWTs expire after five minutes and remain in browser memory. Refresh sessions expire seven days after sign-in. PostgreSQL stores SHA-256 token digests and Argon2id password hashes. A replayed refresh token revokes its session. The API rechecks account status, role grants, and department scope on protected calls.

## Build and test without Docker

Use Node.js 24 and Python 3.13.

```powershell
npm.cmd ci
npm.cmd run lint
npm.cmd run build
npm.cmd test
py -3.13 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -r services/ai/requirements-dev.txt
& .\.venv\Scripts\python.exe -m unittest discover -s services/ai -p test_health.py
```

The Express tests exercise HTTP liveness, readiness, and dependency failure using injected checks. The Vite test serves the built entry page and verifies readiness responses through the proxy. The FastAPI test exercises the Pydantic response contract. The Compose commands exercise the real dependency connections and migration.

## Regulatory library

Sign in as Super Admin, Chief Compliance Officer, or Compliance Officer. Optionally record a source, then open **Regulatory library**, choose **Add regulation**, and upload a PDF as its first version. Use **Upload version** on the same regulation for amendments or replacements. All signed-in roles can read the shared library. Source names and URLs are recorded as entered.

The upload accepts an unencrypted, structurally valid PDF up to 10 MiB and 150 pages. The library rejects duplicate SHA-256 checksums. RustFS stores the original, PostgreSQL stores PDF metadata and extracted text, and a BullMQ worker calls FastAPI. Tesseract recognizes English text on image-only pages. A failed extraction retains the original and exposes a failure status. A heading heuristic identifies uppercase and numbered section headings. Choose a version to view its original PDF and browse extracted text by page.

### Regulatory endpoints

All paths start with `/api/v1` and require a Bearer access token. POST endpoints require regulatory management permission.

| Method and path | Inputs and result |
| --- | --- |
| `GET /regulatory-sources` | List recorded sources. |
| `POST /regulatory-sources` | JSON `name` and HTTP(S) `url`. |
| `GET /regulations` | List regulations with optional `offset`. |
| `POST /regulations` | JSON `title`, `kind`, optional `sourceId` and `reference`. Kinds are `circular`, `notification`, `master_direction`, `master_circular`, and `amendment`. |
| `GET /regulations/:id` | Regulation details and recorded source. |
| `POST /regulations/upload` | Multipart `pdf`, `regulationId`, optional `sourceUrl` and `versionNote`. Returns 202 with the queued document. |
| `GET /regulations/:id/versions` | Version history, newest first. |
| `GET /regulations/:id/documents` | Files, checksums, processing states, page counts, and errors. |
| `GET /regulatory-documents/:id/pdf` | Original PDF bytes. |
| `GET /regulatory-documents/:id/chunks?page=1` | Ordered page text, headings, and OCR flags. |

## AI analysis and review

Set `GEMINI_API_KEY` in the ignored local `.env`, then run `docker compose up -d --wait ai`. The default model is `gemini-3.8-flash` and `GEMINI_MODEL` overrides it. Analysis sends the selected version's extracted chunks and title to Gemini. Without a configured key the run reports a configuration failure.

Open a processed version in the Regulatory Library and choose **Analyze document**. Super Admin, Chief Compliance Officer, and Compliance Officer can run analysis and review suggestions. All sign-in roles can read the results. The review panel retains the original suggestion, page and section evidence, revised fields, and each human decision. A different reviewer must approve a human revision.

Gemini's response is validated before suggestions are created. Each accepted citation matches the stored chunk exactly. Unsupported applicability and dates become unknown. A document with a missing citation fails the run. Citation quality gives 70 points for an exact match, 20 for native PDF text, and 10 for a verified section heading. It measures citation evidence quality. The service accepts up to 120,000 characters of extracted text per run and up to 60 suggestions.

| Method and path under `/api/v1` | Inputs and result |
| --- | --- |
| `POST /regulations/:id/analyze` | JSON `documentId` from a processed version. Returns 202 and the queued run. |
| `GET /regulations/:id/requirements` | Lists runs and paginated suggestions. Optional `documentId` and `offset`. |
| `GET /requirements/:id` | Returns the suggestion, citation, human result, and review history. |
| `PATCH /requirements/:id` | JSON `revision` and edited `result`. Saves a new human revision. |
| `POST /requirements/:id/review` | JSON `revision`, `action` of `approve` or `reject`, and optional `note`. |

## Regulatory change comparison

Open a regulation with two processed uploads and use **Compare versions**. Select the earlier and later versions. The comparison matches sections by recorded headings and uses text similarity for closely related renamed headings. It classifies sections as added, modified, removed, or unchanged. The detail view shows both extracted passages, highlighted lines, and the source PDF pages. Explicit effective-date and applicability wording differences are displayed with their source phrases.

The optional Gemini checkbox sends changed text and up to 30 approved requirement summaries from the earlier version. Any returned impact is a suggestion. Reviewers record a decision and comment separately. The deterministic diff remains available when Gemini is skipped or returns an error. Each comparison supports up to 650 section occurrences across both versions. Gemini impact is limited to 40 changed sections and 70,000 changed characters.

All signed-in roles can read comparisons. Super Admin, Chief Compliance Officer, and Compliance Officer can create comparisons and save reviews.

| Method and path under `/api/v1` | Inputs and result |
| --- | --- |
| `POST /regulations/:id/compare` | `oldVersionId`, `newVersionId`, optional `includeImpact` boolean. Saves a comparison and returns its ID. |
| `GET /regulations/:id/changes` | Saved comparisons, counts, and paginated changes. Optional `comparisonId`, `offset`, and `includeUnchanged`. |
| `GET /changes/:id` | Both source sections, PDF references, optional impact suggestion, and review history. |
| `POST /changes/:id/review` | `decision` of `confirmed`, `dismissed`, or `needs_follow_up`, a `comment`, and the current `revision` (review history length). |

## Control register and gap assessment

Use **Control register** to record existing control descriptions and their owning departments. Open an approved requirement, choose **Map controls and assess gap**, and select the relevant controls. The Gemini checkbox sends the approved requirement and selected control descriptions to the configured provider. Gemini's observation and remediation suggestion stay separate from the officer's assessment. An unavailable provider leaves the manual workflow available.

Submit an outcome and rationale for validation. Gap identified and partially addressed outcomes require a remediation proposal. A second authorized officer can reject it for revision or approve it. Approval of an open gap records a validated remediation action with an optional department and due date. Approval of a fully addressed or not applicable outcome records the decision without a remediation action. The assessment keeps its submission and review history.

Super Admins, Chief Compliance Officers, and Compliance Officers can manage assessments. Internal Auditors can read controls and assessments.

| Method and path under `/api/v1` | Inputs and result |
| --- | --- |
| `GET /controls` | Lists controls with optional `offset`. |
| `POST /controls` | `name`, `description`, and nullable `departmentId`. |
| `POST /requirements/:id/gaps` | Up to 20 `controlIds` and optional `includeAi`. Creates one assessment per approved requirement. |
| `GET /gaps` | Lists assessments with optional `requirementId` and `offset`. |
| `GET /gaps/:id` | Returns controls, suggestion, human assessment, review history, and validated remediation. |
| `PATCH /gaps/:id` | `revision`, `outcome`, `assessment`, and nullable `remediationProposal`. Submits the assessment. |
| `POST /gaps/:id/review` | `revision`, `decision` of `approved` or `rejected`, `comment`, optional `ownerDepartmentId` and `dueDate`. |

## Compliance obligations and tasks

Open an approved requirement and choose **Create obligation**. An approved gap with validated remediation offers **Create obligation from remediation**. Choose the responsible department, an active accountable officer from that department, a target date, and a priority. A different compliance officer must approve the draft before it can generate tasks.

Use **Obligations** to view approval and implementation status. Implementation status is derived from its tasks. After approval, the target date can be amended with a reason. Use **Task board** to filter department work, assigned work, and overdue tasks. Department managers can create, assign, and review tasks for their own department. A compliance officer can manage work across departments, and internal auditors have read access. Department employees can view and update their own assigned tasks within their department.

An assignee starts work, attaches evidence, and submits a note for review. A manager who independently checks the task can begin review, decide the submitted evidence, and verify the task once all its submitted evidence is approved. A rejected task can be resubmitted. Verification permits completion. Blocking, resuming, and cancelling require a reason. Deadline amendments record the actor, old date, new date, and reason.

| Method and path under `/api/v1` | Inputs and result |
| --- | --- |
| `GET /obligations` | Scoped list with optional `offset`, `requirementId`, and `gapId`. |
| `POST /obligations` | `requirementId`, optional `gapId`, `title`, `description`, `departmentId`, `accountableId`, `targetDate`, `priority`, and nullable `applicability`. |
| `GET /obligations/:id` | Obligation, requirement and remediation references, and deadline history. |
| `PATCH /obligations/:id` | `revision` plus `action: "approve"` or editable fields. A changed `targetDate` requires `reason`. |
| `GET /tasks` | Scoped list with optional `offset`, `obligationId`, `departmentId`, `mine`, `overdue`, and `status`. |
| `POST /tasks` | `obligationId`, `title`, `description`, and `dueDate`. |
| `GET /tasks/:id` | Task, current assignment, comments, status history, and deadline history. |
| `PATCH /tasks/:id` | `revision`, editable fields, and optional `action` of `start`, `block`, `resume`, `cancel`, or `complete`. A deadline change, block, resume, or cancellation requires `reason`. |
| `POST /tasks/:id/assign` | `revision` and `assigneeId`. |
| `POST /tasks/:id/comments` | Comment `body`. |
| `POST /tasks/:id/submit` | `revision` and submission `note`. |
| `POST /tasks/:id/verify` | `revision`, `decision` of `start_review`, `verify`, or `reject`, and `note` for rejection. |
| `GET /work/eligible-users` | Active users available for assignment in a permitted `departmentId`. |

## Task evidence and audit trail

Open an assigned task in progress and upload a PDF, PNG, or JPEG up to 10 MiB. Submit the task once files are attached. The reviewer starts task review, opens each evidence record to download and inspect the submitted version, and records a decision with a comment. Rejected files require a replacement version before resubmission. Prior versions and their decisions remain visible. Tasks already verified or completed before this migration retain their status. A legacy note-only submission must be returned for new evidence before verification.

Task and obligation pages link to the original requirement and PDF version. Super Admins and Internal Auditors can open the **Audit log** and filter by entity ID or action. The application connects as the restricted PostgreSQL role `regutrack_app`. It can read and append audit events. Database grants and an append-only trigger protect existing records. The migration role owns the tables and is used separately.

| Method and path under `/api/v1` | Inputs and result |
| --- | --- |
| `POST /tasks/:id/evidence` | Multipart `file` with `title` for a new record or `evidenceId` for a replacement. |
| `GET /tasks/:id/evidence` | Evidence records, latest versions, and decisions within task scope. |
| `GET /evidence/:id` | File versions, checksums, uploaders, and reviewer decisions. |
| `GET /evidence/:id/download?versionId=...` | Authorized attachment download for the selected version. |
| `POST /evidence/:id/approve` and `POST /evidence/:id/reject` | `versionId`, current task `revision`, and `comment`. |
| `GET /audit-logs` | Restricted audit events with optional `before` cursor, `action`, and `targetId`. |
| `GET /obligations/:id/history` and `GET /tasks/:id/history` | Scoped audit events and lineage to the approved requirement. |

For backups, pause application writes and take a PostgreSQL custom-format dump using the database owner. Back up the corresponding RustFS objects in both `regulatory-pdfs` and `task-evidence`, including superseded evidence files. Store the dump and objects together in access-controlled backup storage. Verify restores on an isolated stack by opening a saved task, downloading a prior evidence version, and following its audit history. Keep credentials separately.

## Dashboards, reports, and notifications

**Dashboard** opens the view for the signed-in role. Compliance officers see regulatory activity, approved obligations, risk-priority work, and progress by department. Department managers see their own department. Employees see tasks assigned to them. Internal auditors can open completed tasks, inspect recent evidence decisions, and search the audit log. For accounts with multiple roles, the dashboard chooses the compliance view first, then auditor, department manager, or employee. The reports and metrics use the account's server-enforced work scope.

**Reports** shows compliance obligations, overdue tasks, and department progress. Each report supports an optional department filter. CSV downloads export up to 500 rows from the selected report offset and neutralize spreadsheet formulas in text fields. **Notifications** lists events for the signed-in user and supports marking each one as read.

BullMQ runs a delivery sweep every 30 seconds. It converts recorded workflow events into notifications for obligation and task assignment, evidence submission and decisions, uploaded regulatory versions, and requirements awaiting review. It reminds assignees within three days of a due date, sends an overdue notification, and escalates work at least two days overdue to department managers. A recipient gets one notification per event or deadline condition and due date. Deadline calculations use India Standard Time. Regulatory update notifications refer to uploaded versions.

| Method and path under `/api/v1` | Inputs and result |
| --- | --- |
| `GET /dashboard/summary` | Role view and scoped metrics. |
| `GET /dashboard/departments` | Scoped department progress. |
| `GET /dashboard/tasks` | Page of scoped tasks, recent updates, and recent evidence decisions for auditors. Optional `offset`. |
| `GET /dashboard/deadlines` | Upcoming and overdue tasks, upcoming obligation targets, and high-priority work for compliance officers. |
| `GET /notifications` | Current user's inbox and unread count. Optional `offset`. |
| `PATCH /notifications/:id/read` | Marks one of the current user's notifications as read. |
| `GET /reports/compliance`, `/reports/overdue`, or `/reports/department-progress` | Optional `departmentId`, `offset`, and `format` of `json` or `csv`. |

## Compliance assistant

Open a processed PDF version. An authorized compliance officer can choose **Approve and index** to admit its extracted text into the assistant's source collection. This approval is specific to assistant retrieval. The background worker sends text to Gemini for 768-dimensional embeddings and stores those vectors in PostgreSQL. A version becomes searchable after its entire index succeeds. Officers can revoke a version from the same panel. The index accepts up to 2,000 extracted chunks per version.

Open **Compliance assistant**, choose a source type, and submit a question. Regulatory text is retrieved from approved, indexed versions the user can access through the shared library. Comparison questions use a saved comparison for which both versions are indexed. Pending-obligation questions use only approved records in the caller's work scope and linked to indexed sources. The pending view supplies up to ten records ordered by target date. The question and selected source text are sent to Gemini when the user opts in.

ReguTrack checks each quote against the retrieved evidence and displays the AI interpretation separately. Citations link to the document version, PDF page, and the obligation where applicable. Weak retrieval, unknown citations, or a source revoked during the request return an insufficient-source response. Gemini does not receive workflow write capabilities.

| Method and path under `/api/v1` | Inputs and result |
| --- | --- |
| `GET /assistant/sources` | Regulations with approved and indexed versions. |
| `GET /assistant/documents/:id` | Index status and any failure for a processed document version. |
| `POST /assistant/documents/:id/index` | `allowProvider: true`. Approves the version and queues indexing. |
| `POST /assistant/documents/:id/revoke` | Empty JSON object. Revokes the version and deletes its embeddings. |
| `POST /assistant/ask` | `question`, `allowProvider: true`, optional `mode` of `regulatory`, `comparison`, or `pending`, and optional `regulationId`. Comparison mode requires `regulationId`. |

Run the Phase 2 integration test with disposable PostgreSQL, Redis queue, and S3 test fixtures. OCR tests run inside the extraction container with Tesseract installed.

```powershell
docker compose cp apps/api/test/regulatory.integration.mjs api:/tmp/regulatory.integration.mjs
docker compose cp db/migrations/002_identity.sql api:/tmp/002_identity.sql
docker compose cp db/migrations/003_regulations.sql api:/tmp/003_regulations.sql
docker compose cp db/migrations/004_intelligence.sql api:/tmp/004_intelligence.sql
docker compose cp db/migrations/005_comparisons.sql api:/tmp/005_comparisons.sql
docker compose cp db/migrations/006_gaps.sql api:/tmp/006_gaps.sql
docker compose cp db/migrations/007_work.sql api:/tmp/007_work.sql
docker compose cp db/migrations/008_evidence.sql api:/tmp/008_evidence.sql
docker compose cp db/migrations/010_notifications.sql api:/tmp/010_notifications.sql
docker compose cp db/migrations/011_assistant.sql api:/tmp/011_assistant.sql
# Run in a local test stack with database-owner PGUSER and PGPASSWORD in this shell.
docker compose exec -T -e PGUSER -e PGPASSWORD -e REGULATIONS_MIGRATIONS=/tmp api node --test /tmp/regulatory.integration.mjs
docker compose cp services/ai/test_pdf_extract.py ai:/tmp/test_pdf_extract.py
docker compose exec -T ai python -m unittest discover -s /tmp -p test_pdf_extract.py
docker compose cp services/ai/test_intelligence.py ai:/tmp/test_intelligence.py
docker compose exec -T ai python -m unittest discover -s /tmp -p test_intelligence.py
docker compose cp services/ai/test_comparison.py ai:/tmp/test_comparison.py
docker compose exec -T ai python -m unittest discover -s /tmp -p test_comparison.py
```

Run the Phase 1 integration test against the local PostgreSQL container. It uses an isolated, temporary schema and removes its fixtures on completion.

```powershell
docker compose cp apps/api/test/identity.integration.mjs api:/tmp/identity.integration.mjs
docker compose cp db/migrations/002_identity.sql api:/tmp/002_identity.sql
docker compose exec -T -e PGUSER -e PGPASSWORD -e IDENTITY_MIGRATION=/tmp/002_identity.sql api node --test /tmp/identity.integration.mjs
```

## Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/web` | React, TypeScript, Vite, and Tailwind sign-in and administration screens |
| `apps/api` | Express health probes, authentication, authorization, and account administration |
| `services/ai` | FastAPI health endpoint and Pydantic schema |
| `db/migrations` | Versioned SQL for pgvector, the identity tables, and the six system roles |
| `compose.yaml` | Local service orchestration and disposable application containers with persistent database and Redis volumes |

The Compose setup is for local development. Only the three HTTP services are published, each bound to loopback. PostgreSQL and Redis stay on the Compose network. Health endpoints expose service status only. Local HTTP uses `SECURE_COOKIES=false`. Set it to `true` when serving behind HTTPS. The login rate limiter uses process memory in this single-instance setup. Compliance workflows and provider integrations belong to later phases.
