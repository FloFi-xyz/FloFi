# SPDX-License-Identifier: AGPL-3.0-only
"""BUILD-FLOFI-VERCEL-STORAGE-001: the owner-run deployment cleanup plans exactly what the protection rules allow."""

from datetime import datetime, timezone
import importlib.util
import io
from contextlib import redirect_stdout
import json
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('vercel_deployment_cleanup', ROOT / 'scripts' / 'vercel_deployment_cleanup.py')
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)

# The flofi project as read through the Vercel connector on 2026-11-02 02:47 UTC (id, created ms, state, target, branch, repo),
# with the deployments that held an alias then and the branches that had an open pull request.
INVENTORY = [
    ('dpl_FH7MAHa6zegQGrsyx1FHWSNHPqsM', 1793587726323, 'BUILDING', None, 'claude/festive-keller-om54li', 'FloFi-xyz/FloFi'),
    ('dpl_GuEpMS6kaKPQbS3nKivbQ8ye3QiH', 1793585693327, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_6vL9d2Qkujv8hH9eLr2S6DTr841D', 1793583680727, 'READY', None, 'claude/sleepy-noether-9g1cxy', 'FloFi-xyz/FloFi'),
    ('dpl_HS8Nb756NgjY5R7niJVTw4i6X9T7', 1793582740206, 'READY', None, 'claude/sleepy-noether-9g1cxy', 'FloFi-xyz/FloFi'),
    ('dpl_AyotgPP7L8hweYfcwwE9vj91RRST', 1793580840551, 'READY', None, 'claude/sleepy-noether-9g1cxy', 'FloFi-xyz/FloFi'),
    ('dpl_JEAEuxDtxf9F32DicCtja1oSYxj8', 1793579126038, 'READY', None, 'claude/sleepy-noether-9g1cxy', 'FloFi-xyz/FloFi'),
    ('dpl_VqJRnUfy3ya2PevHQmQuLGW9dQjz', 1793576439290, 'READY', None, 'claude/sleepy-noether-9g1cxy', 'FloFi-xyz/FloFi'),
    ('dpl_3whcNL5PDwnJcc57CR9jKTj5LD1v', 1793574749181, 'READY', None, 'claude/sleepy-noether-9g1cxy', 'FloFi-xyz/FloFi'),
    ('dpl_2bE13XzzVncdzytxNbS2MyWbQE3p', 1793571861397, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_HHUTth3JngfMczsdghvEX4uB1zQc', 1793569914686, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_FWHUikEwAinBQsPP5PoMn3gPtwGs', 1793568712136, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_7FGwKKeDJSVRtNYYvYAXiaZ4hMta', 1793563151052, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_A3RfwmgvbWWwFSUSBF7gRqwA5fRp', 1793562799716, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_FznnKNCnxAegoJRPZ1S5ibQQkQbV', 1793562609518, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_63sHuRKmdZKL7wbwAr4Yqsn6qeaJ', 1793562033132, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_DvDLPw1hk3sf1DcVcjQ2jUAZ9Fss', 1793561992413, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_EZFPLfFWAExGEiXFbq24nR4U374U', 1793561487229, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_CjHUpD1i7VuDAYjH87Vom28FBEY1', 1793561217918, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_BSs51gXqQ5CoddZPvYzw1SZFRxzB', 1793561133722, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_G79UvUTKHAaZppbkogUJfMrkBuew', 1793560722182, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_55wDYBevo7kAwhW2Gi57FG3fWBpG', 1793560299339, 'READY', None, 'claude/clever-newton-bjdy6d', 'FloFi-xyz/FloFi'),
    ('dpl_2jyrf8xr2fi9NRo8ikNFACdHWBMK', 1793555550395, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_54VFoTZHYrwazyTq8xfguZgncv9J', 1793554900397, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_8HZut9r1bKtk2CNRWBnHutZh3kcs', 1793552511646, 'READY', None, 'claude/build-flofi-execution-performance-001', 'FloFi-xyz/FloFi'),
    ('dpl_7nE6XCpPAP5GAZCueDTFXdCMuGbd', 1793551878758, 'READY', None, 'claude/build-flofi-execution-performance-001', 'FloFi-xyz/FloFi'),
    ('dpl_C5b3nEbQSNckeakGgNJcGwMnMAkP', 1793551387722, 'READY', None, 'claude/build-flofi-execution-performance-001', 'FloFi-xyz/FloFi'),
    ('dpl_CD6phvXfk1mMRSPauvRxz9QwgnPX', 1793549653316, 'READY', None, 'claude/build-flofi-execution-performance-001', 'FloFi-xyz/FloFi'),
    ('dpl_Eaq4qsB9BjwTBoiY3ExZK4ZhsxwC', 1793543665483, 'READY', None, 'claude/build-flofi-execution-performance-001', 'FloFi-xyz/FloFi'),
    ('dpl_68KCvWhpefqwvuM4f54ph5ibiQys', 1793542734482, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_CGUBR9mgsSoMiVvT729TU4AvutNg', 1793538533016, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_BY2WgrE3iuMBT5b5okGVrhWN9wcp', 1793523166448, 'READY', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_8uBP2W7XMNQo5F3YADDXfoSn5n6Y', 1793521225530, 'CANCELED', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_3WCE3ELX5hxsZiyWCezYyuqQntEe', 1793518105107, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_73usJPBVuDQVf6jY4aK7rZyeumUn', 1793506619559, 'READY', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_7Z5bsTjLPd7KHMR1gxmHjUWDzSA2', 1793504503756, 'READY', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_G2HHNDZgj1gxKMBuQTixUCcSKhCs', 1793502835499, 'READY', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_3oQ4iscJSnj2Qo9d65f8NnZRbTVd', 1793502392797, 'ERROR', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_7Cr5oariDqeye7f7jyd7vuRKQkSQ', 1793498916746, 'READY', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_6JRwVzAXaNFPsDNWS6zjqY6H69EA', 1793497881498, 'READY', None, 'claude/build-flofi-execution-performance-001', 'FloFi-xyz/FloFi'),
    ('dpl_8YnZrLC5DVVnGDeUjMcrbFCfpfHJ', 1793497830796, 'READY', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_BvwV3DtQj3C24VCqpQ6eAyiDHSK2', 1793497000595, 'READY', None, 'claude/build-flofi-execution-performance-001', 'FloFi-xyz/FloFi'),
    ('dpl_4wUYtAsPZDGeY4gxTLmFfr26c9mu', 1793494629229, 'READY', None, 'release/schema-0019-compat', 'FloFi-xyz/FloFi'),
    ('dpl_8exvTbhQBF7JrMaBsbXHbvZsncrY', 1793494282440, 'READY', None, 'release/schema-0019-compat', 'FloFi-xyz/FloFi'),
    ('dpl_FyMnvzxCLLFXVPxqMN767s2KDaLy', 1793490786592, 'READY', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_27RLwBFuLRcGgXZ4BQGUvhxyAV8L', 1793487670018, 'READY', None, 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_A17ujVivCAK7tqK4FF6P6oDoUo4G', 1793482973404, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_3gonMzfL1abmwR36m4eGyZUBN8nJ', 1793480996051, 'READY', None, 'claude/build-flofi-claude-agents-001', 'FloFi-xyz/FloFi'),
    ('dpl_DNdH5ns7XWTqDJZmYP66aECu92Zj', 1793476821348, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_BUabtp3FaazZH7BrdyDhwDna5DU5', 1793476738006, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_8W6XNdVTEkMH7LG2XBdPTZnRENj8', 1793476606570, 'READY', 'production', 'claude/build-flofi-landing07-readme-001', 'FloFi-xyz/FloFi'),
    ('dpl_2mBqX6zdatTKhCSa6vSh1heALaEg', 1793474373165, 'READY', None, 'claude/build-flofi-landing07-readme-001', 'FloFi-xyz/FloFi'),
    ('dpl_2nVDTNNggMZHjNN54WbHiD2AmUhL', 1793472786939, 'READY', 'production', 'claude/wonderful-shannon-nacbbz', 'FloFi-xyz/FloFi'),
    ('dpl_DgHgoSRyRCQ5UQhUoTS8QbNf26rK', 1793460654722, 'READY', 'production', 'main', 'FloFi-xyz/FloFi'),
    ('dpl_6xzyvxwVaZgR29ekcr3pDcRhyr99', 1793459030067, 'READY', None, 'release/schema-0018-compat-v17-20261031', 'FloFi-xyz/FloFi'),
    ('dpl_3REJLnPog8CxQQV5SVRmRrAxTYQH', 1793457223480, 'READY', None, 'release/schema-0018-compat-v17-20261031', 'FloFi-xyz/FloFi'),
    ('dpl_F7kp9bW93eTt5AcLYxWjgUVxnr1s', 1793402212758, 'READY', None, 'claude/build-flofi-claude-agents-001', 'FloFi-xyz/FloFi'),
    ('dpl_HP52AEBPB1GtrU1uvGV45Gv1rGAM', 1793398853049, 'READY', None, 'claude/festive-darwin-du0oft', 'FloFi-xyz/FloFi'),
    ('dpl_AFo22PdoQyJEB8jbcYdje6mgAYA8', 1793397038070, 'READY', None, 'claude/festive-darwin-du0oft', 'FloFi-xyz/FloFi'),
    ('dpl_8VQ9i3jiwHkqm1Hfnh8nShRis7P9', 1793368309582, 'READY', None, 'release/schema-0017-compat-v16', 'alrimarleskovar/FloFi'),
    ('dpl_2D2eqyaFQh8m4fLVmzZWFUZ1aCab', 1793337398864, 'READY', None, 'claude/build-flofi-intelligence-001', 'alrimarleskovar/FloFi'),
    ('dpl_5NyGz7BfTrhqrrZVwPzz4x5eEUTv', 1793330272074, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_5xy1Jqf51DzmA61QzTAXNkpxb5VW', 1793323414714, 'READY', None, 'fix/p0-live-swap-requote-20261030', 'alrimarleskovar/FloFi'),
    ('dpl_FTwa1iWaXy6Y75nr71HrofaeDozu', 1793323381298, 'READY', None, 'fix/p0-live-swap-requote-20261030', 'alrimarleskovar/FloFi'),
    ('dpl_D6RviAixJd7kHzw9pKu7tkzMUKGA', 1793321886103, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_9kFdCnUyUAdvGGxZYVty62LdhPzo', 1793319761929, 'READY', None, 'claude/build-flofi-bridge-live-fix-003', 'alrimarleskovar/FloFi'),
    ('dpl_Gaw2tR7o7hNwmpbTRAgz8KL2zaKF', 1793316376738, 'READY', None, 'claude/build-flofi-bridge-live-fix-003', 'alrimarleskovar/FloFi'),
    ('dpl_43JWBQzgYzgNs7iZ9CmWpNYe9k9d', 1793294487433, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_HsRJHAuDNkm47qwWzXU2XKpTe8qN', 1793230702051, 'READY', None, 'revert/pr-132-rejected-ux', 'alrimarleskovar/FloFi'),
    ('dpl_BmttPsLLdfyBsCQbNCkfxofDazfp', 1793229009983, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_Bd6q4KzwbMqJjzf5GGa9MGAgJ6zs', 1793211043323, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_2KiSobPqwkro1PhBCqQuJyUU8b46', 1793210871122, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_9v4TzUp1CSfjBmVDjo85t29xirtc', 1793188502136, 'ERROR', None, 'codex/fix-financial-execution-truth-001', 'alrimarleskovar/FloFi'),
    ('dpl_CzF4XXNTRx835YzFN18VE23mAhQ5', 1793141757007, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_o13obpkwZjc5wd9f1cscASXdn1La', 1793140633774, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR', 1793133558523, 'CANCELED', None, 'codex/build-copilot-context-engine-001', 'alrimarleskovar/FloFi'),
    ('dpl_CrHtAoj28jg252K1VKwH2H1VFN2K', 1793119853151, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_APuLWcMVS23Ps21qQpt5ctyBzLcc', 1793118484501, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_49NAYuoAUuU6vnFJtfDMN1tJhCrw', 1793041677449, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_E4QKoe6RB5f9dLLRvQt11CYqpbJx', 1793012125614, 'READY', 'production', 'main', 'alrimarleskovar/FloFi'),
    ('dpl_Hon4mdUPtMhELdfubPgCbbMGrAJJ', 1792083642621, 'READY', None, 'build/ci-gcp-001-bootstrap', 'alrimarleskovar/FloFi'),
    ('dpl_AaHFosMhzyn6oUCUnZ9zTpucYCr4', 1791422197719, 'READY', None, 'codex/build-privacy-001-cloak', 'alrimarleskovar/gryloo'),
    ('dpl_CAuxQ9BWBydcynKpDuozJc3qanhh', 1791076900922, 'READY', None, 'codex/build-016-mode-c-automation', 'alrimarleskovar/gryloo'),
    ('dpl_7WQNJzqYBgeg5NqN6mc6rwTSA67b', 1791073789281, 'READY', None, 'codex/build-tempo-001', 'alrimarleskovar/gryloo'),
    ('dpl_BtWbniK8L1zcd5bbVva2MWujFUPq', 1790894641284, 'READY', None, 'claude/build-015-solana-liquidity', 'alrimarleskovar/gryloo'),
]
ALIASED = {'dpl_2bE13XzzVncdzytxNbS2MyWbQE3p', 'dpl_3gonMzfL1abmwR36m4eGyZUBN8nJ', 'dpl_4wUYtAsPZDGeY4gxTLmFfr26c9mu',
           'dpl_5xy1Jqf51DzmA61QzTAXNkpxb5VW', 'dpl_6vL9d2Qkujv8hH9eLr2S6DTr841D', 'dpl_6xzyvxwVaZgR29ekcr3pDcRhyr99',
           'dpl_7WQNJzqYBgeg5NqN6mc6rwTSA67b', 'dpl_8HZut9r1bKtk2CNRWBnHutZh3kcs', 'dpl_8VQ9i3jiwHkqm1Hfnh8nShRis7P9',
           'dpl_8W6XNdVTEkMH7LG2XBdPTZnRENj8', 'dpl_9kFdCnUyUAdvGGxZYVty62LdhPzo', 'dpl_AaHFosMhzyn6oUCUnZ9zTpucYCr4',
           'dpl_BY2WgrE3iuMBT5b5okGVrhWN9wcp', 'dpl_BtWbniK8L1zcd5bbVva2MWujFUPq', 'dpl_CAuxQ9BWBydcynKpDuozJc3qanhh',
           'dpl_FH7MAHa6zegQGrsyx1FHWSNHPqsM', 'dpl_GuEpMS6kaKPQbS3nKivbQ8ye3QiH', 'dpl_HHUTth3JngfMczsdghvEX4uB1zQc',
           'dpl_HP52AEBPB1GtrU1uvGV45Gv1rGAM', 'dpl_Hon4mdUPtMhELdfubPgCbbMGrAJJ', 'dpl_HsRJHAuDNkm47qwWzXU2XKpTe8qN'}
OPEN_PULL_REQUESTS = {'release/schema-0017-compat-v16', 'fix/p0-live-swap-requote-20261030', 'build/ci-gcp-001-bootstrap',
                      'codex/build-privacy-001-cloak', 'codex/build-tempo-001', 'codex/build-016-mode-c-automation'}
SNAPSHOT = datetime(2026, 11, 2, 2, 47, tzinfo=timezone.utc)
# Verified by hand against the same state (docs/builds/BUILD-FLOFI-VERCEL-STORAGE-001.md, deletion manifest).
EXPECTED = {'dpl_7Cr5oariDqeye7f7jyd7vuRKQkSQ', 'dpl_6JRwVzAXaNFPsDNWS6zjqY6H69EA', 'dpl_8YnZrLC5DVVnGDeUjMcrbFCfpfHJ',
            'dpl_BvwV3DtQj3C24VCqpQ6eAyiDHSK2', 'dpl_8exvTbhQBF7JrMaBsbXHbvZsncrY', 'dpl_FyMnvzxCLLFXVPxqMN767s2KDaLy',
            'dpl_27RLwBFuLRcGgXZ4BQGUvhxyAV8L', 'dpl_2mBqX6zdatTKhCSa6vSh1heALaEg', 'dpl_3REJLnPog8CxQQV5SVRmRrAxTYQH',
            'dpl_F7kp9bW93eTt5AcLYxWjgUVxnr1s', 'dpl_AFo22PdoQyJEB8jbcYdje6mgAYA8', 'dpl_Gaw2tR7o7hNwmpbTRAgz8KL2zaKF',
            'dpl_9v4TzUp1CSfjBmVDjo85t29xirtc', 'dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR'}


def deployment(uid, created, state, target, branch, repository):
    org, repo = repository.split('/')
    return {'uid': uid, 'url': uid[4:12].lower() + '.vercel.app', 'created': created, 'state': state, 'target': target,
            'meta': {'githubCommitRef': branch, 'githubOrg': org, 'githubRepo': repo, 'githubCommitSha': '0123456789'}}


def inventory():
    return [deployment(*row) for row in INVENTORY]


def aliases():
    return {row[0]: ['alias.vercel.app'] if row[0] in ALIASED else [] for row in INVENTORY}


def branches():
    """GitHub state at the snapshot: every branch had a PR except the concurrent E2E build's branch (no PR yet)."""
    return {row[4]: {'open_pr': row[4] in OPEN_PULL_REQUESTS, 'had_pr': row[4] != 'claude/festive-keller-om54li', 'last_commit': None}
            for row in INVENTORY}


def known(*names, open_pr=False, had_pr=True, last_commit=None):
    return {name: {'open_pr': open_pr, 'had_pr': had_pr, 'last_commit': last_commit} for name in names}


DAY = 24 * 3600 * 1000
OLD = int(SNAPSHOT.timestamp() * 1000) - 10 * DAY


class FakeVercel:
    def __init__(self, deployments, alias_map):
        self.items, self.alias_map, self.deleted = {d['uid']: d for d in deployments}, alias_map, []

    def deployments(self):
        return list(self.items.values())

    def aliases(self, deployment_id):
        return self.alias_map.get(deployment_id, [])

    def deployment(self, deployment_id):
        d = self.items[deployment_id]
        return {'id': deployment_id, 'projectId': cleanup.PROJECT_ID, 'target': d['target'], 'readyState': d['state'], 'createdAt': d['created']}

    def delete(self, deployment_id):
        self.deleted.append(deployment_id)
        return {'state': 'DELETED', 'uid': deployment_id}


class Plan(unittest.TestCase):
    def test_real_inventory_plan_matches_the_verified_manifest(self):
        removable, preserved = cleanup.classify(inventory(), aliases(), branches(), SNAPSHOT)
        self.assertEqual({entry['id'] for entry in removable}, EXPECTED)
        self.assertEqual(len(removable) + len(preserved), len(INVENTORY))
        kinds = sorted(entry['kind'] for entry in removable)
        self.assertEqual(kinds, ['canceled', 'errored'] + ['superseded preview'] * 12)
        reasons = {entry['id']: entry['reasons'] for entry in preserved}
        # Every production deployment, the custom domains' target and the concurrent build stay.
        for uid, created, state, target, *_ in INVENTORY:
            if target == 'production':
                self.assertIn('production', reasons[uid])
        self.assertTrue(any(r.startswith('aliased') for r in reasons['dpl_2bE13XzzVncdzytxNbS2MyWbQE3p']))
        self.assertIn('state BUILDING', reasons['dpl_FH7MAHa6zegQGrsyx1FHWSNHPqsM'])
        # Open pull requests keep every deployment; recent ones wait for the 24-hour window.
        self.assertIn('branch has an open pull request', reasons['dpl_FTwa1iWaXy6Y75nr71HrofaeDozu'])
        self.assertIn('created in the last 24 hours', reasons['dpl_3oQ4iscJSnj2Qo9d65f8NnZRbTVd'])
        # The only, unaliased READY deployment of a merged branch is still its newest READY one: kept.
        self.assertEqual(reasons['dpl_2D2eqyaFQh8m4fLVmzZWFUZ1aCab'], ['newest READY deployment of its branch'])

    def test_a_day_later_superseded_previews_of_merged_branches_become_removable(self):
        later = datetime(2026, 11, 3, 3, 0, tzinfo=timezone.utc)
        removable, preserved = cleanup.classify(inventory(), aliases(), branches(), later)
        ids = {entry['id'] for entry in removable}
        self.assertEqual(len(ids), 39)
        self.assertTrue(EXPECTED < ids)
        self.assertIn('dpl_HS8Nb756NgjY5R7niJVTw4i6X9T7', ids)  # PR #151, superseded by 91bbb85
        self.assertNotIn('dpl_6vL9d2Qkujv8hH9eLr2S6DTr841D', ids)  # its latest, branch alias
        self.assertFalse(any(entry['target'] == 'production' for entry in removable))
        self.assertFalse(ids & ALIASED)

    def test_active_branch_keeps_its_latest_two_and_a_recent_commit_counts_as_activity(self):
        items = [deployment(f'dpl_{i}', OLD + i * 1000, 'READY', None, 'feature', 'FloFi-xyz/FloFi') for i in range(4)]
        removable, _ = cleanup.classify(items, {}, known('feature'), SNAPSHOT)
        self.assertEqual({e['id'] for e in removable}, {'dpl_0', 'dpl_1', 'dpl_2'})  # inactive: only the newest READY stays
        removable, _ = cleanup.classify(items, {}, known('feature', last_commit=SNAPSHOT), SNAPSHOT)
        self.assertEqual({e['id'] for e in removable}, {'dpl_0', 'dpl_1'})
        removable, _ = cleanup.classify(items, {}, known('feature', open_pr=True), SNAPSHOT)
        self.assertEqual(removable, [])

    def test_newest_ready_survives_newer_failed_or_stuck_builds(self):
        """Review finding: a newer ERROR, CANCELED or long-stuck BUILDING deployment must not expose the branch's working preview."""
        for later_state in ('ERROR', 'CANCELED', 'BUILDING'):
            with self.subTest(later_state=later_state):
                items = [deployment('dpl_ready', OLD, 'READY', None, 'feature', 'FloFi-xyz/FloFi'),
                         deployment('dpl_later', OLD + 1000, later_state, None, 'feature', 'FloFi-xyz/FloFi')]
                removable, preserved = cleanup.classify(items, {}, known('feature'), SNAPSHOT)
                self.assertNotIn('dpl_ready', {e['id'] for e in removable})
                self.assertIn('newest READY deployment of its branch', {e['id']: e['reasons'] for e in preserved}['dpl_ready'])

    def test_branch_without_pull_request_history_is_kept_whole(self):
        """Review finding: an idle branch nobody opened a PR for has an uncertain status, so none of its deployments go."""
        items = [deployment(f'dpl_{i}', OLD + i * 1000, 'READY', None, 'spike', 'FloFi-xyz/FloFi') for i in range(3)]
        removable, preserved = cleanup.classify(items, {}, known('spike', had_pr=False), SNAPSHOT)
        self.assertEqual(removable, [])
        self.assertIn('branch has no pull request history', {e['id']: e['reasons'] for e in preserved}['dpl_0'])

    def test_uncertain_ownership_is_preserved(self):
        items = [deployment('dpl_new', OLD + 1, 'READY', None, 'x', 'FloFi-xyz/FloFi'),
                 deployment('dpl_other', OLD, 'READY', None, 'x', 'someone/else'),
                 deployment('dpl_custom', OLD, 'READY', 'staging', 'x', 'FloFi-xyz/FloFi'),
                 deployment('dpl_rollback', OLD, 'READY', None, 'x', 'FloFi-xyz/FloFi') | {'isRollbackCandidate': True},
                 deployment('dpl_queued', OLD, 'QUEUED', None, 'x', 'FloFi-xyz/FloFi'),
                 deployment('dpl_unknown_branch', OLD, 'ERROR', None, 'never-looked-up', 'FloFi-xyz/FloFi')]
        items.append({**deployment('dpl_nobranch', OLD, 'ERROR', None, 'x', 'FloFi-xyz/FloFi'), 'meta': {}})
        items.append({**deployment('dpl_retained', OLD, 'READY', None, 'x', 'FloFi-xyz/FloFi'), 'softDeletedByRetention': True})
        removable, preserved = cleanup.classify(items, {}, known('x'), SNAPSHOT)
        self.assertEqual(removable, [])
        reasons = {e['id']: ' '.join(e['reasons']) for e in preserved}
        self.assertIn('unknown repository', reasons['dpl_other'])
        self.assertIn('custom environment', reasons['dpl_custom'])
        self.assertIn('rollback candidate', reasons['dpl_rollback'])
        self.assertIn('state QUEUED', reasons['dpl_queued'])
        self.assertIn('unknown repository or branch', reasons['dpl_nobranch'])
        self.assertIn('already deleted', reasons['dpl_retained'])
        self.assertIn('branch state unknown', reasons['dpl_unknown_branch'])


class Apply(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.plan_path = str(Path(directory.name) / 'plan.json')
        self.report_path = str(Path(directory.name) / 'report.json')

    def run_main(self, vercel, *argv, open_pr_now=()):
        out = io.StringIO()
        with mock.patch.object(cleanup, 'github_state', return_value=branches()), \
             mock.patch.object(cleanup, 'branch_state', side_effect=lambda b: {'open_pr': b in open_pr_now, 'had_pr': True, 'last_commit': None}), \
             mock.patch.object(cleanup, 'datetime', wraps=datetime) as clock, redirect_stdout(out):
            clock.now.return_value = SNAPSHOT
            code = cleanup.main(list(argv), vercel=vercel)
        return code, out.getvalue()

    def reviewed_plan(self, drop=()):
        self.run_main(FakeVercel(inventory(), aliases()), '--report', self.plan_path)
        document = json.loads(Path(self.plan_path).read_text())
        document['removable'] = [e for e in document['removable'] if e['id'] not in drop]
        Path(self.plan_path).write_text(json.dumps(document))

    def test_plan_only_by_default(self):
        vercel = FakeVercel(inventory(), aliases())
        code, out = self.run_main(vercel, '--report', self.plan_path)
        self.assertEqual((code, vercel.deleted), (0, []))
        self.assertIn('Plan: 14 removable, 70 preserved', out)
        self.assertEqual({e['id'] for e in json.loads(Path(self.plan_path).read_text())['removable']}, EXPECTED)

    def test_apply_deletes_only_reviewed_deployments_and_rechecks_each_one(self):
        """Review finding: a count is not a review. Only IDs in the reviewed plan file are ever deleted."""
        unreviewed = 'dpl_Gaw2tR7o7hNwmpbTRAgz8KL2zaKF'
        self.reviewed_plan(drop={unreviewed})
        vercel = FakeVercel(inventory(), aliases())
        real_aliases, calls = vercel.aliases, []

        def aliases_now(deployment_id):  # an alias appears on one candidate after the plan was made
            calls.append(deployment_id)
            if deployment_id == 'dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR' and calls.count(deployment_id) > 1:
                return ['new.vercel.app']
            return real_aliases(deployment_id)
        vercel.aliases = aliases_now
        code, out = self.run_main(vercel, '--apply', self.plan_path, '--report', self.report_path,
                                  open_pr_now={'claude/festive-darwin-du0oft'})
        self.assertEqual(code, 0)
        skipped = {'dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR', 'dpl_AFo22PdoQyJEB8jbcYdje6mgAYA8'}
        self.assertEqual(set(vercel.deleted), EXPECTED - {unreviewed} - skipped)
        self.assertIn('SKIPPED  dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR now aliased', out)
        self.assertIn('SKIPPED  dpl_AFo22PdoQyJEB8jbcYdje6mgAYA8 branch now has an open pull request', out)
        self.assertIn('Removed 11, skipped 2; 1 newly removable deployment(s) were not in the reviewed plan and were left alone', out)
        outcomes = json.loads(Path(self.report_path).read_text())['outcomes']
        self.assertEqual(sum(o['result'] == 'deleted' for o in outcomes), 11)

    def test_reviewed_deployment_no_longer_removable_is_skipped(self):
        self.reviewed_plan()
        alias_map = aliases() | {'dpl_9v4TzUp1CSfjBmVDjo85t29xirtc': ['late.vercel.app']}
        vercel = FakeVercel(inventory(), alias_map)
        _, out = self.run_main(vercel, '--apply', self.plan_path)
        self.assertNotIn('dpl_9v4TzUp1CSfjBmVDjo85t29xirtc', vercel.deleted)
        self.assertIn('Removed 13, skipped 1', out)

    def test_report_keeps_completed_deletions_when_a_run_stops(self):
        """Review finding: an API failure mid-run must not lose the record of what was already deleted."""
        self.reviewed_plan()
        vercel = FakeVercel(inventory(), aliases())
        real_delete = vercel.delete

        def delete(deployment_id):
            if len(vercel.deleted) == 3:
                raise SystemExit('Vercel DELETE: HTTP 500')
            return real_delete(deployment_id)
        vercel.delete = delete
        with self.assertRaises(SystemExit):
            self.run_main(vercel, '--apply', self.plan_path, '--report', self.report_path)
        outcomes = json.loads(Path(self.report_path).read_text())['outcomes']
        self.assertEqual([o['id'] for o in outcomes if o['result'] == 'deleted'], vercel.deleted)
        self.assertEqual(len(vercel.deleted), 3)

    def test_plan_file_must_belong_to_this_project(self):
        Path(self.plan_path).write_text(json.dumps({'project': 'prj_other', 'removable': []}))
        with self.assertRaisesRegex(SystemExit, 'is not a plan of project'):
            self.run_main(FakeVercel(inventory(), aliases()), '--apply', self.plan_path)

    def test_open_pull_requests_must_be_listed_completely(self):
        with mock.patch.object(cleanup, 'github', return_value=[{'head': {'ref': f'b{i}'}} for i in range(100)]):
            with self.assertRaisesRegex(SystemExit, 'could not be listed completely'):
                cleanup.github_state({'b1'})
        with mock.patch.object(cleanup, 'github', return_value=None):
            with self.assertRaisesRegex(SystemExit, 'could not be listed completely'):
                cleanup.github_state({'b1'})

    def test_branch_lookup_tries_both_path_spellings_and_reads_pr_history(self):
        calls = []

        def github(path):
            calls.append(path)
            if '/pulls?' in path:
                return [{'state': 'closed'}]
            return None if '%2F' not in path.split('/branches/')[1] else {'commit': {'commit': {'committer': {'date': '2026-11-02T01:00:00Z'}}}}
        with mock.patch.object(cleanup, 'github', side_effect=github):
            state = cleanup.branch_state('claude/x')
        self.assertEqual(state, {'open_pr': False, 'had_pr': True, 'last_commit': datetime(2026, 11, 2, 1, tzinfo=timezone.utc)})
        self.assertIn('head=FloFi-xyz%3Aclaude%2Fx', calls[0])
        self.assertEqual([c.split('/branches/')[1] for c in calls[1:]], ['claude/x', 'claude%2Fx'])

    def test_missing_credentials_remove_nothing(self):
        with mock.patch.dict('os.environ', {}, clear=True):
            with self.assertRaisesRegex(SystemExit, 'VERCEL_TOKEN is not set'):
                cleanup.main([])
            with mock.patch.object(cleanup.shutil, 'which', return_value=None):
                with self.assertRaisesRegex(SystemExit, 'GitHub state is required'):
                    cleanup.github('/repos/FloFi-xyz/FloFi/pulls')


class Client(unittest.TestCase):
    def pages(self, *pages):
        responses = iter(pages)

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False
        return lambda request, timeout: Response(json.dumps(next(responses)).encode())

    def test_overlapping_pages_count_each_deployment_once(self):
        """Review finding: a deployment repeated at a page boundary would shift the ranks of its branch."""
        a, b, c = ({'uid': u} for u in ('dpl_a', 'dpl_b', 'dpl_c'))
        vercel = cleanup.Vercel('token', opener=self.pages({'deployments': [a, b], 'pagination': {'next': 1}},
                                                           {'deployments': [b, c], 'pagination': {'next': None}}))
        self.assertEqual([d['uid'] for d in vercel.deployments()], ['dpl_a', 'dpl_b', 'dpl_c'])

    def test_malformed_alias_response_stops_the_run(self):
        """Review finding: a response without `aliases` must not read as 'unaliased'."""
        vercel = cleanup.Vercel('token', opener=self.pages({'error': 'something'}))
        with self.assertRaisesRegex(SystemExit, 'unexpected response'):
            vercel.aliases('dpl_a')
        self.assertEqual(cleanup.Vercel('token', opener=self.pages({'aliases': [{'alias': 'x.vercel.app'}]})).aliases('dpl_a'), ['x.vercel.app'])

    def test_redirects_are_refused_so_tokens_never_follow_them(self):
        request = urllib.request.Request('https://api.vercel.com/v7/deployments', headers={'Authorization': 'Bearer secret'})
        with self.assertRaises(urllib.error.HTTPError):
            cleanup.NoRedirect().redirect_request(request, None, 302, 'Found', {}, 'https://elsewhere.example/')


if __name__ == '__main__':
    unittest.main()
