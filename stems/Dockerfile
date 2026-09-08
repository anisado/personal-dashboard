FROM python:3.11-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV PIP_NO_CACHE_DIR=1 \
    TORCH_HOME=/models \
    PORT=8001 \
    DATA_DIR=/data

# the CPU wheels of torch and torchaudio have to come from the same release
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.4.1+cpu torchaudio==2.4.1+cpu \
  && pip install demucs==4.0.1 flask==3.0.3

WORKDIR /app
COPY app.py .

EXPOSE 8001
CMD ["python", "app.py"]
