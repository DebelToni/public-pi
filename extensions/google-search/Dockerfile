FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium python3 ca-certificates fonts-dejavu-core xvfb fluxbox x11vnc novnc websockify && rm -rf /var/lib/apt/lists/*
COPY browser.py /browser.py
USER 1000:1000
ENV HOME=/tmp XDG_CONFIG_HOME=/tmp/config
ENTRYPOINT ["/usr/bin/python3", "/browser.py"]
