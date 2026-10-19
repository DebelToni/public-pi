# Codex usage API

> Internal, undocumented ChatGPT endpoint; its schema may change.

## Request

```http
GET https://chatgpt.com/backend-api/wham/usage
Accept: */*
Authorization: Bearer <ChatGPT OAuth access token>
chatgpt-account-id: <ChatGPT account ID>
```

The account ID is available as `accountId` in some OAuth records, or in the access-token JWT claim:

```python
claims["https://api.openai.com/auth"]["chatgpt_account_id"]
```

Do not print, log, commit, or permanently embed the access token. Let Pi/Codex refresh expired OAuth credentials.

## Minimal Python request

```python
import json
import os
import urllib.request

request = urllib.request.Request(
    "https://chatgpt.com/backend-api/wham/usage",
    headers={
        "accept": "*/*",
        "authorization": f"Bearer {os.environ['CHATGPT_ACCESS_TOKEN']}",
        "chatgpt-account-id": os.environ["CHATGPT_ACCOUNT_ID"],
    },
)
with urllib.request.urlopen(request, timeout=15) as response:
    usage = json.load(response)
```

## Quota fields

General Codex quota:

```python
general = usage["rate_limit"]
```

GPT-5.3-Codex-Spark has a separate entry:

```python
spark = next((
    item["rate_limit"]
    for item in usage.get("additional_rate_limits", [])
    if item.get("limit_name") == "GPT-5.3-Codex-Spark"
    or item.get("metered_feature") == "codex_bengalfox"
), None)
```

For either quota, inspect:

```text
allowed
limit_reached
primary_window.used_percent
primary_window.reset_at             # Unix timestamp in seconds
primary_window.reset_after_seconds
primary_window.limit_window_seconds
```

Remaining percentage is `100 - used_percent`. `additional_rate_limits` or individual windows may be absent.
