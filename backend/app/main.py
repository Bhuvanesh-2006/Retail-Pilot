"""FastAPI application entry point: `uvicorn app.main:app --reload` from backend/."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.errors import ApiError, install_error_handlers
from app.api.routes import APP_VERSION, router
from app.config import PROJECT_DIR, get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

settings = get_settings()
app = FastAPI(title="RetailPilot API", version=APP_VERSION,
              description="AI sales intelligence agent over the UCI Online Retail II dataset.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type"],
)
install_error_handlers(app)
app.include_router(router)

# Serve the built frontend (single-process deployment) when frontend/dist exists.
DIST = PROJECT_DIR / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise ApiError(404, "not_found", "Unknown API endpoint")
        candidate = (DIST / full_path).resolve()
        if full_path and candidate.is_file() and Path(DIST.resolve()) in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
