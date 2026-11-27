# SPDX-License-Identifier: Apache-2.0
import unittest
from unittest.mock import patch

from check_public_connectivity import check_target, classify


def response(**overrides):
    return {
        "status": "finished",
        "resolvedAddress": "192.0.2.10",
        "timings": {"dns": 0, "tcp": 1, "tls": 2},
        "tls": {"authorized": True},
        "statusCode": 200,
        "headers": {"content-type": "text/html; charset=utf-8"},
        **overrides,
    }


def measurement(identifier, first, *, brazil=True):
    origins = [("PT", "Lisbon", 64502, response())]
    if brazil:
        origins.extend([
            ("BR", "Sao Paulo", 14593, first),
            ("BR", "Curitiba", 18881, response()),
        ])
    return {
        "id": identifier,
        "createdAt": "2026-11-23T18:14:00Z",
        "results": [
            {"probe": {"country": country, "city": city, "asn": asn}, "result": data}
            for country, city, asn, data in origins
        ],
    }


class PublicConnectivityTest(unittest.TestCase):
    def test_reports_furthest_verified_stage(self):
        cases = (
            (response(status="in-progress"), "incomplete"),
            (response(resolvedAddress=None), "dns"),
            (response(timings={"dns": 0, "tcp": None}), "tcp"),
            (response(timings={"dns": 0, "tcp": 0, "tls": None}), "tls"),
            (response(tls={"authorized": False}), "tls"),
            (response(headers={"x-vercel-mitigated": "challenge"}), "http"),
            (response(), "ok"),
        )
        for data, stage in cases:
            with self.subTest(stage=stage):
                self.assertEqual(classify(data, 200), stage)

    def test_requires_redirect_to_canonical_host(self):
        self.assertEqual(classify(response(statusCode=308, headers={"location": "https://flofi.xyz/"}), 308), "ok")
        self.assertEqual(classify(response(statusCode=308, headers={"location": "https://www.flofi.xyz/"}), 308), "http")

    def test_replays_probes_and_reports_recurring_transport_failure(self):
        fault = response(timings={"dns": 0, "tcp": None})
        with patch("check_public_connectivity.measure", side_effect=[
            measurement("first", fault), measurement("again", fault),
        ]) as measure:
            result = check_target("flofi.xyz", "/", 200)
        self.assertEqual(measure.call_args.args[-1], [{"magic": "first", "limit": 3}])
        self.assertEqual(result["recurring"], [("BR", "Sao Paulo", 14593)])
        self.assertFalse(result["coverage_incomplete"])

    def test_detects_recurrence_when_dns_selects_a_different_ip(self):
        fault = response(timings={"dns": 0, "tcp": None})
        moved_fault = {**fault, "resolvedAddress": "192.0.2.11"}
        with patch("check_public_connectivity.measure", side_effect=[
            measurement("first", fault), measurement("again", moved_fault),
        ]):
            self.assertEqual(check_target("flofi.xyz", "/", 200)["recurring"], [("BR", "Sao Paulo", 14593)])

    def test_missing_retry_cannot_show_recovery(self):
        fault = response(timings={"dns": 0, "tcp": None})
        with patch("check_public_connectivity.measure", side_effect=[
            measurement("first", fault), measurement("again", response(), brazil=False),
        ]):
            result = check_target("flofi.xyz", "/", 200)
        self.assertEqual(result["missing_retry"], [("BR", "Sao Paulo", 14593)])
        self.assertTrue(result["coverage_incomplete"])

    def test_europe_only_or_probe_service_failure_cannot_pass(self):
        with patch("check_public_connectivity.measure", return_value=measurement("first", response(), brazil=False)):
            self.assertTrue(check_target("flofi.xyz", "/", 200)["coverage_incomplete"])
        with patch("check_public_connectivity.measure", side_effect=TimeoutError("probe service timeout")):
            self.assertTrue(check_target("flofi.xyz", "/", 200)["coverage_incomplete"])

    def test_brazilian_probes_from_unaffected_networks_cannot_replace_required_origins(self):
        sample = measurement("first", response())
        sample["results"][1]["probe"]["asn"] = 64500
        with patch("check_public_connectivity.measure", return_value=sample):
            self.assertTrue(check_target("flofi.xyz", "/", 200)["coverage_incomplete"])


if __name__ == "__main__":
    unittest.main()
