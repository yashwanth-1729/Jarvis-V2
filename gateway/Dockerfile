# HOLO gateway: slim Python 3.13 image, runs as a non-root user.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/gateway

RUN groupadd --system holo \
 && useradd --system --gid holo --home-dir /srv/gateway --shell /usr/sbin/nologin holo

# Dependencies first so code changes reuse the cached layer.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

USER holo
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=4).status == 200 else 1)"

# One worker on purpose: the per-user rate limiter lives in process memory.
# Scale up the VM before adding workers (and move the limiter to Redis first).
CMD ["uvicorn", "app.main:create_app", "--factory", \
     "--host", "0.0.0.0", "--port", "8080", \
     "--proxy-headers", "--forwarded-allow-ips", "*", \
     "--no-server-header", "--timeout-keep-alive", "75"]
