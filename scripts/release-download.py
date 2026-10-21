#!/usr/bin/env python3
"""Fetch installer artifacts using the shared approved-origin policy."""
import argparse
import os
from pathlib import Path
import sys
from release_trust import download


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('url')
    parser.add_argument('output', nargs='?', type=Path)
    args = parser.parse_args()
    try:
        data = download(args.url, binary=args.output is not None,
                        test_mode=os.environ.get('REACH_RELEASE_TEST_MODE') == '1')
        if args.output is None:
            sys.stdout.buffer.write(data)
        else:
            with args.output.open('xb') as target:
                target.write(data)
    except Exception:
        parser.exit(1, 'RELEASE_DOWNLOAD_REJECTED: check approved source, TLS and availability\n')


if __name__ == '__main__':
    main()
