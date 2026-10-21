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
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_trust import ApprovedRedirect, approve, download
from binary_identity import check_executable

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


class GithubRedirect(ApprovedRedirect):
    pass


class ReleaseDownloads:
    def __init__(self, request, *, test_mode=False):
        self.request = request
        self.assets = None
        self.token = github_token()
        self.test_mode = test_mode

    def get(self, url, binary=False):
        source = approve(url, test_mode=self.test_mode)
        if source != "https://api.github.com" and not self.test_mode:
            raise ValueError("Release URL must use GitHub API HTTPS")
        return download(url, token=self.token, binary=binary,
                        limit=128 * 1024 * 1024 if binary else 8 * 1024 * 1024, test_mode=self.test_mode)

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


def verify_image(image, component):
    identity = json.loads(docker('image', 'inspect', image, '--format', '{{json .}}').stdout)
    if identity.get('Os') != 'linux' or identity.get('Architecture') != 'amd64':
        raise ValueError('Release image platform mismatch')
    if identity.get('Config', {}).get('Labels', {}).get('io.reach.component') != component:
        raise ValueError('Release image component mismatch')


def checksum(text, name):
    matches = [line.split() for line in text.splitlines() if len(line.split()) >= 2 and line.split()[1].lstrip("*") == name]
    if len(matches) != 1 or len(matches[0]) != 2 or not re.fullmatch(r"[a-fA-F0-9]{64}", matches[0][0]):
        raise ValueError("Missing or invalid published checksum")
    return matches[0][0]


def compose(root, service, override=None, check=True):
    base = Path(os.environ.get("REACH_UPDATE_COMPOSE_FILE", root / "deploy/compose.yaml")).resolve()
    args = ["compose", "-f", str(base)]
    if override:
        args += ["-f", str(override)]
    return docker(*args, "up", "-d", "--no-build", "--no-deps", "--force-recreate", service, check=check)


def wait_healthy(root, service, override=None, timeout=30, expected_image=None):
    base = Path(os.environ.get('REACH_UPDATE_COMPOSE_FILE', root / 'deploy/compose.yaml')).resolve()
    arguments = ['compose', '-f', str(base)]
    if override: arguments += ['-f', str(override)]
    deadline = time.monotonic() + timeout
    while True:
        container = docker(*arguments, 'ps', '-q', service, timeout=5).stdout.strip()
        if not re.fullmatch('[a-f0-9]{12,64}', container):
            raise RuntimeError('Updated container is not running')
        state = json.loads(docker('inspect', container, '--format', '{{json .State}}', timeout=5).stdout)
        if expected_image:
            running = docker('inspect', container, '--format', '{{.Image}}', timeout=5).stdout.strip()
            expected = docker('image', 'inspect', expected_image, '--format', '{{.Id}}', timeout=5).stdout.strip()
            if not re.fullmatch('sha256:[a-f0-9]{64}', expected) or running != expected:
                raise RuntimeError('Updated container is not using the verified image')
        if not state.get('Running') or state.get('OOMKilled') or state.get('Dead'):
            raise RuntimeError('Updated container exited during startup')
        health = state.get('Health', {}).get('Status')
        if health == 'unhealthy': raise RuntimeError('Updated container reported unhealthy')
        if service == os.environ.get('REACH_UPDATE_ENGINE_SERVICE', 'engine'):
            output = docker('logs', '--tail', '50', container, timeout=5).stdout
            acknowledged = False
            for line in output.splitlines():
                try: event = json.loads(line)
                except ValueError: continue
                if isinstance(event, dict) and event.get('event') == 'heartbeat' and event.get('ok') is True: acknowledged = True
        else:
            probe = "const p=Number(process.env.GATEWAY_PORT??8787);if(!Number.isInteger(p)||p<1||p>65535)process.exit(1);const r=await fetch('http://127.0.0.1:'+p+'/healthz');const v=await r.json();if(!r.ok||v.status!=='ok'||v.protocol!=='reach-rpc/1.0')process.exit(1)"
            acknowledged = docker('exec', container, 'node', '--input-type=module', '-e', probe, check=False, timeout=5).returncode == 0
        if acknowledged and health != 'starting': return
        if time.monotonic() >= deadline: raise TimeoutError('Updated component did not confirm startup health')
        time.sleep(0.1)


def install_image(root, service, staged, current, previous, override=None):
    if override is None:
        override = root / '.reach' / (service + '-update.override.json')
        override.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        override.write_text(json.dumps({'services': {service: {'image': current}}}))
    base = Path(os.environ.get('REACH_UPDATE_COMPOSE_FILE', root / 'deploy/compose.yaml')).resolve()
    container = docker('compose', '-f', str(base), 'ps', '-q', service, check=False, timeout=5).stdout.strip()
    prior_image = ''
    if re.fullmatch('[a-f0-9]{12,64}', container):
        prior_image = docker('inspect', container, '--format', '{{.Image}}', check=False, timeout=5).stdout.strip()
    if not re.fullmatch('sha256:[a-f0-9]{64}', prior_image):
        prior_image = current if docker('image', 'inspect', current, check=False, timeout=30).returncode == 0 else ''
    had_previous = bool(prior_image)
    if had_previous: docker("tag", prior_image, previous, timeout=30)
    docker("tag", staged, current, timeout=30)
    try:
        compose(root, service, override)
        wait_healthy(root, service, override, expected_image=current)
    except Exception:
        if had_previous:
            try:
                docker("tag", previous, current, timeout=30)
                compose(root, service, override)
                wait_healthy(root, service, override, expected_image=current)
            except Exception:
                raise RuntimeError('UPDATE_ROLLBACK_FAILED: previous image and private request retained') from None
        else:
            docker('compose', '-f', str(base), '-f', str(override), 'rm', '-s', '-f', service, check=False)
            docker('image', 'rm', current, check=False, timeout=30)
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
    sums = downloads.asset("SHA256SUMS").decode()
    try:
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
            verify_image(image, 'gateway')
            version = docker("run", "--rm", "--entrypoint", "node", image, "dist/gateway-main.js", "--version").stdout.strip()
            if version != request["version"]:
                raise ValueError("Gateway image version mismatch")
            staged = image
    if not pulled:
        data = downloads.asset(request["asset"])
        if checksum(sums, request["asset"]).lower() != request["digest"].lower():
            raise ValueError('Request checksum differs from published checksum')
        verify_digest(data, request["digest"])
        with tempfile.TemporaryDirectory(prefix="reach-gateway-release-") as directory:
            work = Path(directory)
            archive = work / request["asset"]
            archive.write_bytes(data)
            extracted = work / "release"
            safe_extract(archive, extracted)
            docker("build", "--platform", "linux/amd64", "-f", str(extracted / "deploy/Dockerfile.gateway"), "-t", staged, str(extracted))
            verify_image(staged, 'gateway')
            version = docker("run", "--rm", "--entrypoint", "node", staged, "dist/gateway-main.js", "--version").stdout.strip()
            if version != request["version"]:
                raise ValueError("Gateway tarball version mismatch")
            with idle_admission(request, request_dir):
                with gateway_payload_transaction(extracted, root):
                    install_image(root, "gateway", staged, "reach-gateway:current", "reach-gateway:previous")
        return
    with idle_admission(request, request_dir):
        install_image(root, "gateway", staged, "reach-gateway:current", "reach-gateway:previous")


GATEWAY_PAYLOADS = ["packages/reach-rpc/dist", "packages/reach-rpc/package.json", "packages/reach-rpc/package-lock.json", "deploy/Dockerfile.gateway", "scripts"]


@contextmanager
def gateway_payload_transaction(extracted, root):
    private = root / '.reach'; private.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix='payload-recovery-', dir=private))
    saved = []
    for index, payload in enumerate(GATEWAY_PAYLOADS):
        target = root / payload; snapshot = backup / str(index)
        if target.is_symlink(): snapshot.symlink_to(os.readlink(target))
        elif target.is_dir(): shutil.copytree(target, snapshot, symlinks=True)
        elif target.exists(): shutil.copy2(target, snapshot)
        saved.append((target, snapshot if os.path.lexists(snapshot) else None))
    complete = False
    try:
        copy_gateway_payload(extracted, root)
        yield
        complete = True
    except BaseException:
        failed = False
        for target, snapshot in reversed(saved):
            try:
                if target.is_dir() and not target.is_symlink(): shutil.rmtree(target)
                else: target.unlink(missing_ok=True)
                if snapshot is not None:
                    if snapshot.is_symlink(): target.symlink_to(os.readlink(snapshot))
                    elif snapshot.is_dir(): shutil.copytree(snapshot, target, symlinks=True)
                    else: shutil.copy2(snapshot, target)
            except OSError: failed = True
        if failed:
            (backup / 'recovery.json').write_text(json.dumps({'files':[{'target':str(target),'backup':str(snapshot) if snapshot else None} for target,snapshot in saved]}))
            raise RuntimeError('UPDATE_PAYLOAD_RECOVERY_REQUIRED: retain private payload backup') from None
        complete = True
        raise
    finally:
        if complete: shutil.rmtree(backup)


def copy_gateway_payload(extracted, root):
    # Keep operator-owned deploy/data/ (including SQLite WAL files) outside this allow-list.
    # Copy only release payloads. Existing local Compose policy and secrets survive.
    for payload in GATEWAY_PAYLOADS:
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
    if checksum(downloads.asset('SHA256SUMS').decode(), request['asset']).lower() != request['digest'].lower():
        raise ValueError('Request checksum differs from published checksum')
    verify_digest(data, request["digest"])
    check_executable(data, "linux-x64")
    staged = f"reach-engine:staged-{uuid.uuid4().hex}"
    with tempfile.TemporaryDirectory(prefix="reach-engine-release-") as directory:
        work = Path(directory)
        (work / "engine").write_bytes(data)
        (work / "Dockerfile").write_text(f"FROM {base}\nLABEL io.reach.component=engine\nUSER 0\nCOPY engine {binary}\nRUN chmod 755 {binary}\nUSER {user}\n")
        docker("build", "--platform", "linux/amd64", "-t", staged, str(work))
        verify_image(staged, 'engine')
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
