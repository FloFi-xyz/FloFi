# SPDX-License-Identifier: Apache-2.0
"""Check FloFi's public DNS, TCP, TLS and HTTP from Brazilian and Portuguese networks."""

import concurrent.futures
import json
import sys
import time
import urllib.request


API = "https://api.globalping.io/v1/measurements"
TARGETS = (
    ("flofi.xyz", "/", 200),
    ("www.flofi.xyz", "/", 308),
    ("flofi.xyz", "/login", 200),
)
LOCATIONS = (
    {"magic": "Sao Paulo+eyeball-network", "limit": 2},
    {"magic": "Sao Paulo+AS14593", "limit": 1},
    {"magic": "Brazil+AS18881", "limit": 2},
    {"magic": "Portugal", "limit": 1},
)
STAGES = ("dns", "tcp", "tls", "http")
INCIDENT_ASNS = {14593, 18881}


def api_json(url, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        url, data=body, headers={
            "Content-Type": "application/json",
            "User-Agent": "FloFi-public-connectivity-check/1",
        },
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def measure(host, path, locations):
    measurement = api_json(API, {
        "type": "http",
        "target": host,
        "locations": locations,
        "measurementOptions": {
            "protocol": "HTTP2",
            "ipVersion": 4,
            "request": {"method": "GET", "path": path},
        },
    })
    identifier = measurement["id"]
    if not isinstance(identifier, str) or not identifier.isalnum():
        raise ValueError("Invalid Globalping measurement ID")
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        time.sleep(1)
        result = api_json(f"{API}/{identifier}")
        if result["status"] == "finished":
            return result
        if result["status"] != "in-progress":
            raise ValueError(f"Globalping measurement {identifier} did not finish")
    raise TimeoutError(f"Globalping measurement {identifier} exceeded polling deadline")


def classify(data, expected_status):
    timings = data.get("timings")
    if data.get("status") not in {"finished", "failed"} or not isinstance(timings, dict):
        return "incomplete"
    if not data.get("resolvedAddress"):
        return "dns"
    if timings.get("tcp") is None:
        return "tcp"
    if timings.get("tls") is None or not (data.get("tls") or {}).get("authorized"):
        return "tls"
    headers = data.get("headers") or {}
    if (
        data.get("status") != "finished"
        or data.get("statusCode") != expected_status
        or headers.get("x-vercel-mitigated")
        or (expected_status == 308 and headers.get("location") != "https://flofi.xyz/")
        or (expected_status == 200 and not headers.get("content-type", "").startswith("text/html"))
    ):
        return "http"
    return "ok"


def summarize(measurement, expected_status):
    return [
        {
            "country": probe["country"],
            "city": probe["city"],
            "asn": probe["asn"],
            "ip": data.get("resolvedAddress"),
            "stage": classify(data, expected_status),
            "status": data.get("statusCode"),
            "timings_ms": data.get("timings"),
            "edge_id": (data.get("headers") or {}).get("x-vercel-id"),
        }
        for row in measurement["results"]
        for probe, data in [(row["probe"], row["result"])]
    ]


def has_regional_coverage(rows):
    brazil = [row for row in rows if row["country"] == "BR" and row["stage"] != "incomplete"]
    return (
        INCIDENT_ASNS <= {row["asn"] for row in brazil}
        and any(row["city"] == "Sao Paulo" and row["asn"] == 14593 for row in brazil)
        and any(row["country"] == "PT" and row["stage"] != "incomplete" for row in rows)
    )


def origins_at_stages(rows, stages):
    return {
        (row["country"], row["city"], row["asn"])
        for row in rows if row["stage"] in stages and row["asn"]
    }


def check_target(host, path, expected_status):
    attempts = []
    result = {"target": f"https://{host}{path}", "attempts": attempts}
    recurring = set()
    missing_retry = set()
    try:
        locations = LOCATIONS
        for _ in range(2):
            measurement = measure(host, path, locations)
            rows = summarize(measurement, expected_status)
            attempts.append({
                "measurement_id": measurement["id"],
                "time": measurement["createdAt"],
                "probes": rows,
            })
            if not origins_at_stages(rows, STAGES):
                break
            locations = [{"magic": measurement["id"], "limit": len(rows)}]
        if len(attempts) == 2:
            first_failures = origins_at_stages(attempts[0]["probes"], STAGES)
            recurring = first_failures & origins_at_stages(attempts[1]["probes"], STAGES)
            missing_retry = first_failures - origins_at_stages(attempts[1]["probes"], (*STAGES, "ok"))
    except (OSError, ValueError, KeyError, TypeError) as error:
        result["error"] = str(error)

    incomplete = "error" in result or bool(missing_retry) or not all(
        has_regional_coverage(attempt["probes"]) for attempt in attempts
    )
    result["recurring"] = sorted(recurring)
    result["missing_retry"] = sorted(missing_retry)
    result["coverage_incomplete"] = incomplete
    return result


def main():
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(TARGETS)) as executor:
        runs = [executor.submit(check_target, *target) for target in TARGETS]
        results = [run.result() for run in runs]
    for result in results:
        print(json.dumps(result), flush=True)
    if any(result["recurring"] for result in results):
        return 1
    if any(result["coverage_incomplete"] for result in results):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
