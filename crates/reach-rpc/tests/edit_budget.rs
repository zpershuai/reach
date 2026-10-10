use reach_rpc::{workspace::WorkspaceFilesystem, FsEditParams};
use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct RecordingAllocator;
static RECORDING: AtomicBool = AtomicBool::new(false);
static LARGEST: AtomicUsize = AtomicUsize::new(0);

fn record(size: usize) {
    if RECORDING.load(Ordering::Relaxed) {
        LARGEST.fetch_max(size, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for RecordingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout);
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        System.realloc(pointer, layout, size)
    }
}

#[global_allocator]
static ALLOCATOR: RecordingAllocator = RecordingAllocator;

#[test]
fn oversized_edit_is_rejected_before_allocating_the_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("input.txt");
    let original = "a".repeat(6000);
    std::fs::write(&path, &original).unwrap();
    let workspace = WorkspaceFilesystem::new(HashMap::from([(
        "fixture".into(),
        directory.path().to_path_buf(),
    )]));
    let params = FsEditParams {
        workspace: "fixture".into(),
        path: "input.txt".into(),
        old_string: "a".into(),
        new_string: "x".repeat(2000),
        replace_all: true,
        if_match: None,
    };
    RECORDING.store(true, Ordering::Relaxed);
    let result = workspace.edit(&params);
    RECORDING.store(false, Ordering::Relaxed);
    assert_eq!(result.unwrap_err().code, "FILE_TOO_LARGE");
    assert!(
        LARGEST.load(Ordering::Relaxed) <= 8 * 1024 * 1024,
        "oversized replacement was allocated before rejection"
    );
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}
