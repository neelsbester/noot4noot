"""Authenticated post-deploy smoke test for the staging admin API."""

from __future__ import annotations

import argparse
import json
import os
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener


STAGING_ORIGIN = "https://staging.noot4noot.bestermedia.me"


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=STAGING_ORIGIN)
    parser.add_argument("--access-client-id", default=os.environ.get("NOOT4NOOT_ACCESS_CLIENT_ID", ""))
    parser.add_argument("--access-client-secret", default=os.environ.get("NOOT4NOOT_ACCESS_CLIENT_SECRET", ""))
    args = parser.parse_args()
    if not args.access_client_id or not args.access_client_secret:
        parser.error("both Access service-token values are required")

    origin = args.url.rstrip("/")
    if origin != STAGING_ORIGIN:
        parser.error(f"--url must be exactly {STAGING_ORIGIN}")
    headers = {
        "CF-Access-Client-Id": args.access_client_id,
        "CF-Access-Client-Secret": args.access_client_secret,
        "Content-Type": "application/json",
        "Origin": origin,
        "User-Agent": "Noot4Noot-staging-smoke/1.0",
    }
    opener = build_opener(NoRedirects)
    invite_id = ""
    try:
        status, payload = post_json(
            opener,
            f"{origin}/api/admin/invites",
            headers,
            {"label": "Automated staging API test", "lifetime": "day", "maxRedemptions": 1},
        )
        assert status == 201, f"invite creation returned {status}"
        invite = payload.get("invite")
        assert isinstance(invite, dict), "invite creation omitted invite state"
        invite_id = str(invite.get("id", ""))
        assert invite_id, "invite creation omitted its ID"
        assert payload.get("url"), "invite creation omitted its URL"
    finally:
        if invite_id:
            status, _ = post_json(
                opener,
                f"{origin}/api/admin/invites/{invite_id}/revoke",
                headers,
                {},
            )
            assert status == 200, f"invite cleanup returned {status}"

    print("PASS staging Access service identity, Worker admin API, persistence, and cleanup")


def post_json(opener, url: str, headers: dict[str, str], payload: dict[str, object]) -> tuple[int, dict]:
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with opener.open(request, timeout=30) as response:
            body = response.read().decode()
            return response.status, json.loads(body) if body else {}
    except HTTPError as error:
        body = error.read().decode(errors="replace")
        raise AssertionError(f"{url} returned {error.code}: {body[:500]}") from error


if __name__ == "__main__":
    main()
