#!/usr/bin/env python3
"""FloFi multichain engineering skills registry (BUILD-FLOFI-EXECUTION-PERFORMANCE-001).

Versioned, reviewed protocol and network knowledge for the existing 19 engineering
specialists. A skill is reference material: a FloFi-written guidance file plus a
manifest recording where the knowledge came from (official docs, SDKs or skills),
the reviewed revision/digest, its licence and which FloFi domains, paths and
registered execution capabilities it informs.

Skills never run. This module only parses JSON manifests and hashes files. It has
no transaction, wallet, signing or provider-execution code, and nothing in the
product runtime imports skills/ (a unit test enforces this). Upstream checks are
explicit (`check-upstream --fetch`), only hash bounded HTTPS responses, and write
a proposal file for normal code review; they never rewrite a manifest, execute
or render remote content, or deploy anything.

Commands:
  verify                          validate every manifest (CI runs this through agent_guard.py check)
  select [--base REF] [--paths P...] [--task TEXT] [--network N] [--protocol P] [--operation O]
                                  deterministic skill and reviewer selection for an engineering task
  digest SKILL_ID                 sha256 of a skill's guidance file (after an intentional, reviewed edit)
  check-upstream [--snapshot DIR | --fetch] [--proposal FILE] [--fail-on-change]
                                  detect changed, unpinned or stale upstream references
"""

import argparse
import datetime as dt
import fnmatch
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = "skills/registry.json"
SKILL_FORMAT = "flofi.engineering-skill.v1"
REGISTRY_FORMAT = "flofi.engineering-skill-registry.v1"
AUTHORITY = "ENGINEERING_REFERENCE_ONLY"
CATEGORIES = ("networks", "protocols", "operations")
NETWORKS = frozenset({"evm", "ethereum", "base", "arbitrum-one", "solana", "robinhood"})
PROTOCOLS = frozenset({"uniswap", "aave", "jupiter", "orca", "across", "lifi", "relay", "mayan"})
OPERATIONS = frozenset({"swap", "bridge", "liquidity", "lending", "execution", "transfer"})
SOURCE_KINDS = frozenset({"OFFICIAL_DOCS", "OFFICIAL_SDK", "OFFICIAL_SKILL", "THIRD_PARTY"})
SOURCE_STATUSES = frozenset({"VERIFIED", "PENDING_VERIFICATION", "REJECTED"})
SKILL_KEYS = frozenset({"format", "id", "title", "version", "networks", "protocols", "operations", "domains",
                        "dependsOn", "appliesTo", "capabilities", "sources", "guidance", "guidanceDigest",
                        "reviewIntervalDays", "authority", "performance"})
SOURCE_KEYS = frozenset({"url", "publisher", "kind", "license", "status", "reviewedRevision", "reviewedDigest",
                         "reviewedAt", "crossCheckedAgainst", "notes"})
CAPABILITY_KEYS = frozenset({"actionType", "adapterId", "chainId"})
SEMVER = re.compile(r"^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HOST = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")
KEYWORD = re.compile(r"^[a-z0-9][a-z0-9.+_-]{1,40}$")
# Guidance is FloFi-written review knowledge. It must never ask anyone to run piped remote scripts,
# disclose key material, or move funds; the registry is reference-only.
UNSAFE_GUIDANCE = (
    (re.compile(r"\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b", re.I), "pipes a remote download into a shell"),
    (re.compile(r"\b(enter|paste|share|send|provide)\b[^\n.]{0,40}\b(private key|seed phrase|mnemonic|secret key)", re.I),
     "asks for key material"),
    (re.compile(r"\b(sign|broadcast|submit)\b[^\n.]{0,30}\bautomatically\b", re.I), "describes automatic signing or submission"),
)
NEGATION = re.compile(r"\b(never|not|no|don't|do not|must not|refuses?)\b", re.I)


def unsafe_guidance(text):
    """Reasons a guidance text is unsafe. A match inside a negated sentence ("never paste a private key") is the rule itself, not a request."""
    reasons = []
    for pattern, reason in UNSAFE_GUIDANCE:
        for match in pattern.finditer(text):
            start = max(text.rfind(".", 0, match.start()), text.rfind("\n", 0, match.start())) + 1
            if not NEGATION.search(text[start:match.start()]):
                reasons.append(reason)
                break
    return reasons


MAX_FETCH_BYTES = 2 * 1024 * 1024
MAX_CONCURRENT_REVIEWS = 3
KIND_ORDER = {"networks": 0, "protocols": 1, "operations": 2}


def _guard():
    """agent_guard.py's domain list, without making scripts/ a package (both run as plain scripts)."""
    spec = importlib.util.spec_from_file_location("flofi_agent_guard", Path(__file__).with_name("agent_guard.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path):
    return "sha256:" + hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalized_digest(body):
    """Upstream digest: line endings and trailing whitespace are not reviewed content changes."""
    text = body.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip() for line in text.split("\n")).strip() + "\n"
    return "sha256:" + hashlib.sha256(text.encode()).hexdigest()


def load(root=ROOT):
    registry = json.loads((root / REGISTRY).read_text())
    skills = {}
    for skill_id in registry.get("skills", []) if isinstance(registry.get("skills"), list) else []:
        if isinstance(skill_id, str) and _safe_id(skill_id):
            path = root / "skills" / skill_id / "skill.json"
            skills[skill_id] = json.loads(path.read_text()) if path.is_file() and not path.is_symlink() else None
    return registry, skills


def _safe_id(skill_id):
    parts = skill_id.split("/")
    return (len(parts) == 2 and parts[0] in CATEGORIES and re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", parts[1]) is not None)


def _strings(value, allowed=None, pattern=None, allow_empty=True):
    if not isinstance(value, list) or (not allow_empty and not value) or len(set(map(str, value))) != len(value):
        return False
    return all(isinstance(item, str) and item and (allowed is None or item in allowed)
               and (pattern is None or pattern.fullmatch(item)) for item in value)


def _publisher_prefixes(registry):
    publishers = registry.get("publishers")
    if not isinstance(publishers, dict):
        return {}
    return {name: list(entry.get("urlPrefixes", [])) for name, entry in publishers.items()
            if isinstance(entry, dict) and set(entry) == {"urlPrefixes"} and isinstance(entry.get("urlPrefixes"), list)}


def _prefix_valid(prefix):
    """An official location is an exact https origin plus a path ending in '/' (e.g. one GitHub organisation)."""
    parsed = urllib.parse.urlsplit(prefix) if isinstance(prefix, str) else None
    return bool(parsed and parsed.scheme == "https" and parsed.hostname and HOST.fullmatch(parsed.hostname)
                and parsed.netloc == parsed.hostname and parsed.path.endswith("/") and not parsed.query and not parsed.fragment
                and ".." not in parsed.path.split("/"))


def _official(url, prefixes):
    return any(url.startswith(prefix) for prefix in prefixes)


def validate(root=ROOT, domains=None, today=None):
    """Structural, provenance and integrity errors. Pending or stale sources are warnings (see `warnings`)."""
    domains = set(domains if domains is not None else _guard().DOMAINS)
    errors = []
    try:
        registry, skills = load(root)
    except (OSError, ValueError) as exc:
        return [f"{REGISTRY}: unreadable ({exc})"]
    if registry.get("format") != REGISTRY_FORMAT or not SEMVER.fullmatch(str(registry.get("version", ""))):
        errors.append(f"{REGISTRY}: unsupported format or version")
    if set(registry) != {"format", "version", "publishers", "skills"}:
        errors.append(f"{REGISTRY}: unexpected or missing keys")
    listed = registry.get("skills", [])
    if not _strings(listed, allow_empty=False) or any(not _safe_id(s) for s in listed):
        errors.append(f"{REGISTRY}: skills must be unique category/name identifiers")
    hosts = _publisher_prefixes(registry)
    if not hosts or len(hosts) != len(registry.get("publishers", {})) \
            or any(not entry or any(not _prefix_valid(p) for p in entry) for entry in hosts.values()):
        errors.append(f"{REGISTRY}: publishers must list official https URL prefixes ending in '/'")
    on_disk = sorted(str(PurePosixPath(p.relative_to(root / "skills").parent))
                     for p in (root / "skills").glob("*/*/skill.json"))
    for orphan in sorted(set(on_disk) - set(listed if isinstance(listed, list) else [])):
        errors.append(f"skills/{orphan}/skill.json: not listed in {REGISTRY}")
    for skill_id, skill in skills.items():
        errors.extend(_validate_skill(root, skill_id, skill, skills, hosts, domains))
    errors.extend(_cycles(skills))
    return errors


def _validate_skill(root, skill_id, skill, skills, hosts, domains):
    where = f"skills/{skill_id}/skill.json"
    if not isinstance(skill, dict):
        return [f"{where}: missing or unreadable manifest"]
    errors = []
    if set(skill) != SKILL_KEYS:
        errors.append(f"{where}: keys must be exactly {sorted(SKILL_KEYS)}")
    if skill.get("format") != SKILL_FORMAT or skill.get("id") != skill_id:
        errors.append(f"{where}: format or id mismatch")
    if skill.get("authority") != AUTHORITY:
        errors.append(f"{where}: authority must be {AUTHORITY} (skills never sign, submit or decide routes)")
    if not isinstance(skill.get("title"), str) or not 3 <= len(skill["title"]) <= 100:
        errors.append(f"{where}: invalid title")
    if not SEMVER.fullmatch(str(skill.get("version", ""))):
        errors.append(f"{where}: version must be MAJOR.MINOR.PATCH")
    if not _strings(skill.get("networks"), NETWORKS) or not _strings(skill.get("protocols"), PROTOCOLS) \
            or not _strings(skill.get("operations"), OPERATIONS):
        errors.append(f"{where}: networks/protocols/operations outside the closed vocabulary")
    category = skill_id.split("/")[0]
    if category == "protocols" and not skill.get("protocols") or category == "operations" and not skill.get("operations") \
            or category == "networks" and not skill.get("networks"):
        errors.append(f"{where}: a {category} skill must name its {category}")
    if not _strings(skill.get("domains"), domains, allow_empty=False):
        errors.append(f"{where}: domains must be existing FloFi specialists")
    if not _strings(skill.get("dependsOn")) or any(d not in skills or d == skill_id for d in skill.get("dependsOn", [])):
        errors.append(f"{where}: dependsOn must name other registered skills")
    applies = skill.get("appliesTo")
    if not isinstance(applies, dict) or set(applies) != {"paths", "keywords"} or not _strings(applies.get("paths")) \
            or not _strings(applies.get("keywords"), pattern=KEYWORD) \
            or any(p.startswith("/") or ".." in p.split("/") for p in applies.get("paths", [])):
        errors.append(f"{where}: appliesTo needs relative path globs and lowercase keywords")
    capabilities = skill.get("capabilities")
    if not isinstance(capabilities, list) or any(not isinstance(c, dict) or set(c) != CAPABILITY_KEYS
                                                 or not all(isinstance(c[k], str) and c[k] for k in CAPABILITY_KEYS)
                                                 for c in capabilities):
        errors.append(f"{where}: capabilities must be registry tuples (actionType, adapterId, chainId)")
    interval = skill.get("reviewIntervalDays")
    if not isinstance(interval, int) or isinstance(interval, bool) or not 7 <= interval <= 365:
        errors.append(f"{where}: reviewIntervalDays must be 7..365")
    performance = skill.get("performance")
    if not isinstance(performance, list) or any(not isinstance(p, str) or not 10 <= len(p) <= 240 for p in performance):
        errors.append(f"{where}: performance notes must be short strings")
    errors.extend(_validate_guidance(root, skill_id, skill, where))
    sources = skill.get("sources")
    if not isinstance(sources, list) or not sources:
        return errors + [f"{where}: at least one source is required"]
    urls = [s.get("url") for s in sources if isinstance(s, dict)]
    if len(set(urls)) != len(urls):
        errors.append(f"{where}: duplicate source URL")
    verified_official = {s.get("url") for s in sources if isinstance(s, dict) and s.get("status") == "VERIFIED"
                         and s.get("kind") != "THIRD_PARTY"}
    if not any(isinstance(s, dict) and s.get("kind") != "THIRD_PARTY" and s.get("status") != "REJECTED" for s in sources):
        errors.append(f"{where}: needs at least one official, non-rejected source")
    for index, source in enumerate(sources):
        errors.extend(_validate_source(f"{where} source[{index}]", source, hosts, verified_official))
    return errors


def _validate_guidance(root, skill_id, skill, where):
    guidance = skill.get("guidance")
    if guidance != "SKILL.md":
        return [f"{where}: guidance must be the skill's own SKILL.md"]
    path = root / "skills" / skill_id / guidance
    if not path.is_file() or path.is_symlink():
        return [f"{where}: guidance file missing"]
    errors = []
    if not DIGEST.fullmatch(str(skill.get("guidanceDigest", ""))) or skill.get("guidanceDigest") != sha256_file(path):
        errors.append(f"{where}: guidanceDigest does not match SKILL.md "
                      f"(review the edit, then record `python3 scripts/skill_registry.py digest {skill_id}`)")
    text = path.read_text(encoding="utf-8")
    for reason in unsafe_guidance(text):
        errors.append(f"skills/{skill_id}/SKILL.md: guidance {reason}")
    if len(text.encode()) > 32_768:
        errors.append(f"skills/{skill_id}/SKILL.md: guidance exceeds 32 KiB")
    return errors


def _validate_source(where, source, hosts, verified_official):
    if not isinstance(source, dict) or set(source) != SOURCE_KEYS:
        return [f"{where}: keys must be exactly {sorted(SOURCE_KEYS)}"]
    errors = []
    url = source.get("url")
    parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
    if not parsed or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password \
            or parsed.port or parsed.query or parsed.fragment:
        return errors + [f"{where}: url must be a plain https URL without credentials, port, query or fragment"]
    kind, status, publisher = source.get("kind"), source.get("status"), source.get("publisher")
    if kind not in SOURCE_KINDS or status not in SOURCE_STATUSES:
        errors.append(f"{where}: unknown kind or status")
    if kind != "THIRD_PARTY":
        if publisher not in hosts or not _official(url, hosts[publisher]):
            errors.append(f"{where}: {url} is not under an official {publisher} location in {REGISTRY}")
    elif not isinstance(publisher, str) or not publisher:
        errors.append(f"{where}: third-party sources must name their publisher")
    if source.get("license") is not None and not (isinstance(source["license"], str) and 2 <= len(source["license"]) <= 80):
        errors.append(f"{where}: license must be null (not yet determined) or an SPDX-style name")
    reviewed = [source.get("reviewedRevision"), source.get("reviewedDigest"), source.get("reviewedAt")]
    if status == "VERIFIED":
        if not DIGEST.fullmatch(str(reviewed[1])) or not DATE.fullmatch(str(reviewed[2])):
            errors.append(f"{where}: VERIFIED needs reviewedDigest (sha256:...) and reviewedAt (YYYY-MM-DD)")
        if source.get("license") is None:
            errors.append(f"{where}: VERIFIED needs a recorded licence")
    elif (reviewed[1] is None) != (reviewed[2] is None) or reviewed[1] is not None and (
            not DIGEST.fullmatch(str(reviewed[1])) or not DATE.fullmatch(str(reviewed[2]))):
        errors.append(f"{where}: a pinned digest needs both reviewedDigest (sha256:...) and reviewedAt (YYYY-MM-DD)")
    if status == "REJECTED" and reviewed[1] is not None:
        errors.append(f"{where}: a REJECTED source is not pinned")
    if reviewed[0] is not None and not (isinstance(reviewed[0], str) and 1 <= len(reviewed[0]) <= 120):
        errors.append(f"{where}: reviewedRevision must be null or a short revision label")
    cross = source.get("crossCheckedAgainst")
    if not _strings(cross):
        errors.append(f"{where}: crossCheckedAgainst must be a list of URLs")
    elif kind == "THIRD_PARTY" and status == "VERIFIED" and (not cross or set(cross) - verified_official):
        errors.append(f"{where}: a third-party source is VERIFIED only after a cross-check against VERIFIED official sources")
    if not isinstance(source.get("notes"), str) or len(source["notes"]) > 400:
        errors.append(f"{where}: notes must be a string of at most 400 characters")
    return errors


def _cycles(skills):
    state, errors = {}, []

    def visit(node, trail):
        if state.get(node) == 1:
            errors.append("skills dependency cycle: " + " -> ".join(trail + [node]))
            return
        if state.get(node) == 2 or not isinstance(skills.get(node), dict):
            return
        state[node] = 1
        for dep in skills[node].get("dependsOn", []) if isinstance(skills[node].get("dependsOn"), list) else []:
            if dep in skills:
                visit(dep, trail + [node])
        state[node] = 2

    for skill_id in sorted(skills):
        visit(skill_id, [])
    return errors


def warnings(root=ROOT, today=None):
    """Sources not yet verified, rejected references kept for the record, and reviews past their interval."""
    today = today or dt.date.today()
    _, skills = load(root)
    notes = []
    for skill_id, skill in sorted(skills.items()):
        if not isinstance(skill, dict):
            continue
        for source in skill.get("sources", []):
            if not isinstance(source, dict):
                continue
            status, url = source.get("status"), source.get("url")
            if status == "PENDING_VERIFICATION" and source.get("reviewedDigest"):
                notes.append(f"{skill_id}: {url} is pinned (upstream changes are detected) but PENDING_VERIFICATION: {source.get('notes', '')[:120]}")
            elif status == "PENDING_VERIFICATION":
                notes.append(f"{skill_id}: {url} is PENDING_VERIFICATION (reference only until reviewed and pinned)")
            elif status == "REJECTED":
                notes.append(f"{skill_id}: {url} is REJECTED and never selected as guidance")
            elif status == "VERIFIED" and DATE.fullmatch(str(source.get("reviewedAt"))):
                age = (today - dt.date.fromisoformat(source["reviewedAt"])).days
                if age > skill.get("reviewIntervalDays", 90):
                    notes.append(f"{skill_id}: {url} review is {age} days old (interval {skill['reviewIntervalDays']})")
    return notes


# --- Selection -------------------------------------------------------------------------------------------------

def _tokens(text):
    # Sentence punctuation is not part of a keyword ("…via Uniswap." names `uniswap`).
    return {token.rstrip(".+_-") for token in re.findall(r"[a-z0-9][a-z0-9.+_-]*", text.lower())} - {""}


def select(root=ROOT, paths=(), task="", networks=(), protocols=(), operations=(), domains_filter=None):
    """Deterministic, repository-aware selection: path globs, task keywords and explicit facets, plus dependencies.

    The result names guidance files the read-only specialists may Read and the existing specialists to ask,
    batched to the repository's three-subagent limit. It is advisory review selection, never authority.
    """
    _, skills = load(root)
    valid = {k: v for k, v in skills.items() if isinstance(v, dict)}
    words = _tokens(task)
    reasons = {}

    def mark(skill_id, reason):
        reasons.setdefault(skill_id, set()).add(reason)

    for skill_id, skill in valid.items():
        applies = skill.get("appliesTo", {})
        for path in paths:
            if any(fnmatch.fnmatchcase(path, pattern) for pattern in applies.get("paths", [])):
                mark(skill_id, f"path {path}")
        for keyword in applies.get("keywords", []):
            if keyword in words:
                mark(skill_id, f"task keyword '{keyword}'")
        for facet, wanted in (("networks", networks), ("protocols", protocols), ("operations", operations)):
            for value in wanted:
                if value in skill.get(facet, []) and skill_id.startswith(facet + "/"):
                    mark(skill_id, f"{facet[:-1]} {value}")
    direct = set(reasons)
    queue = sorted(direct)
    while queue:
        current = queue.pop(0)
        for dep in valid.get(current, {}).get("dependsOn", []):
            if dep in valid:
                if dep not in reasons:
                    queue.append(dep)
                mark(dep, f"dependency of {current}")
    chosen = sorted(reasons, key=lambda s: (KIND_ORDER[s.split("/")[0]], s))
    if domains_filter is not None:
        chosen = [s for s in chosen if set(valid[s]["domains"]) & set(domains_filter)]
    reviewers = sorted({d for s in chosen if s in direct for d in valid[s]["domains"]})
    rows = []
    for skill_id in chosen:
        skill = valid[skill_id]
        sources = [{"url": s["url"], "kind": s["kind"], "status": s["status"]} for s in skill["sources"]
                   if s.get("status") != "REJECTED"]
        rows.append({"id": skill_id, "title": skill["title"], "version": skill["version"],
                     "guidance": f"skills/{skill_id}/SKILL.md", "domains": skill["domains"],
                     "capabilities": skill["capabilities"], "sources": sources,
                     "verified": bool(sources) and all(s["status"] == "VERIFIED" for s in sources),
                     "reasons": sorted(reasons[skill_id])})
    return {"skills": rows, "reviewers": reviewers,
            "reviewBatches": [reviewers[i:i + MAX_CONCURRENT_REVIEWS] for i in range(0, len(reviewers), MAX_CONCURRENT_REVIEWS)],
            "maxConcurrentSubagents": MAX_CONCURRENT_REVIEWS,
            "note": "Reference knowledge for read-only review. Unverified sources are leads to check, never authority; "
                    "deterministic tests, the capability registry and the runtime remain the evidence."}


# --- Upstream change detection ------------------------------------------------------------------------------

class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if new.scheme != "https" or new.hostname != old.hostname:
            raise urllib.error.HTTPError(newurl, code, "cross-host or non-HTTPS redirect refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_digest(url, timeout=15):
    """Hash one bounded HTTPS response. The body is never parsed, rendered or executed."""
    if urllib.parse.urlsplit(url).scheme != "https":
        raise ValueError("HTTPS only")
    opener = urllib.request.build_opener(_SameHostRedirect)
    request = urllib.request.Request(url, headers={"User-Agent": "FloFi-skill-registry/1", "Accept": "text/markdown, text/html, */*"})
    with opener.open(request, timeout=timeout) as response:
        body = response.read(MAX_FETCH_BYTES + 1)
    if len(body) > MAX_FETCH_BYTES:
        raise ValueError("response exceeds 2 MiB")
    return normalized_digest(body)


def snapshot_name(url):
    return hashlib.sha256(url.encode()).hexdigest()[:32] + ".txt"


def check_upstream(root=ROOT, snapshot=None, fetch=None, today=None):
    """Per source: UNCHANGED, CHANGED (needs review), UNPINNED (never verified), UNREACHABLE, NOT_CHECKED or STALE."""
    today = today or dt.date.today()
    _, skills = load(root)
    rows = []
    for skill_id, skill in sorted(skills.items()):
        if not isinstance(skill, dict):
            continue
        for source in skill.get("sources", []):
            if not isinstance(source, dict) or source.get("status") == "REJECTED":
                continue
            url, pinned = source.get("url"), source.get("reviewedDigest")
            observed, state = None, "NOT_CHECKED"
            try:
                if snapshot is not None:
                    path = Path(snapshot) / snapshot_name(url)
                    observed = normalized_digest(path.read_bytes()) if path.is_file() else None
                elif fetch is not None:
                    observed = fetch(url)
            except (OSError, ValueError, urllib.error.URLError) as exc:
                state = "UNREACHABLE: " + type(exc).__name__
            if observed is not None:
                state = "UNPINNED" if not pinned else "UNCHANGED" if observed == pinned else "CHANGED"
            elif not state.startswith("UNREACHABLE") and not pinned:
                state = "UNPINNED"
            if state == "UNCHANGED" and DATE.fullmatch(str(source.get("reviewedAt"))):
                if (today - dt.date.fromisoformat(source["reviewedAt"])).days > skill.get("reviewIntervalDays", 90):
                    state = "STALE"
            rows.append({"skill": skill_id, "url": url, "status": source.get("status"), "pinned": pinned,
                         "observed": observed, "state": state})
    return rows


def proposal(rows, today=None):
    """A review proposal for humans; applying it is an ordinary, reviewed manifest edit."""
    today = (today or dt.date.today()).isoformat()
    return {"format": "flofi.engineering-skill-update-proposal.v1", "generatedAt": today,
            "instructions": "Read each upstream change yourself, update SKILL.md only with verified facts, then record "
                            "reviewedDigest/reviewedAt/reviewedRevision in skill.json and open a pull request. "
                            "Never copy executable instructions or apply this file automatically.",
            "changes": [row for row in rows if row["state"] in {"CHANGED", "UNPINNED", "STALE"} and row["observed"]]}


def changed_paths(base, root=ROOT):
    merge_base = subprocess.check_output(["git", "merge-base", "HEAD", base], cwd=root, text=True).strip()
    changed = subprocess.check_output(["git", "diff", "--name-only", "-z", merge_base], cwd=root).decode().split("\0")
    changed += subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root).decode().split("\0")
    return sorted(set(filter(None, changed)))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["verify", "select", "digest", "check-upstream"])
    parser.add_argument("skill", nargs="?", help="digest: skill identifier, e.g. protocols/jupiter")
    parser.add_argument("--base", help="select: compare HEAD and the worktree against this ref (no fetch)")
    parser.add_argument("--paths", nargs="*", default=[], help="select: repository paths the task touches")
    parser.add_argument("--task", default="", help="select: free-text engineering task (matched against keywords only)")
    parser.add_argument("--network", action="append", default=[], choices=sorted(NETWORKS))
    parser.add_argument("--protocol", action="append", default=[], choices=sorted(PROTOCOLS))
    parser.add_argument("--operation", action="append", default=[], choices=sorted(OPERATIONS))
    parser.add_argument("--domain", action="append", help="select: only skills informing these specialists")
    parser.add_argument("--snapshot", help="check-upstream: directory of previously fetched sources (offline)")
    parser.add_argument("--fetch", action="store_true", help="check-upstream: fetch each source over HTTPS (explicit network use)")
    parser.add_argument("--proposal", help="check-upstream: write a review proposal JSON to this file")
    parser.add_argument("--fail-on-change", action="store_true", help="check-upstream: exit 1 when a pinned source changed")
    args = parser.parse_args(argv)
    if args.command == "verify":
        errors = validate()
        for note in warnings():
            print("warning: " + note)
        if errors:
            print("\n".join(errors), file=sys.stderr)
            return 1
        _, skills = load()
        print(f"Skills registry: PASS ({len(skills)} skills; reference-only engineering knowledge, not authority)")
        return 0
    if args.command == "digest":
        if not args.skill or not _safe_id(args.skill):
            parser.error("digest needs a skill identifier such as protocols/jupiter")
        print(sha256_file(ROOT / "skills" / args.skill / "SKILL.md"))
        return 0
    if args.command == "select":
        paths = list(args.paths) + (changed_paths(args.base) if args.base else [])
        print(json.dumps(select(paths=sorted(set(paths)), task=args.task, networks=args.network, protocols=args.protocol,
                                operations=args.operation, domains_filter=args.domain), indent=2))
        return 0
    if args.snapshot and args.fetch:
        parser.error("choose --snapshot or --fetch")
    rows = check_upstream(snapshot=args.snapshot, fetch=fetch_digest if args.fetch else None)
    print(json.dumps(rows, indent=2))
    if args.proposal:
        Path(args.proposal).write_text(json.dumps(proposal(rows), indent=2) + "\n")
    return int(args.fail_on_change and any(row["state"] == "CHANGED" for row in rows))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as exc:
        print(f"Skills registry failed: {exc}", file=sys.stderr)
        sys.exit(1)
