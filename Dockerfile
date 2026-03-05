FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY transcript-server.py .

CMD ["uvicorn", "transcript-server:app", "--host", "0.0.0.0", "--port", "8000"]