# SPDX-License-Identifier: AGPL-3.0-only
"""BUILD-FLOFI-VERCEL-STORAGE-001: the owner-run deployment cleanup plans exactly what the protection rules allow."""

from datetime import datetime, timezone
import importlib.util
import io
from contextlib import redirect_stderr, redirect_stdout
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
        removable, preserved = cleanup.classify(inventory(), aliases(), OPEN_PULL_REQUESTS, {}, SNAPSHOT)
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
        # The only, unaliased READY deployment of a merged branch is still its latest: kept.
        self.assertEqual(reasons['dpl_2D2eqyaFQh8m4fLVmzZWFUZ1aCab'], ['latest of its branch'])

    def test_a_day_later_superseded_previews_of_merged_branches_become_removable(self):
        later = datetime(2026, 11, 3, 3, 0, tzinfo=timezone.utc)
        removable, preserved = cleanup.classify(inventory(), aliases(), OPEN_PULL_REQUESTS, {}, later)
        ids = {entry['id'] for entry in removable}
        self.assertTrue(EXPECTED < ids)
        self.assertIn('dpl_HS8Nb756NgjY5R7niJVTw4i6X9T7', ids)  # PR #151, superseded by 91bbb85
        self.assertNotIn('dpl_6vL9d2Qkujv8hH9eLr2S6DTr841D', ids)  # its latest, branch alias
        self.assertFalse(any(entry['target'] == 'production' for entry in removable))
        self.assertFalse(ids & ALIASED)

    def test_active_branch_keeps_its_latest_two_and_a_recent_commit_counts_as_activity(self):
        day = 24 * 3600 * 1000
        base = int(SNAPSHOT.timestamp() * 1000) - 10 * day
        items = [deployment(f'dpl_{i}', base + i * 1000, 'READY', None, 'feature', 'FloFi-xyz/FloFi') for i in range(4)]
        removable, _ = cleanup.classify(items, {}, set(), {}, SNAPSHOT)
        self.assertEqual({e['id'] for e in removable}, {'dpl_0', 'dpl_1', 'dpl_2'})  # inactive: only the latest stays
        removable, _ = cleanup.classify(items, {}, set(), {'feature': SNAPSHOT}, SNAPSHOT)
        self.assertEqual({e['id'] for e in removable}, {'dpl_0', 'dpl_1'})
        removable, _ = cleanup.classify(items, {}, {'feature'}, {}, SNAPSHOT)
        self.assertEqual(removable, [])

    def test_uncertain_ownership_is_preserved(self):
        old = int(SNAPSHOT.timestamp() * 1000) - 5 * 24 * 3600 * 1000
        items = [deployment('dpl_new', old + 1, 'READY', None, 'x', 'FloFi-xyz/FloFi'),
                 deployment('dpl_other', old, 'READY', None, 'x', 'someone/else'),
                 deployment('dpl_custom', old, 'READY', 'staging', 'x', 'FloFi-xyz/FloFi'),
                 deployment('dpl_rollback', old, 'READY', None, 'x', 'FloFi-xyz/FloFi') | {'isRollbackCandidate': True},
                 deployment('dpl_queued', old, 'QUEUED', None, 'x', 'FloFi-xyz/FloFi')]
        items.append({**deployment('dpl_nobranch', old, 'ERROR', None, 'x', 'FloFi-xyz/FloFi'), 'meta': {}})
        items.append({**deployment('dpl_retained', old, 'READY', None, 'x', 'FloFi-xyz/FloFi'), 'softDeletedByRetention': True})
        removable, preserved = cleanup.classify(items, {}, set(), {}, SNAPSHOT)
        self.assertEqual(removable, [])
        reasons = {e['id']: ' '.join(e['reasons']) for e in preserved}
        self.assertIn('unknown repository', reasons['dpl_other'])
        self.assertIn('custom environment', reasons['dpl_custom'])
        self.assertIn('rollback candidate', reasons['dpl_rollback'])
        self.assertIn('state QUEUED', reasons['dpl_queued'])
        self.assertIn('unknown repository or branch', reasons['dpl_nobranch'])
        self.assertIn('already deleted', reasons['dpl_retained'])


class Apply(unittest.TestCase):
    def run_main(self, vercel, *argv):
        out = io.StringIO()
        with mock.patch.object(cleanup, 'github_state', return_value=(OPEN_PULL_REQUESTS, {})), \
             mock.patch.object(cleanup, 'datetime', wraps=datetime) as clock, redirect_stdout(out):
            clock.now.return_value = SNAPSHOT
            code = cleanup.main(list(argv), vercel=vercel)
        return code, out.getvalue()

    def test_plan_only_by_default(self):
        vercel = FakeVercel(inventory(), aliases())
        code, out = self.run_main(vercel)
        self.assertEqual((code, vercel.deleted), (0, []))
        self.assertIn('Plan: 14 removable, 70 preserved', out)

    def test_apply_requires_the_reviewed_count(self):
        vercel = FakeVercel(inventory(), aliases())
        with self.assertRaises(SystemExit), redirect_stderr(io.StringIO()):
            self.run_main(vercel, '--apply')
        with self.assertRaisesRegex(SystemExit, 'does not match the 14 removable'):
            self.run_main(vercel, '--apply', '--expect', '13')
        self.assertEqual(vercel.deleted, [])

    def test_apply_deletes_exactly_the_plan_and_rechecks_each_one(self):
        alias_map = aliases()
        vercel = FakeVercel(inventory(), alias_map)
        real_aliases = vercel.aliases
        calls = []

        def aliases_now(deployment_id):  # an alias appears on one candidate after the plan was made
            calls.append(deployment_id)
            if deployment_id == 'dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR' and calls.count(deployment_id) > 1:
                return ['new.vercel.app']
            return real_aliases(deployment_id)
        vercel.aliases = aliases_now
        code, out = self.run_main(vercel, '--apply', '--expect', '14')
        self.assertEqual(code, 0)
        self.assertEqual(set(vercel.deleted), EXPECTED - {'dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR'})
        self.assertIn('SKIPPED  dpl_7NfoYcGvWAZsdGR1njeFGdM3uGZR now aliased', out)
        self.assertIn('Removed 13, skipped 1', out)

    def test_open_pull_requests_must_be_listed_completely(self):
        with mock.patch.object(cleanup, 'github', return_value=[{'head': {'ref': f'b{i}'}} for i in range(100)]):
            with self.assertRaisesRegex(SystemExit, 'could not be listed completely'):
                cleanup.github_state({'b1'})
        with mock.patch.object(cleanup, 'github', return_value=None):
            with self.assertRaisesRegex(SystemExit, 'could not be listed completely'):
                cleanup.github_state({'b1'})

    def test_missing_credentials_remove_nothing(self):
        with mock.patch.dict('os.environ', {}, clear=True):
            with self.assertRaisesRegex(SystemExit, 'VERCEL_TOKEN is not set'):
                cleanup.main([])
            with mock.patch.object(cleanup.shutil, 'which', return_value=None):
                with self.assertRaisesRegex(SystemExit, 'GitHub state is required'):
                    cleanup.github('/repos/FloFi-xyz/FloFi/pulls')


if __name__ == '__main__':
    unittest.main()
