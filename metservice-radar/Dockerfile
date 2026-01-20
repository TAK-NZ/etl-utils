FROM python:3.11-slim

# Install system dependencies for GDAL and image processing
RUN apt-get update && apt-get install -y \
    gdal-bin libgdal-dev python3-gdal \
    build-essential g++ \
    libjpeg62-turbo-dev libpng-dev \
    libavcodec-dev libavformat-dev libswscale-dev \
    libgtk2.0-dev pkg-config \
    libgl1 libglib2.0-0 libsm6 libxrender1 libxext6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "server.py"]