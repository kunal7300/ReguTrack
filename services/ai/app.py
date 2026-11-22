import os
from hmac import compare_digest
from typing import Literal
import pymupdf

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel
from pdf_extract import Extraction, extract, open_pdf, pdf_body
from intelligence import AnalysisInput, AnalysisResult, analyze
from comparison import ComparisonInput, ComparisonResult, run_comparison
from gaps import GapInput, GapSuggestion, suggest
from assistant import AnswerInput, Answer, EmbedInput, answer, embed


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: Literal["ai"]


app = FastAPI(title="ReguTrack AI Service")


def authorize_pdf(request: Request) -> None:
    secret = os.environ.get("PDF_SERVICE_TOKEN")
    supplied = request.headers.get("authorization", "").encode("utf-8")
    if not secret or not compare_digest(supplied, f"Bearer {secret}".encode("utf-8")):
        raise HTTPException(401, "Service authentication required")


async def assistant_input(request: Request, schema):
    authorize_pdf(request)
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > 400_000:
            raise HTTPException(413, "Assistant input too large")
    try:
        return schema.model_validate_json(data)
    except ValueError as exc:
        raise HTTPException(422, "Invalid assistant input") from exc


@app.post("/internal/assistant/embed")
async def assistant_embed(request: Request):
    return await run_in_threadpool(embed, await assistant_input(request, EmbedInput))


@app.post("/internal/assistant/answer", response_model=Answer)
async def assistant_answer(request: Request):
    return await run_in_threadpool(answer, await assistant_input(request, AnswerInput))


@app.post("/internal/evidence/validate", status_code=204)
async def validate_evidence(request: Request) -> Response:
    authorize_pdf(request)
    mime = request.headers.get("content-type")
    data = await pdf_body(request)

    def validate():
        if mime == "application/pdf":
            with open_pdf(data):
                return
        signatures = {"image/png": b"\x89PNG\r\n\x1a\n", "image/jpeg": b"\xff\xd8\xff"}
        if mime not in signatures or not data.startswith(signatures[mime]):
            raise HTTPException(422, "Evidence format is invalid")
        try:
            with pymupdf.open(stream=data, filetype=mime.split("/")[1]) as image:
                rect = image[0].rect
                if rect.width * rect.height > 12_000_000:
                    raise ValueError()
                image[0].get_pixmap()
        except (ValueError, RuntimeError, IndexError) as exc:
            raise HTTPException(422, "Evidence image is damaged or oversized") from exc

    await run_in_threadpool(validate)
    return Response(status_code=204)


@app.post("/internal/gaps/suggest", response_model=GapSuggestion)
async def suggest_gap(request: Request) -> GapSuggestion:
    authorize_pdf(request)
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > 256_000:
            raise HTTPException(413, "Gap input too large")
    try:
        payload = GapInput.model_validate_json(data)
    except ValueError as exc:
        raise HTTPException(422, "Invalid gap input") from exc
    return await run_in_threadpool(suggest, payload)


@app.post("/internal/intelligence/analyze", response_model=AnalysisResult)
async def analyze_document(request: Request) -> AnalysisResult:
    authorize_pdf(request)
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > 2_000_000:
            raise HTTPException(413, "Analysis input exceeds size limit")
    try:
        payload = AnalysisInput.model_validate_json(data)
    except ValueError as exc:
        raise HTTPException(422, "Invalid analysis input") from exc
    return await run_in_threadpool(analyze, payload)


@app.post("/internal/regulations/compare", response_model=ComparisonResult)
async def compare_documents(request: Request) -> ComparisonResult:
    authorize_pdf(request)
    data = bytearray()
    async for part in request.stream():
        data.extend(part)
        if len(data) > 4_000_000:
            raise HTTPException(413, "Comparison input exceeds size limit")
    try:
        payload = ComparisonInput.model_validate_json(data)
        return await run_in_threadpool(run_comparison, payload)
    except ValueError as exc:
        raise HTTPException(422, "Comparison input is invalid or exceeds section limits") from exc


@app.post("/internal/pdf/validate", status_code=204)
async def validate_pdf(request: Request) -> Response:
    authorize_pdf(request)
    data = await pdf_body(request)
    def validate():
        with open_pdf(data):
            pass
    await run_in_threadpool(validate)
    return Response(status_code=204)


@app.post("/internal/pdf/extract", response_model=Extraction)
async def extract_pdf(request: Request) -> Extraction:
    authorize_pdf(request)
    return await run_in_threadpool(extract, await pdf_body(request))


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="ai")
