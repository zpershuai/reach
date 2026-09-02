use reach_rpc::{parse_fs_read_request, serialize_request};
use std::{env, fs, process};

fn main() {
    let fixture = env::args()
        .nth(1)
        .unwrap_or_else(|| "fixtures/fs.read.request.json".to_owned());
    let input = fs::read_to_string(&fixture).unwrap_or_else(|error| {
        eprintln!("failed to read {fixture}: {error}");
        process::exit(1);
    });
    let request = parse_fs_read_request(&input).unwrap_or_else(|error| {
        eprintln!("failed to parse {fixture}: {error}");
        process::exit(1);
    });
    println!("{}", serialize_request(&request).expect("validated request serializes"));
}
