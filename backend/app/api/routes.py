"""HTTP routes.

Fail-closed contract for clients (enforced by the extension in Phase 3):
any non-200 response from /api/v1/analyze means "no security decision was
made". Clients must not treat it as ALLOW.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.pipeline.base import AnalysisIncompleteError
from app.schemas.analysis import AnalyzeRequest, AnalyzeResponse, ErrorResponse, HealthResponse

FAIL_CLOSED_MESSAGE = "PromptSecura could not complete the security analysis."

router = APIRouter()


def _error(status_code: int, error: str, message: str, retryable: bool) -> JSONResponse:
    body = ErrorResponse(error=error, message=message, retryable=retryable)
    return JSONResponse(status_code=status_code, content=body.model_dump())


@router.get("/health", response_model=HealthResponse)
def health(request: Request) -> HealthResponse:
    components = dict(request.app.state.components)
    ready = bool(components) and all(state == "ready" for state in components.values())
    return HealthResponse(
        status="ok" if ready else "degraded",
        version=request.app.state.settings.version,
        components=components,
    )


@router.post(
    "/api/v1/analyze",
    response_model=AnalyzeResponse,
    responses={
        413: {"model": ErrorResponse, "description": "Prompt exceeds the configured maximum length."},
        503: {"model": ErrorResponse, "description": "Analysis unavailable or incomplete (fail-closed)."},
    },
)
def analyze(body: AnalyzeRequest, request: Request) -> AnalyzeResponse | JSONResponse:
    settings = request.app.state.settings
    if len(body.prompt) > settings.max_prompt_chars:
        return _error(
            413,
            "prompt_too_long",
            f"Prompt exceeds the maximum of {settings.max_prompt_chars} characters.",
            retryable=False,
        )

    orchestrator = request.app.state.orchestrator
    if orchestrator is None:
        return _error(503, "analysis_unavailable", FAIL_CLOSED_MESSAGE, retryable=True)

    try:
        result = orchestrator.analyze(body.prompt, site=body.site)
    except AnalysisIncompleteError:
        return _error(503, "analysis_incomplete", FAIL_CLOSED_MESSAGE, retryable=True)

    return AnalyzeResponse.from_result(result)
