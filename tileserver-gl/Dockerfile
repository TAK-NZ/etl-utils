FROM maptiler/tileserver-gl:latest

# Switch to root to install packages
USER root

# Set environment to non-interactive
ENV DEBIAN_FRONTEND=noninteractive

# Install curl, xvfb for virtual display, and unzip for AWS CLI installation
RUN apt-get update && apt-get install -y --no-install-recommends curl xvfb unzip && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf awscliv2.zip aws

# Create config directory
RUN mkdir -p /data

# Copy startup script
COPY startup.sh /startup.sh
RUN chmod +x /startup.sh

# Copy default config
COPY config.json /data/config.json
COPY *.json /data/

WORKDIR /data

EXPOSE 8080

CMD ["/startup.sh"]