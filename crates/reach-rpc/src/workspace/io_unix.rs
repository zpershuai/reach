use super::*;

/// A file descriptor pinned to a validated workspace directory. On unix it is
/// a real open fd used for descriptor-relative I/O; elsewhere it is an
/// uninhabited placeholder so the fail-closed stubs below still compile.
#[cfg(unix)]
pub(super) type Descriptor = rustix::fd::OwnedFd;
#[cfg(not(unix))]
pub(super) struct Descriptor;

#[cfg(unix)]
pub(super) fn open_verified_parent(
    root: &Path,
    input: &str,
    create_missing: bool,
) -> Result<Option<(Descriptor, String)>, FilesystemError> {
    use rustix::fs::{mkdirat, open, openat, Mode, OFlags};

    let real_root = fs::canonicalize(root).map_err(|_| denied())?;
    let target = join_resolved(&real_root, input);
    if !is_within(&real_root, &target) || target == real_root {
        return Err(denied());
    }
    let relative = pathdiff(&real_root, &target);
    let Some(name) = relative.last().cloned() else {
        return Err(denied());
    };
    if !is_safe_component(&name) {
        return Err(denied());
    }
    let parents = &relative[..relative.len() - 1];
    for part in parents {
        if !is_safe_component(part) {
            return Err(denied());
        }
    }

    let dir_flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut parent = open(&real_root, dir_flags, Mode::empty()).map_err(|_| denied())?;
    for part in parents {
        let child = match openat(&parent, part.as_str(), dir_flags, Mode::empty()) {
            Ok(fd) => fd,
            // Missing parent on a read-only walk: the target cannot exist, so
            // report Ok(None) instead of creating the tree as a side effect.
            Err(err) if err == rustix::io::Errno::NOENT && !create_missing => return Ok(None),
            Err(err) if err == rustix::io::Errno::NOENT => {
                match mkdirat(&parent, part.as_str(), Mode::from_raw_mode(0o755)) {
                    Ok(()) => openat(&parent, part.as_str(), dir_flags, Mode::empty())
                        .map_err(|_| denied())?,
                    // Another actor created this directory between the failed
                    // openat and mkdirat; re-open it. NOFOLLOW re-validates it
                    // against a symlink swap during that window.
                    Err(create_err) if create_err == rustix::io::Errno::EXIST => {
                        openat(&parent, part.as_str(), dir_flags, Mode::empty())
                            .map_err(|_| denied())?
                    }
                    Err(_) => return Err(denied()),
                }
            }
            Err(_) => return Err(denied()),
        };
        parent = child;
    }
    Ok(Some((parent, name)))
}

#[cfg(not(unix))]
pub(super) fn open_verified_parent(
    _root: &Path,
    _input: &str,
    _create_missing: bool,
) -> Result<Option<(Descriptor, String)>, FilesystemError> {
    Err(denied())
}

#[cfg(unix)]
pub(super) fn descriptor_read_file(
    parent: &Descriptor,
    name: &str,
    cancelled: Option<&Token>,
) -> Result<Option<String>, FilesystemError> {
    use rustix::fs::{openat, Mode, OFlags};

    // O_NONBLOCK prevents hanging on a FIFO/device at the target path: a plain
    // O_RDONLY open of a FIFO blocks until a writer appears (while the caller
    // holds write_lock). It is a no-op for regular files. The is_file() check
    // below rejects such targets before any read.
    let fd = match openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => fd,
        Err(err) if err == rustix::io::Errno::NOENT => return Ok(None),
        Err(_) => return Err(denied()),
    };
    let mut file = File::from(fd);
    let meta = file.metadata().map_err(|_| denied())?;
    if !meta.is_file() {
        return Err(denied());
    }
    if meta.len() as usize > MAX_FILE_BYTES {
        return Err(FilesystemError::new("FILE_TOO_LARGE"));
    }
    let bytes = read_regular_file(&mut file, MAX_FILE_BYTES, cancelled)?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| FilesystemError::new("INVALID_UTF8"))
}

#[cfg(not(unix))]
pub(super) fn descriptor_read_file(
    _parent: &Descriptor,
    _name: &str,
    _cancelled: Option<&Token>,
) -> Result<Option<String>, FilesystemError> {
    Err(denied())
}

#[cfg(unix)]
pub(super) fn descriptor_atomic_write(
    parent: &Descriptor,
    name: &str,
    content: &str,
) -> Result<(), FilesystemError> {
    use rustix::fs::{fchmod, openat, renameat, statat, unlinkat, AtFlags, Mode, OFlags};
    use std::os::unix::fs::MetadataExt;

    let original = match openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
        Mode::empty(),
    ) {
        Ok(fd) => {
            let file = File::from(fd);
            let metadata = file.metadata().map_err(|_| denied())?;
            if !metadata.is_file() {
                return Err(denied());
            }
            // Hold the descriptor until replacement so an unlinked inode
            // cannot be recycled into a different target during validation.
            Some((file, metadata))
        }
        Err(error) if error == rustix::io::Errno::NOENT => None,
        Err(_) => return Err(denied()),
    };

    let temporary = format!(".{name}.{}.tmp", Uuid::new_v4());
    let write_flags =
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let write_result = (|| {
        let fd = openat(
            parent,
            temporary.as_str(),
            write_flags,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|_| denied())?;
        let mut file = File::from(fd);
        file.write_all(content.as_bytes()).map_err(|_| denied())?;
        // Preserve ordinary access/execution bits, never setuid/setgid/sticky.
        // New files have a private default independent of the process umask.
        let mode = original
            .as_ref()
            .map_or(0o600, |(_, metadata)| metadata.mode() & 0o777);
        fchmod(&file, Mode::from_raw_mode(mode as _)).map_err(|_| denied())?;
        file.sync_all().map_err(|_| denied())?;
        drop(file);
        // Re-validate the final component immediately before renameat. The
        // earlier pre-read (descriptor_read_file O_NOFOLLOW) rejected a symlink
        // already in place, but one swapped in since then must not be destroyed
        // silently: deny instead of replacing the link in place.
        match statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(meta) => {
                if !original.as_ref().is_some_and(|(_, original)| {
                    meta.st_dev as u64 == original.dev() && meta.st_ino as u64 == original.ino()
                }) {
                    return Err(denied());
                }
            }
            Err(error) if error == rustix::io::Errno::NOENT && original.is_none() => {}
            Err(_) => return Err(denied()),
        }
        renameat(parent, temporary.as_str(), parent, name).map_err(|_| denied())?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = unlinkat(parent, temporary.as_str(), AtFlags::empty());
    }
    write_result
}

#[cfg(not(unix))]
pub(super) fn descriptor_atomic_write(
    _parent: &Descriptor,
    _name: &str,
    _content: &str,
) -> Result<(), FilesystemError> {
    Err(denied())
}

pub(super) fn read_regular_file(
    file: &mut File,
    max_bytes: usize,
    cancelled: Option<&Token>,
) -> Result<Vec<u8>, FilesystemError> {
    let meta = file.metadata().map_err(|_| denied())?;
    if !meta.is_file() {
        return Err(denied());
    }
    if meta.len() > max_bytes as u64 {
        return Err(FilesystemError::new("FILE_TOO_LARGE"));
    }
    read_file_chunks(file, max_bytes, None, cancelled)
}

/// Shared bounded reads for whole files and grep's partial byte budget.
pub(super) fn read_file_chunks(
    reader: &mut impl Read,
    max_bytes: usize,
    deadline: Option<Instant>,
    cancelled: Option<&Token>,
) -> Result<Vec<u8>, FilesystemError> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        ensure_before_deadline(deadline, cancelled)?;
        let limit = buffer.len().min(max_bytes + 1 - bytes.len());
        let count = reader.read(&mut buffer[..limit]).map_err(|_| denied())?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        if bytes.len() > max_bytes {
            return Err(FilesystemError::new("FILE_TOO_LARGE"));
        }
    }
    Ok(bytes)
}

#[cfg(unix)]
pub(super) fn open_child_descriptor(
    parent: &Descriptor,
    name: &str,
    directory: bool,
) -> Result<Descriptor, rustix::io::Errno> {
    use rustix::fs::{openat, Mode, OFlags};
    let mut flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
    if directory {
        flags |= OFlags::DIRECTORY;
    }
    openat(parent, name, flags, Mode::empty())
}

#[cfg(unix)]
pub(super) fn open_child(
    parent: &Descriptor,
    name: &str,
    directory: bool,
) -> Result<File, FilesystemError> {
    open_child_descriptor(parent, name, directory)
        .map(File::from)
        .map_err(|error| {
            if error == rustix::io::Errno::NOENT {
                FilesystemError::new("FILE_NOT_FOUND")
            } else {
                denied()
            }
        })
}

#[cfg(not(unix))]
pub(super) fn open_child(
    _parent: &Descriptor,
    _name: &str,
    _directory: bool,
) -> Result<File, FilesystemError> {
    Err(denied())
}

#[cfg(unix)]
pub(super) fn open_traversal_child(
    parent: &Descriptor,
    name: &str,
    directory: bool,
) -> Result<Option<File>, FilesystemError> {
    use rustix::io::Errno;
    let file = match open_child_descriptor(parent, name, directory) {
        Ok(fd) => File::from(fd),
        Err(Errno::NOENT | Errno::NOTDIR | Errno::LOOP) => return Ok(None),
        Err(_) => return Err(denied()),
    };
    let meta = file.metadata().map_err(|_| denied())?;
    if (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        return Ok(None);
    }
    Ok(Some(file))
}

#[cfg(not(unix))]
pub(super) fn open_traversal_child(
    _parent: &Descriptor,
    _name: &str,
    _directory: bool,
) -> Result<Option<File>, FilesystemError> {
    Err(denied())
}

#[cfg(unix)]
pub(super) fn open_verified_entry(root: &Path, input: &str) -> Result<File, FilesystemError> {
    use rustix::fs::{open, Mode, OFlags};
    let real_root = fs::canonicalize(root).map_err(|_| FilesystemError::new("FILE_NOT_FOUND"))?;
    let target = join_resolved(&real_root, input);
    if target == real_root {
        return open(
            &real_root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|_| denied());
    }
    let (parent, name) = open_verified_parent(root, input, false)?
        .ok_or_else(|| FilesystemError::new("FILE_NOT_FOUND"))?;
    open_child(&parent, &name, false)
}

#[cfg(not(unix))]
pub(super) fn open_verified_entry(_root: &Path, _input: &str) -> Result<File, FilesystemError> {
    Err(denied())
}

#[cfg(unix)]
pub(super) fn open_verified_directory(
    root: &Path,
    input: &str,
) -> Result<Descriptor, FilesystemError> {
    let file = open_verified_entry(root, input)?;
    if !file.metadata().map_err(|_| denied())?.is_dir() {
        return Err(FilesystemError::new("FILE_NOT_FOUND"));
    }
    Ok(file.into())
}

#[cfg(not(unix))]
pub(super) fn open_verified_directory(
    _root: &Path,
    _input: &str,
) -> Result<Descriptor, FilesystemError> {
    Err(denied())
}

#[cfg(unix)]
pub(super) fn directory_entries(
    directory: &Descriptor,
    deadline: Option<Instant>,
    cancelled: Option<&Token>,
) -> Result<Vec<(String, FsEntryType)>, FilesystemError> {
    use rustix::fs::{statat, AtFlags, Dir, FileType};
    let mut entries = Vec::new();
    for entry in Dir::read_from(directory).map_err(|_| denied())? {
        ensure_before_deadline(deadline, cancelled)?;
        let entry = entry.map_err(|_| denied())?;
        let name = entry.file_name().to_str().map_err(|_| denied())?;
        if name == "." || name == ".." || is_atomic_write_temp(name) {
            continue;
        }
        if entries.len() == MAX_DIRECTORY_ENTRIES {
            return Err(FilesystemError::new("DIRECTORY_TOO_LARGE"));
        }
        let meta = match statat(directory, entry.file_name(), AtFlags::SYMLINK_NOFOLLOW) {
            Ok(meta) => meta,
            Err(rustix::io::Errno::NOENT) => continue,
            Err(_) => return Err(denied()),
        };
        let entry_type = match FileType::from_raw_mode(meta.st_mode) {
            FileType::Directory => FsEntryType::Directory,
            FileType::Symlink => FsEntryType::Symlink,
            FileType::RegularFile => FsEntryType::File,
            _ => continue,
        };
        entries.push((name.to_owned(), entry_type));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

#[cfg(not(unix))]
pub(super) fn directory_entries(
    _directory: &Descriptor,
    _deadline: Option<Instant>,
    _cancelled: Option<&Token>,
) -> Result<Vec<(String, FsEntryType)>, FilesystemError> {
    Err(denied())
}
