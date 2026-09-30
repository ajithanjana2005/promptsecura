"""FastAPI application factory.

Run with:  uvicorn app.main:app --host 0.0.0.0 --port 8000   (from backend/)

Detectors are loaded once at startup (lifespan) by
``app.pipeline.factory.build_orchestrator``. If a detector cannot load (e.g.
Presidio or every candidate spaCy model is missing), the app still starts so
that /health can report the problem, but /api/v1/analyze returns 503 until it
is fixed. It never falls back to a partial analysis.
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
from app.pipeline.factory import StartupReport, build_orchestrator

logger = logging.getLogger("promptsecura")

OrchestratorFactory = Callable[[Settings], StartupReport]


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
        report = orchestrator_factory(settings)
        app.state.orchestrator = report.orchestrator
        app.state.components = report.components
        app.state.component_details = report.details
        logger.info("PromptSecura backend started components=%s", report.components)
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
    app.state.component_details = {}

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
