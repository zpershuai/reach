"""Atomic same-filesystem staging shared by supported host installers."""
import os
from pathlib import Path
import shutil
import tempfile


def stage_file(target, content=None, source=None, mode=0o600, link=None):
    """Keep each staged file on its target filesystem for atomic replacement."""
    descriptor, name = tempfile.mkstemp(prefix='.reach-install-', dir=target.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        if link is not None:
            temporary.unlink()
            temporary.symlink_to(link)
        else:
            if source is not None:
                shutil.copyfile(source, temporary)
            else:
                temporary.write_text(content)
            temporary.chmod(mode)
            with temporary.open('rb') as stream:
                os.fsync(stream.fileno())
        return temporary
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def restore_file(target, saved):
    if saved is None:
        target.unlink(missing_ok=True)
        return
    if saved.is_symlink():
        temporary = stage_file(target, link=os.readlink(saved))
    else:
        temporary = stage_file(target, source=saved, mode=saved.stat().st_mode & 0o7777)
    try:
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)

