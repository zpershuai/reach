"""Native test programs and synthetic header fixtures; never used by installers."""
import json
from pathlib import Path
import subprocess
from binary_identity import host_platform


def compile_fixture(path, version, *, broken=False, stderr=None):
    target = host_platform()
    source = '#include <stdio.h>\n#include <string.h>\nint main(int argc, char **argv) {\n'
    if stderr:
        source += f'fputs({json.dumps(stderr)}, stderr);\n'
    if broken:
        source += 'return 1;\n'
    else:
        source += f'puts(argc > 1 && strcmp(argv[1], "--version") == 0 ? {json.dumps(version)} : {json.dumps(target)}); return 0;\n'
    source += '}\n'
    subprocess.run(['cc', '-x', 'c', '-', '-o', str(path)], input=source, text=True,
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return Path(path).read_bytes()


def platform_bytes(target):
    cases = json.loads((Path(__file__).resolve().parent.parent / 'fixtures/executable-identity.json').read_text())
    return bytes.fromhex(next(case['hex'] for case in cases if case['target'] == target and case['valid']))
