"""FastAPI application factory.

Run with:  uvicorn app.main:app --host 0.0.0.0 --port 8000   (from backend/)

Detectors are loaded once at startup (lifespan). If a detector cannot load
(e.g. Presidio or the spaCy model is missing), the app still starts so that
/health can report the problem, but /api/v1/analyze returns 503 until it is
fixed. It never falls back to a partial analysis.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Callable

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.config import Settings
from app.pipeline.base import DetectorError
from app.pipeline.injection import RuleBasedInjectionDetector
from app.pipeline.orchestrator import AnalysisOrchestrator
from app.pipeline.pii import PresidioPIIDetector

logger = logging.getLogger("promptsecura")

OrchestratorFactory = Callable[[Settings], tuple[AnalysisOrchestrator | None, dict[str, str]]]


def build_orchestrator(settings: Settings) -> tuple[AnalysisOrchestrator | None, dict[str, str]]:
    components: dict[str, str] = {}

    injection = None
    try:
        injection = RuleBasedInjectionDetector.from_file(settings.injection_rules_path)
        components["injection"] = "ready"
    except DetectorError as exc:
        logger.error("Injection detector unavailable: %s", exc)
        components["injection"] = "unavailable"

    pii = None
    try:
        pii = PresidioPIIDetector.create(
            spacy_model=settings.spacy_model,
            entities=settings.pii_entities,
            score_threshold=settings.pii_score_threshold,
        )
        components["pii"] = "ready"
    except DetectorError as exc:
        logger.error("PII detector unavailable: %s", exc)
        components["pii"] = "unavailable"

    if injection is None or pii is None:
        return None, components

    orchestrator = AnalysisOrchestrator(
        pii_detector=pii,
        injection_detector=injection,
        scoring_config=settings.scoring,
        thresholds=settings.thresholds,
    )
    return orchestrator, components


def create_app(
    settings: Settings | None = None,
    orchestrator_factory: OrchestratorFactory = build_orchestrator,
) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        logging.basicConfig(
            level=settings.log_level,
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
        )
        orchestrator, components = orchestrator_factory(settings)
        app.state.orchestrator = orchestrator
        app.state.components = components
        logger.info("PromptSecura backend started components=%s", components)
        yield

    app = FastAPI(
        title=f"{settings.app_name} API",
        version=settings.version,
        description="Prompt security analysis: PII detection, injection detection, risk scoring.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.orchestrator = None
    app.state.components = {"injection": "not_loaded", "pii": "not_loaded"}

    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_origin_regex=settings.cors_origin_regex,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
    )

    @app.exception_handler(Exception)
    async def unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
        # Log the exception type and path only; never the request body.
        logger.error("Unhandled error path=%s error=%s", request.url.path, type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_error",
                "message": "PromptSecura could not complete the security analysis.",
                "retryable": True,
            },
        )

    app.include_router(router)
    return app


app = create_app()
