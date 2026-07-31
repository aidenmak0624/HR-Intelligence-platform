# HR Multi-Agent Platform — Multi-stage Production Dockerfile
# ─────────────────────────────────────────────────────────

# ── Stage 1: Builder ──────────────────────────────────────
FROM python:3.10-slim AS builder

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

# Install build deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2: Production ──────────────────────────────────
FROM python:3.10-slim AS production

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=5050 \
    WORKERS=1 \
    THREADS=8 \
    TIMEOUT=300

# Runtime deps only (no gcc)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq5 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r appuser && useradd -r -g appuser -d /app appuser

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Copy application source
COPY src/ ./src/
COPY frontend/ ./frontend/
COPY config/ ./config/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY data/policies/ ./data/policies/
COPY data/knowledge_base/ ./data/knowledge_base/
COPY run.py alembic.ini requirements.txt ./

# Bake the RAG index at build time: downloads the embedding model into the
# HF cache and ingests policy docs into ./chromadb_hr, so containers start
# with a warm index instead of downloading + ingesting at cold start.
# HOME must point at /app BEFORE the bake: ChromaDB's default ONNX embedding
# function caches under $HOME/.cache/chroma, and the runtime user's home is
# /app — without this the model bakes into /root and every cold container
# re-downloads ~80MB on its first query.
ENV HF_HOME=/app/.hf_cache \
    HOME=/app
# Single layer: bake, drop the downloaded ONNX archive, create runtime dirs
# and chown — a separate chown layer would duplicate the whole cache tree
RUN python scripts/build_rag_index.py \
    && find /app/.cache -name "*.tar.gz" -delete 2>/dev/null || true \
    && mkdir -p logs data/chroma_db data/documents \
    && chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

EXPOSE ${PORT}

# Cloud Run uses its own startup/liveness probes — Docker HEALTHCHECK
# is ignored but kept for local `docker run` convenience.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl -f http://localhost:${PORT}/api/v2/health || exit 1

# Gunicorn with configurable workers and timeout
# NOTE: --preload removed so Gunicorn binds the port immediately
# (Cloud Run needs the port open fast to pass its startup probe).
# Workers initialize independently after fork.
# --threads switches to the gthread worker so a query waiting on
# background service init (await_agent_service) can't stall the rest
# of the site behind a single sync worker.
CMD gunicorn \
    --bind 0.0.0.0:${PORT} \
    --workers ${WORKERS} \
    --threads ${THREADS} \
    --timeout ${TIMEOUT} \
    --access-logfile - \
    --error-logfile - \
    --log-level info \
    run:app
