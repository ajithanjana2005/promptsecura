#!/usr/bin/env bash
# Runs once when the Codespace / dev container is created.
set -euo pipefail

cd "$(dirname "$0")/../backend"

echo "==> Installing backend Python dependencies"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

MODEL="${PROMPTSECURA_SPACY_MODEL:-en_core_web_lg}"
echo "==> Downloading spaCy model: ${MODEL} (large download, can take a few minutes)"
python -m spacy download "${MODEL}"

echo "==> Verifying imports"
python -c "import fastapi, presidio_analyzer, spacy; spacy.load('${MODEL}'); print('Backend dependencies OK')"

echo
echo "Setup complete. Next steps:"
echo "  cd backend && python -m pytest"
echo "  cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000"
