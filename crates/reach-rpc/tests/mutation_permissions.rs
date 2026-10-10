#![cfg(unix)]
use reach_rpc::{
    workspace::WorkspaceFilesystem, FsEditParams, FsReadParams, FsWriteMode, FsWriteParams,
};
use std::{collections::HashMap, fs, os::unix::fs::PermissionsExt};

#[test]
fn revision_safe_mutations_preserve_modes_and_new_files_are_private() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = WorkspaceFilesystem::new(HashMap::from([(
        "fixture".into(),
        directory.path().to_path_buf(),
    )]));
    for mode in [0o755, 0o644, 0o4755] {
        let ordinary_mode = mode & 0o777;
        let path = format!("mode-{mode:o}");
        let target = directory.path().join(&path);
        fs::write(&target, "old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(mode)).unwrap();
        let read = || {
            workspace
                .read(&FsReadParams {
                    workspace: "fixture".into(),
                    path: path.clone(),
                    start_line: 1,
                    max_lines: 1,
                })
                .unwrap()
        };
        let before = read();
        let edit = FsEditParams {
            workspace: "fixture".into(),
            path: path.clone(),
            old_string: "old".into(),
            new_string: "edited".into(),
            replace_all: false,
            if_match: Some(before.revision.clone()),
        };
        workspace.edit(&edit).unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            ordinary_mode
        );
        assert_eq!(workspace.edit(&edit).unwrap_err().code, "REVISION_CONFLICT");
        assert_eq!(fs::read_to_string(&target).unwrap(), "edited");
        let write = FsWriteParams {
            workspace: "fixture".into(),
            path: path.clone(),
            content: "written".into(),
            mode: FsWriteMode::Overwrite,
            if_match: Some(read().revision),
        };
        workspace.write(&write).unwrap();
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            ordinary_mode
        );
        assert_eq!(
            workspace.write(&write).unwrap_err().code,
            "REVISION_CONFLICT"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "written");
    }
    workspace
        .write(&FsWriteParams {
            workspace: "fixture".into(),
            path: "new.txt".into(),
            content: "new".into(),
            mode: FsWriteMode::Create,
            if_match: None,
        })
        .unwrap();
    assert_eq!(
        fs::metadata(directory.path().join("new.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
}
