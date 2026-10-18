#!/usr/bin/env python3
"""Export reviewed live source, without private history, data, or bundled tools.

No network requests, Git mutations, remote publication, or secret values in output.
The allowlist is intentionally conservative. A successful scan is not a guarantee
that every possible secret or third-party rights issue has been discovered.
"""

from __future__ import annotations

import argparse
import gzip
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile
import tomllib


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = "opensource/manifest.json"
PRUNED_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv",
    ".wrangler", "target", "dist", "build_dist", "artifacts", ".next",
    "credentials", "_secrets", "certs", ".keys", ".octo-tmp", "test-results", "playwright-report",
    ".agent-browser-basic", ".agent-browser-smoke",
}
PRIVATE_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx", ".pickle"}
NATIVE_MAGIC = (b"\x7fELF", b"MZ", b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe")
ASSET_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".woff", ".woff2", ".ttf", ".otf"}
SECRET_PATTERNS = {
    "private-key": rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{24,}",
    "google-api-key": rb"AIza[0-9A-Za-z_-]{35}",
    "github-token": rb"(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})",
    "aws-access-id": rb"(?:AKIA|ASIA)[A-Z0-9]{16}",
    "google-access-token": rb"ya29\.[A-Za-z0-9_.-]{20,}",
    "slack-token": rb"xox[baprs]-[A-Za-z0-9-]{20,}",
    "openai-api-key": rb"(?<![A-Za-z0-9])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}",
    "stripe-live-key": rb"[rs]k_live_[A-Za-z0-9]{20,}",
}
DOCUMENTED_EXAMPLES = {prefix + b"IOSFODNN7EXAMPLE" for prefix in (b"AKIA", b"ASIA")}
CREDENTIAL_LITERAL = re.compile(
    rb"(?im)(?:password|passwd|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token)"
    rb"[\"' ]*\s*[:=]\s*[\"']([^\"'\r\n]{20,})[\"']"
)
GENERATED_FILES = {".gitignore", "AGENTS.md", "CLAUDE.md", "SOURCE_MANIFEST.json"}
PUBLIC_AGENT_GUIDE = """# BBARIT Terminal contributor guide

Read README.md, CONTRIBUTING.md, SECURITY.md, THIRD_PARTY.md, and
THIRD_PARTY_NOTICES.md before changing this React + Tauri desktop application.

- src/ contains the React interface; src-tauri/ contains the Rust host.
- bbarit-agent/ is the embedded agent, including its required vendor/semble crate.
- agent-browser-cli/ and bundled skills/personas are part of the application.
- Do not replace the embedded agent with the separately maintained agent OSS.
- Preserve unrelated work and runtime resources; keep third-party notices intact.
- Use the public development/build scripts. Do not restore production signing,
  updater endpoints, release uploads, or copied private Git history.
- Never commit API keys, tokens, browser profiles, user projects, databases,
  generated output, signing material, logs, or local verification captures.
- The app can execute commands and control browsers. Run it only when needed
  for the requested work, using an isolated project and local test data.
- Native platform claims require verification on that platform; a web build
  does not establish installed macOS or Windows behavior.

Useful source checks:

    python3 -B -m unittest discover -s tests -p 'export_opensource_test.py' -v
    python3 -B scripts/export-opensource.py --audit
    npm run test:run
    npm run build
    npm run check:bundled-scripts

The source allowlist is opensource/manifest.json. The exporter creates fresh
source directories and archives without Git history. It does not publish.
"""

PUBLIC_IGNORE = """# Secrets and user data
_secrets/
credentials/
.env
.env.*
!.env.example
.dev.vars
*.key
*.pem
*.p12
*.pfx
*.db
*.db-*
*.sqlite*
certs/
.keys/
# Dependencies and build/test output (vendor/semble is reviewed source)
node_modules/
target/
dist/
.octo-tmp/
.agent-browser-*/
playwright-report/
test-results/
__pycache__/
.venv/
.DS_Store
artifacts/
output/
*.log
*.zip
*.exe
*.dmg
*.app/
"""


def load_policy(root: Path) -> dict:
    policy = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
    if policy.get("schema_version") != 1:
        raise ValueError("Unsupported source allowlist schema")
    return policy


def private_name(path: Path) -> bool:
    return (
        any(part in PRUNED_DIRS for part in path.parts)
        or path.name.startswith((".env", ".dev.vars"))
        or path.suffix.lower() in PRIVATE_SUFFIXES
        or path.name in {"config.ini", "firestore-backup.json"}
    )


def inclusion_reason(relative: str, policy: dict) -> str | None:
    path = Path(relative)
    if private_name(path):
        return "private-or-generated-path"
    if relative in policy["excluded_files"]:
        return "excluded-legacy-service"
    if any(relative.startswith(prefix) for prefix in policy["excluded_prefixes"]):
        return "excluded-data-or-unreviewed-third-party"
    if relative in policy["root_files"] or relative in policy["extra_files"]:
        return None
    for tree, suffixes in policy["source_trees"].items():
        if relative.startswith(tree + "/") and (path.suffix.lower() in suffixes or path.name in policy.get("allowed_names", [])):
            return None
    return "outside-reviewed-source-allowlist"


def secret_findings(relative: str, content: bytes) -> list[dict]:
    findings = []
    for rule, expression in SECRET_PATTERNS.items():
        for match in re.finditer(expression, content):
            if match.group() not in DOCUMENTED_EXAMPLES:
                findings.append({"path": relative, "line": content[:match.start()].count(b"\n") + 1, "rule": rule})
    for match in CREDENTIAL_LITERAL.finditer(content):
        literal = match.group(1)
        # References, explanatory text, and explicit examples are not credentials.
        if not re.fullmatch(rb"[A-Za-z0-9_+/.=-]+", literal):
            continue
        if re.search(rb"(?i)(example|placeholder|replace|your[_-]|test[_-]|process|environ)", literal):
            continue
        if len(set(literal)) < 12:
            continue
        if not re.search(rb"[A-Z]", literal) or not re.search(rb"[0-9+/=]", literal):
            continue
        findings.append({"path": relative, "line": content[:match.start()].count(b"\n") + 1, "rule": "credential-literal-review"})
    return findings


def inspect_file(path: Path, relative: str, policy: dict | None = None) -> list[dict]:
    content = path.read_bytes()
    if content.startswith(NATIVE_MAGIC):
        return [{"path": relative, "rule": "native-executable"}]
    if path.suffix.lower() in ASSET_SUFFIXES:
        return []
    findings = [{"path": relative, "rule": "unexpected-binary"}] if b"\0" in content else []
    findings.extend(secret_findings(relative, content))
    for exception in (policy or {}).get("secret_exceptions", []):
        if exception["path"] == relative and exception["sha256"] == hashlib.sha256(content).hexdigest():
            findings = [finding for finding in findings if finding["rule"] != exception["rule"]]
    return findings


def local_go_findings(root: Path, inventory: list[str]) -> list[dict]:
    root = root.resolve()
    findings = []
    included = set(inventory)
    for relative in inventory:
        if not relative.endswith("go.mod"):
            continue
        module_file = root / relative
        for target in re.findall(r"=>\s+(\.\.?[/\\][^\s)]+)", module_file.read_text(encoding="utf-8")):
            dependency = (module_file.parent / target / "go.mod").resolve()
            if not dependency.is_relative_to(root):
                findings.append({"path": relative, "rule": "local-go-module-outside-source"})
            elif dependency.relative_to(root).as_posix() not in included:
                findings.append({"path": relative, "rule": "local-go-module-missing-from-export"})
    return findings


def required_relative(root: Path, candidate: Path, included: set[str], source: str, rule: str) -> list[dict]:
    candidate = candidate.resolve()
    if not candidate.is_relative_to(root):
        return [{"path": source, "rule": rule + "-outside-source"}]
    relative = candidate.relative_to(root).as_posix()
    if relative not in included:
        return [{"path": source, "dependency": relative, "rule": rule + "-missing-from-export"}]
    return []


def rust_dependency_findings(root: Path, inventory: list[str]) -> list[dict]:
    findings, included = [], set(inventory)
    for relative in inventory:
        path = root / relative
        if path.name == "Cargo.toml":
            manifest = tomllib.loads(path.read_text(encoding="utf-8"))
            tables = [manifest]
            tables.extend(manifest.get("target", {}).values())
            for table in tables:
                for category in ("dependencies", "dev-dependencies", "build-dependencies"):
                    for dependency in table.get(category, {}).values():
                        if isinstance(dependency, dict) and "path" in dependency:
                            target = path.parent / dependency["path"] / "Cargo.toml"
                            findings.extend(required_relative(root, target, included, relative, "local-rust-crate"))
        if path.suffix == ".rs":
            source = path.read_text(encoding="utf-8")
            for target in re.findall(r'include_(?:str|bytes)!\(\s*"([^"\n]+)"\s*\)', source):
                findings.extend(required_relative(root, path.parent / target, included, relative, "rust-embedded-resource"))
    return findings


def application_dependency_findings(root: Path, inventory: list[str]) -> list[dict]:
    findings, included = [], set(inventory)
    config_path = root / "src-tauri/tauri.conf.json"
    if config_path.is_file():
        config = json.loads(config_path.read_text(encoding="utf-8"))
        resources = config.get("bundle", {}).get("resources", [])
        resources = list(resources) if isinstance(resources, dict) else resources
        for resource in resources:
            targets = [Path(value) for value in glob.glob(str(config_path.parent / resource), recursive=True)]
            targets = [target for target in targets if target.is_file()]
            if not targets:
                findings.append({"path": "src-tauri/tauri.conf.json", "dependency": resource, "rule": "tauri-bundle-resource-missing"})
            for target in targets:
                findings.extend(required_relative(root, target, included, "src-tauri/tauri.conf.json", "tauri-bundle-resource"))
    package_path = root / "package.json"
    if package_path.is_file():
        scripts = json.loads(package_path.read_text(encoding="utf-8")).get("scripts", {})
        for name, command in scripts.items():
            for relative in re.findall(r'(?:scripts|agent-browser-cli)/[\w./-]+\.(?:mjs|cjs|js|py|sh|ps1)', command):
                findings.extend(required_relative(root, root / relative, included, "package.json#" + name, "npm-script"))
    return findings


def dependency_findings(root: Path, inventory: list[str]) -> list[dict]:
    root = root.resolve()
    return local_go_findings(root, inventory) + rust_dependency_findings(root, inventory) + application_dependency_findings(root, inventory)


def source_inventory(root: Path, policy: dict) -> tuple[list[str], list[dict], list[dict]]:
    included, excluded, findings = [], [], []
    for directory, dirs, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        for dirname in list(dirs):
            candidate = parent / dirname
            if dirname in PRUNED_DIRS or candidate.is_symlink():
                dirs.remove(dirname)
                excluded.append({"path": candidate.relative_to(root).as_posix() + "/", "reason": "private-generated-or-symlink-directory"})
        for filename in files:
            candidate = parent / filename
            relative = candidate.relative_to(root).as_posix()
            reason = inclusion_reason(relative, policy)
            if candidate.is_symlink():
                reason = "symlink-not-exported"
            if reason:
                excluded.append({"path": relative, "reason": reason})
                continue
            issues = inspect_file(candidate, relative, policy)
            findings.extend(issues)
            included.append(relative)
    missing = sorted(set(policy["required_files"]) - set(included))
    findings.extend({"path": relative, "rule": "required-source-missing"} for relative in missing)
    findings.extend(dependency_findings(root, included))
    return sorted(included), sorted(excluded, key=lambda item: item["path"]), findings


def check_export(root: Path, policy: dict) -> dict:
    findings, inventory = [], []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            findings.append({"path": relative, "rule": "symlink-in-export"})
            continue
        if path.is_dir():
            if any(part in PRUNED_DIRS for part in path.relative_to(root).parts):
                findings.append({"path": relative, "rule": "private-directory-in-export"})
            continue
        if relative not in GENERATED_FILES:
            reason = inclusion_reason(relative, policy)
            if reason:
                findings.append({"path": relative, "rule": reason})
        if relative in {"AGENTS.md", "CLAUDE.md"} and path.read_text(encoding="utf-8") != PUBLIC_AGENT_GUIDE:
            findings.append({"path": relative, "rule": "portable-guide-mismatch"})
        findings.extend(inspect_file(path, relative, policy))
        inventory.append(relative)
    missing = sorted(set(policy["required_files"]) - set(inventory))
    findings.extend({"path": relative, "rule": "required-source-missing"} for relative in missing)
    findings.extend({"path": relative, "rule": "generated-manifest-or-guide-missing"} for relative in sorted(GENERATED_FILES - set(inventory)))
    findings.extend(dependency_findings(root, inventory))
    manifest_path = root / "SOURCE_MANIFEST.json"
    if manifest_path.is_file():
        declared = json.loads(manifest_path.read_text(encoding="utf-8"))["files"]
        actual = set(inventory) - {"SOURCE_MANIFEST.json"}
        if actual != set(declared):
            findings.append({"path": "SOURCE_MANIFEST.json", "rule": "manifest-file-set-mismatch"})
        for relative, expected in declared.items():
            candidate = root / relative
            if candidate.is_file() and hashlib.sha256(candidate.read_bytes()).hexdigest() != expected["sha256"]:
                findings.append({"path": relative, "rule": "manifest-hash-mismatch"})
    return {"ok": not findings, "file_count": len(inventory), "findings": findings}


def write_source_manifest(destination: Path, files: list[str]) -> None:
    entries = {}
    for relative in sorted(files + list(GENERATED_FILES - {"SOURCE_MANIFEST.json"})):
        content = (destination / relative).read_bytes()
        entries[relative] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
    payload = {"schema_version": 1, "history_included": False, "files": entries}
    (destination / "SOURCE_MANIFEST.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_archive(destination: Path, archive: Path) -> None:
    with archive.open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as tar:
                for path in sorted(destination.rglob("*")):
                    if not path.is_file():
                        continue
                    info = tar.gettarinfo(str(path), arcname=destination.name + "/" + path.relative_to(destination).as_posix())
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ""
                    with path.open("rb") as stream:
                        tar.addfile(info, stream)


def create_export(root: Path, output: Path, policy: dict) -> dict:
    archive, report = Path(str(output) + ".tar.gz"), Path(str(output) + ".excluded.json")
    if output == root or root.is_relative_to(output):
        raise ValueError("Export destination must not contain the source repository")
    if any(path.exists() or path.is_symlink() for path in (output, archive, report)):
        raise FileExistsError("Export destination, archive, or exclusion report already exists; choose a new path")
    files, excluded, findings = source_inventory(root, policy)
    if findings:
        return {"ok": False, "findings": findings, "included_count": len(files)}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".opensource-export-", dir=output.parent))
    try:
        for relative in files:
            source, target = root / relative, temporary / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target, follow_symlinks=False)
            target.chmod(0o755 if os.access(source, os.X_OK) else 0o644)
        (temporary / ".gitignore").write_text(PUBLIC_IGNORE, encoding="utf-8")
        for guide in ("AGENTS.md", "CLAUDE.md"):
            (temporary / guide).write_text(PUBLIC_AGENT_GUIDE, encoding="utf-8")
        write_source_manifest(temporary, files)
        validation = check_export(temporary, policy)
        if not validation["ok"]:
            return validation
        temporary.rename(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    write_archive(output, archive)
    report.write_text(json.dumps({"excluded": excluded}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {
        "ok": True, "output": str(output), "archive": str(archive), "exclusion_report": str(report),
        "file_count": validation["file_count"], "excluded_count": len(excluded),
        "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="New export directory; existing destinations are never overwritten")
    parser.add_argument("--check", type=Path, help="Check an exported directory without changing it")
    parser.add_argument("--audit", action="store_true", help="Audit the live allowlisted source without copying")
    args = parser.parse_args()
    if sum(bool(value) for value in (args.output, args.check, args.audit)) != 1:
        parser.error("choose exactly one of --output, --check, or --audit")
    policy = load_policy(ROOT)
    try:
        if args.check:
            result = check_export(args.check.resolve(strict=True), policy)
        elif args.audit:
            included, excluded, findings = source_inventory(ROOT, policy)
            result = {"ok": not findings, "included_count": len(included), "excluded_count": len(excluded), "findings": findings}
        else:
            result = create_export(ROOT, args.output.resolve(), policy)
    except (OSError, ValueError, KeyError) as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
