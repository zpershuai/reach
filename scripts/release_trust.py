"""Bounded downloads from approved HTTPS release origins; fixtures require opt-in."""
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

GITHUB_ORIGINS = frozenset({'https://api.github.com', 'https://github.com',
                            'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'})
NODE_ORIGINS = frozenset({'https://nodejs.org'})


def origin(url):
    parsed = urlsplit(url)
    if any(ord(c) <= 32 or ord(c) == 127 for c in url) or parsed.username or parsed.password or parsed.fragment:
        raise ValueError('Invalid release URL')
    port = parsed.port
    host = parsed.hostname
    if parsed.scheme == 'file':
        if parsed.netloc or not parsed.path.startswith('/'):
            raise ValueError('Invalid fixture file URL')
        return 'file://'
    if not host:
        raise ValueError('Invalid release host')
    host = f'[{host}]' if ':' in host else host
    suffix = '' if port is None or (parsed.scheme == 'https' and port == 443) else f':{port}'
    return f'{parsed.scheme}://{host}{suffix}'


def approve(url, allowed=GITHUB_ORIGINS, test_mode=False):
    value = origin(url)
    if value in allowed:
        return value
    parsed = urlsplit(url)
    if test_mode and (value == 'file://' or parsed.scheme == 'http' and parsed.hostname in {'localhost', '127.0.0.1', '::1'}):
        return value
    raise ValueError('Unapproved release origin')


class ApprovedRedirect(HTTPRedirectHandler):
    def __init__(self, allowed=GITHUB_ORIGINS, test_mode=False):
        self.allowed, self.test_mode = allowed, test_mode

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        newurl = urljoin(req.full_url, newurl)
        previous = approve(req.full_url, self.allowed, self.test_mode)
        target = approve(newurl, self.allowed, self.test_mode)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected and target != previous:
            for name in ['Authorization', 'Cookie', 'Proxy-Authorization']:
                redirected.remove_header(name)
        return redirected


def download(url, *, token=None, binary=False, limit=128 * 1024 * 1024, allowed=GITHUB_ORIGINS, test_mode=False, timeout=60):
    initial = approve(url, allowed, test_mode)
    headers = {'User-Agent': 'reach-release-download/1', 'Accept': 'application/octet-stream' if binary else 'application/vnd.github+json'}
    if token:
        if initial != 'https://api.github.com':
            raise ValueError('Release credentials require GitHub API origin')
        headers['Authorization'] = f'Bearer {token}'
    opener = build_opener(ApprovedRedirect(allowed, test_mode))
    with opener.open(Request(url, headers=headers), timeout=timeout) as response:
        approve(response.url, allowed, test_mode)
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Release download exceeds size limit')
        return data
