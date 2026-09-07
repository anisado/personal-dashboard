#!/usr/bin/env bash
# Starts the dashboard with a local model (no data leaves the machine) and
# downloads the model on first run.
set -euo pipefail

cd "$(dirname "$0")/.."

MODEL="${OPENAI_MODEL:-qwen2.5:7b-instruct}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.local-ai.yml)

OPENAI_MODEL="$MODEL" "${COMPOSE[@]}" up -d --build

echo "Waiting for the model server..."
until "${COMPOSE[@]}" exec -T ollama ollama list >/dev/null 2>&1; do sleep 2; done

echo "Pulling $MODEL (first run downloads several GB)..."
"${COMPOSE[@]}" exec -T ollama ollama pull "$MODEL"

echo "Ready: http://localhost:${WEB_PORT:-8080}"
