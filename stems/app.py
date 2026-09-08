"""Stem separation service: runs Demucs over files on the shared data volume.

The API container posts a path inside DATA_DIR to /separate and polls
/jobs/<id>; the audio never leaves the machine.
"""

import os
import re
import subprocess
import sys
import threading
import uuid
from collections import deque
from pathlib import Path

from flask import Flask, jsonify, request

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs")
STEMS = ("vocals", "drums", "bass", "other")
PERCENT = re.compile(r"(\d+)%\|")

app = Flask(__name__)
jobs = {}
lock = threading.Lock()
# separation saturates the CPU, so tracks are handled one at a time
worker = threading.Semaphore(1)


def inside_data_dir(value: str) -> Path:
    """Resolves a client-supplied relative path, refusing anything outside DATA_DIR."""
    path = (DATA_DIR / str(value).lstrip("/")).resolve()
    if path != DATA_DIR and DATA_DIR not in path.parents:
        raise ValueError(f"{value} is outside the data directory")
    return path


def run(job_id: str, source: Path, target: Path) -> None:
    with worker:
        target.mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable, "-m", "demucs.separate",
            "-n", MODEL,
            "--mp3", "--mp3-bitrate", "192",
            "-o", str(target),
            "--filename", "{stem}.{ext}",
            str(source),
        ]
        process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1
        )
        tail = deque(maxlen=10)
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            tail.append(line)
            found = PERCENT.search(line)
            if found:
                with lock:
                    jobs[job_id]["progress"] = min(int(found.group(1)) / 100, 1)
        code = process.wait()

        produced = target / MODEL
        for stem in STEMS:
            file = produced / f"{stem}.mp3"
            if file.exists():
                file.replace(target / f"{stem}.mp3")
        if produced.is_dir() and not any(produced.iterdir()):
            produced.rmdir()

        stems = [stem for stem in STEMS if (target / f"{stem}.mp3").exists()]
        with lock:
            if code != 0 or not stems:
                jobs[job_id].update(state="failed", error=" / ".join(tail) or f"demucs exited with {code}")
            else:
                jobs[job_id].update(state="done", progress=1, stems=stems)


@app.get("/health")
def health():
    return jsonify(model=MODEL, stems=list(STEMS))


@app.post("/separate")
def start():
    payload = request.get_json(silent=True) or {}
    try:
        source = inside_data_dir(payload.get("source", ""))
        target = inside_data_dir(payload.get("target", ""))
    except ValueError as err:
        return jsonify(error=str(err)), 400
    if not source.is_file():
        return jsonify(error="Source audio was not found on the shared volume"), 400

    job_id = uuid.uuid4().hex
    with lock:
        jobs[job_id] = {"id": job_id, "state": "running", "progress": 0, "stems": []}
    threading.Thread(target=run, args=(job_id, source, target), daemon=True).start()
    return jsonify(jobs[job_id]), 202


@app.get("/jobs/<job_id>")
def status(job_id):
    with lock:
        job = jobs.get(job_id)
    if not job:
        return jsonify(error="Unknown job"), 404
    return jsonify(job)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8001")), threaded=True)
