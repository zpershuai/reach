"""Validate executable container and CPU identity before running release bytes."""
import argparse
from pathlib import Path
import platform
import struct


def host_platform():
    system = {'Darwin': 'darwin', 'Linux': 'linux'}.get(platform.system())
    architecture = {'arm64': 'arm64', 'aarch64': 'arm64', 'x86_64': 'x64', 'AMD64': 'x64'}.get(platform.machine())
    if not system or not architecture:
        raise ValueError('Unsupported executable host platform')
    return f'{system}-{architecture}'


def check_executable(data, target):
    target = target.removesuffix('-musl')
    if target == 'openwrt-x64':
        target = 'linux-x64'
    if target.startswith('linux-'):
        cpu = {'linux-x64': 62, 'linux-arm64': 183}.get(target)
        if not cpu or len(data) < 64 or data[:7] != b'\x7fELF\x02\x01\x01':
            raise ValueError('Executable platform or format mismatch')
        kind, machine, version = struct.unpack_from('<HHI', data, 16)
        entry, table = struct.unpack_from('<QQ', data, 24)
        header_size, row_size, rows = struct.unpack_from('<HHH', data, 52)
        if kind not in (2, 3) or machine != cpu or version != 1 or header_size != 64 or row_size != 56 or not 1 <= rows <= 4096 or table + rows * row_size > len(data):
            raise ValueError('Invalid ELF identity or header')
        executable = False
        for index in range(rows):
            position = table + index * row_size
            segment, flags, offset, address, _, size, memory = struct.unpack_from('<IIQQQQQ', data, position)
            if offset + size > len(data):
                raise ValueError('Truncated ELF segment')
            if segment == 1 and memory >= size and flags & 1 and address <= entry < address + memory:
                executable = True
        if not executable:
            raise ValueError('ELF entry is not in an executable load segment')
        return
    cpu = {'darwin-x64': 0x01000007, 'darwin-arm64': 0x0100000c}.get(target)
    if not cpu or len(data) < 32 or data[:4] != b'\xcf\xfa\xed\xfe':
        raise ValueError('Executable platform or format mismatch')
    machine, _, kind, commands, size = struct.unpack_from('<IIIII', data, 4)
    if machine != cpu or kind != 2 or not 1 <= commands <= 4096 or 32 + size > len(data):
        raise ValueError('Invalid Mach-O identity or header')
    position = 32
    executable = False
    for _ in range(commands):
        if position + 8 > 32 + size:
            raise ValueError('Truncated Mach-O command')
        command, length = struct.unpack_from('<II', data, position)
        if length < 8 or position + length > 32 + size:
            raise ValueError('Invalid Mach-O command')
        if command == 0x19:
            if length < 72:
                raise ValueError('Truncated Mach-O segment')
            offset, count, _, protection = struct.unpack_from('<QQII', data, position + 40)
            if offset + count > len(data):
                raise ValueError('Truncated Mach-O segment data')
            executable |= bool(protection & 4 and count)
        position += length
    if position != 32 + size or not executable:
        raise ValueError('Invalid Mach-O load commands')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', type=Path)
    parser.add_argument('platform', nargs='?')
    args = parser.parse_args()
    try:
        check_executable(args.path.read_bytes(), args.platform or host_platform())
    except (OSError, ValueError, struct.error):
        parser.exit(1, 'EXECUTABLE_IDENTITY_REJECTED: expected platform, architecture and complete executable format\n')
