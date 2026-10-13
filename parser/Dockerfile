# Report pipeline for the radiology module (see app.py)
FROM python:3.12-slim

# Configure config location: the back service's config (apiEndpoint, apiKey)
ENV CONFIG_LOCATION=/run/secrets/back

# Don't write __pycache__ into the mounted source directory
ENV PYTHONDONTWRITEBYTECODE=1

WORKDIR /usr/src/app

# Install dependencies first, so code changes don't reinstall them
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8082

# Localhost only (the container uses the host network): the back service is the only caller
CMD ["uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8082"]
