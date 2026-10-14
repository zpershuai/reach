#!/usr/bin/env python3
"""Host-side verified Compose replacement. No shell evaluation of requests."""
import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request
import uuid
import time
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

SEMVER = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"


class MissingAsset(ValueError):
    pass


def read_request(directory, component):
    request = json.loads((directory / "request.json").read_text())
    if request.get("component") != component:
        raise ValueError("Unexpected request component")
    if not re.fullmatch(SEMVER, request.get("version", "")):
        raise ValueError("Invalid request version")
    repo = request.get("repo", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or any(p in (".", "..") for p in repo.split("/")):
        raise ValueError("Invalid request repository")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", request.get("digest", "")):
        raise ValueError("Invalid request digest")
    expected = ["gateway-amd64.tgz"] if component == "gateway" else ["engine-linux-x64-musl", "engine-darwin-arm64", "engine-darwin-x64"]
    if request.get("asset") not in expected:
        raise ValueError("Unexpected release asset")
    return request


def docker(*args, check=True, timeout=300):
    return subprocess.run(["docker", *args], check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


def github_token():
    token = os.environ.get("REACH_UPDATE_GITHUB_TOKEN")
    source = os.environ.get("REACH_UPDATE_GITHUB_TOKEN_FILE")
    if token is not None and source is not None:
        raise ValueError("Set only one GitHub token source")
    if source is not None:
        token = Path(source).read_text().strip()
    if token is not None and (not token or any(c.isspace() or ord(c) < 32 for c in token)):
        raise ValueError("Invalid GitHub token")
    return token


class GithubRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise ValueError("Insecure release redirect")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        # Private asset redirects must not forward the GitHub token to storage.
        if redirected and not newurl.startswith("https://api.github.com/"):
            redirected.remove_header("Authorization")
        return redirected


class ReleaseDownloads:
    def __init__(self, request):
        self.request = request
        self.assets = None
        self.token = github_token()

    def get(self, url, binary=False):
        if not url.startswith("https://api.github.com/"):
            raise ValueError("Release URL must use GitHub API HTTPS")
        headers = {"User-Agent": "reach-release-helper/1", "Accept": "application/octet-stream" if binary else "application/vnd.github+json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        opener = urllib.request.build_opener(GithubRedirect())
        with opener.open(urllib.request.Request(url, headers=headers), timeout=60) as response:
            limit = 128 * 1024 * 1024 if binary else 8 * 1024 * 1024
            data = response.read(limit + 1)
            if len(data) > limit:
                raise ValueError("Release download exceeds size limit")
            return data

    def asset(self, name):
        if self.assets is None:
            req = self.request
            tag = f"{req['component']}-v{req['version']}"
            release = json.loads(self.get(f"https://api.github.com/repos/{req['repo']}/releases/tags/{tag}"))
            if release["tag_name"] != tag or release["draft"] or release["prerelease"]:
                raise ValueError("Unexpected release metadata")
            self.assets = release["assets"]
        matches = [a for a in self.assets if a["name"] == name]
        if len(matches) != 1:
            raise MissingAsset("Missing or duplicate release asset")
        return self.get(matches[0]["url"], binary=True)


def verify_digest(data, digest):
    if hashlib.sha256(data).hexdigest() != digest.lower():
        raise ValueError("Release digest mismatch")


def checksum(text, name):
    matches = [line.split() for line in text.splitlines() if len(line.split()) == 2 and line.split()[1].lstrip("*") == name]
    if len(matches) != 1 or not re.fullmatch(r"[a-fA-F0-9]{64}", matches[0][0]):
        raise ValueError("Missing or invalid published checksum")
    return matches[0][0]


def compose(root, service, override=None, check=True):
    base = Path(os.environ.get("REACH_UPDATE_COMPOSE_FILE", root / "deploy/compose.yaml")).resolve()
    args = ["compose", "-f", str(base)]
    if override:
        args += ["-f", str(override)]
    return docker(*args, "up", "-d", "--no-build", "--no-deps", "--force-recreate", service, check=check)


def install_image(root, service, staged, current, previous, override=None):
    had_previous = docker("image", "inspect", current, check=False, timeout=30).returncode == 0
    if had_previous:
        docker("tag", current, previous, timeout=30)
    docker("tag", staged, current, timeout=30)
    try:
        compose(root, service, override)
    except Exception:
        if had_previous:
            docker("tag", previous, current, timeout=30)
            compose(root, service, override, check=False)
        raise


@contextmanager
def idle_admission(request, directory, timeout=300):
    """Only a prepared artifact may reserve admission; no downloads run in this phase."""
    nonce = uuid.uuid4().hex
    intent = {**request, "nonce": nonce, "expiresAt": int(time.time() * 1000) + 900_000}
    marker, acknowledgement = directory / "apply.json", directory / "idle.json"
    acknowledgement.unlink(missing_ok=True)
    temporary = directory / "apply.json.tmp"
    temporary.write_text(json.dumps(intent))
    temporary.chmod(0o644)  # Readable by the unprivileged payload; contains no credentials.
    temporary.replace(marker)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                ack = json.loads(acknowledgement.read_text())
            except (FileNotFoundError, ValueError):
                ack = {}
            if (ack.get("nonce") == nonce and ack.get("component") == request["component"]
                    and ack.get("version") == request["version"]):
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Component has not acknowledged idle apply")
            time.sleep(0.1)
        if json.loads(marker.read_text()) != intent or time.time() * 1000 >= intent["expiresAt"]:
            raise TimeoutError("Apply intent changed or expired")
        # Refresh the bounded reservation after a possibly long idle wait.
        # Apply + rollback have at most two 300s Compose calls and four 30s metadata/tag calls.
        intent["expiresAt"] = int(time.time() * 1000) + 900_000
        temporary.write_text(json.dumps(intent))
        temporary.chmod(0o644)
        temporary.replace(marker)
        yield
    finally:
        marker.unlink(missing_ok=True)
        acknowledgement.unlink(missing_ok=True)


def safe_extract(archive, directory):
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                raise ValueError("Unsafe release archive member")
            allowed = (member.name.startswith("packages/reach-rpc/dist/")
                       or member.name in ["packages/reach-rpc/package.json", "packages/reach-rpc/package-lock.json", "deploy/compose.yaml", "deploy/Dockerfile.gateway"]
                       or member.name.startswith("scripts/"))
            if not allowed or member.isdir():
                continue
            if not member.isfile():
                raise ValueError("Unsupported release archive member")
            target = directory / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644)


def apply_gateway(request, root, downloads, request_dir):
    owner = request["repo"].split("/")[0].lower()
    registry = f"ghcr.io/{owner}/reach-gateway"
    image = f"{registry}:{request['version']}"
    staged = f"reach-gateway:staged-{uuid.uuid4().hex}"
    pulled = False
    try:
        sums = downloads.asset("SHA256SUMS").decode()
        metadata = downloads.asset("gateway-image.txt")
        verify_digest(metadata, checksum(sums, "gateway-image.txt"))
        reference = metadata.decode().strip()
        if not re.fullmatch(re.escape(registry) + r"@sha256:[a-f0-9]{64}", reference):
            raise ValueError("Invalid published image digest")
    except (urllib.error.URLError, MissingAsset, KeyError):
        reference = None
    if reference is not None:
        pulled = docker("pull", image, check=False).returncode == 0
        if pulled:
            digests = json.loads(docker("image", "inspect", image, "--format", "{{json .RepoDigests}}").stdout)
            if reference not in digests:
                raise ValueError("Gateway image digest mismatch")
            version = docker("run", "--rm", "--entrypoint", "node", image, "dist/gateway-main.js", "--version").stdout.strip()
            if version != request["version"]:
                raise ValueError("Gateway image version mismatch")
            staged = image
    if not pulled:
        data = downloads.asset(request["asset"])
        verify_digest(data, request["digest"])
        with tempfile.TemporaryDirectory(prefix="reach-gateway-release-") as directory:
            work = Path(directory)
            archive = work / request["asset"]
            archive.write_bytes(data)
            extracted = work / "release"
            safe_extract(archive, extracted)
            docker("build", "--platform", "linux/amd64", "-f", str(extracted / "deploy/Dockerfile.gateway"), "-t", staged, str(extracted))
            version = docker("run", "--rm", "--entrypoint", "node", staged, "dist/gateway-main.js", "--version").stdout.strip()
            if version != request["version"]:
                raise ValueError("Gateway tarball version mismatch")
            with idle_admission(request, request_dir):
                copy_gateway_payload(extracted, root)
                install_image(root, "gateway", staged, "reach-gateway:current", "reach-gateway:previous")
        return
    with idle_admission(request, request_dir):
        install_image(root, "gateway", staged, "reach-gateway:current", "reach-gateway:previous")


def copy_gateway_payload(extracted, root):
    # Copy only release payloads. Existing local Compose policy and secrets survive.
    for payload in ["packages/reach-rpc/dist", "packages/reach-rpc/package.json", "packages/reach-rpc/package-lock.json", "deploy/Dockerfile.gateway", "scripts"]:
        source, target = extracted / payload, root / payload
        if not source.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True)
        else:
            shutil.copy2(source, target)
    compose_path = root / "deploy/compose.yaml"
    if not compose_path.exists():
        shutil.copy2(extracted / "deploy/compose.yaml", compose_path)

def apply_engine(request, root, downloads, request_dir):
    service = os.environ.get("REACH_UPDATE_ENGINE_SERVICE", "engine")
    binary = os.environ.get("REACH_UPDATE_ENGINE_BINARY_PATH", "/usr/local/bin/engine")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", service) or not re.fullmatch(r"/[A-Za-z0-9_./-]+", binary) or ".." in PurePosixPath(binary).parts:
        raise ValueError("Invalid Engine service or binary path")
    if request["asset"] != "engine-linux-x64-musl":
        raise ValueError("Docker Engine requires the Linux musl asset")
    compose_file = Path(os.environ.get("REACH_UPDATE_COMPOSE_FILE", root / "deploy/compose.yaml")).resolve()
    configuration = json.loads(docker("compose", "-f", str(compose_file), "config", "--format", "json").stdout)
    base = configuration["services"][service]["image"]
    if not re.fullmatch(r"[A-Za-z0-9_./:@-]+", base):
        raise ValueError("Invalid base Engine image")
    user = docker("image", "inspect", base, "--format", "{{.Config.User}}").stdout.strip() or "0"
    if not re.fullmatch(r"[A-Za-z0-9_:-]+", user):
        raise ValueError("Invalid base Engine user")
    data = downloads.asset(request["asset"])
    verify_digest(data, request["digest"])
    staged = f"reach-engine:staged-{uuid.uuid4().hex}"
    with tempfile.TemporaryDirectory(prefix="reach-engine-release-") as directory:
        work = Path(directory)
        (work / "engine").write_bytes(data)
        (work / "Dockerfile").write_text(f"FROM {base}\nUSER 0\nCOPY engine {binary}\nRUN chmod 755 {binary}\nUSER {user}\n")
        docker("build", "--platform", "linux/amd64", "-t", staged, str(work))
        version = docker("run", "--rm", "--entrypoint", binary, staged, "--version").stdout.strip()
        if version != request["version"]:
            raise ValueError("Engine image version mismatch")
    override = root / ".reach/engine-update.override.json"
    override.parent.mkdir(parents=True, exist_ok=True)
    override.write_text(json.dumps({"services": {service: {"image": "reach-engine:current"}}}))
    # Compose merges only the image override; env, command, networks and workspace mounts remain.
    with idle_admission(request, request_dir):
        if docker("image", "inspect", "reach-engine:current", check=False, timeout=30).returncode != 0:
            docker("tag", base, "reach-engine:current", timeout=30)
        install_image(root, service, staged, "reach-engine:current", "reach-engine:previous", override)


def apply_request(component, directory, root):
    request = read_request(directory, component)
    downloads = ReleaseDownloads(request)
    if component == "gateway":
        apply_gateway(request, root, downloads, directory)
    else:
        apply_engine(request, root, downloads, directory)
    temporary = directory / "result.json.tmp"
    temporary.write_text(json.dumps({"component": component, "version": request["version"], "ok": True}))
    temporary.replace(directory / "result.json")
    (directory / "request.json").unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("component", choices=["engine", "gateway"])
    parser.add_argument("request_dir", type=Path)
    parser.add_argument("release_root", type=Path)
    args = parser.parse_args()
    directory, root = args.request_dir.resolve(), args.release_root.resolve()
    # Kernel lock is released even if the helper crashes during a recreate.
    lock = (directory / ".apply.lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return
    try:
        apply_request(args.component, directory, root)
    except Exception:
        # Keep failed requests for retries; do not log private downloader/config details.
        (directory / "result.json").write_text(json.dumps({"component": args.component, "ok": False}))
        raise SystemExit("Reach release apply failed; previous image retained")
    finally:
        lock.close()


if __name__ == "__main__":
    main()
