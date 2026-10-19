# Google browser search

Search tools backed by a dedicated headed Chromium desktop and Python Playwright. Browser/account state and VNC credentials stay local and are never part of this repository.

Build the image from this directory, then review and run `start-desktop.sh`. It creates a Docker volume for the browser profile, starts the desktop container, and binds noVNC and CDP to loopback. Sign into Google manually through your own authenticated private desktop route. Never expose the debugger or an unauthenticated VNC desktop publicly.

Create the local Python environment before use:

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python playwright==1.57.0
```

The extension opens a separate tab in that browser for searches and closes its tab afterward. If Google returns a CAPTCHA or challenge, stop Google attempts and use another search provider. Browser automation does not bypass a challenge.

Review `browser.py`, `start-desktop.sh`, and the Dockerfile for ports, paths, image tags, and runtime requirements. Container lifecycle, private access, credentials, and profile backups are the operator's responsibility.
