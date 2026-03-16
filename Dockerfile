FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY static ./static
COPY docs ./docs

RUN useradd --create-home opsvoice
USER opsvoice

EXPOSE 8080

CMD ["python", "-m", "app.main"]
