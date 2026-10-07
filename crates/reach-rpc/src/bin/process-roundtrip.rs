use reach_rpc::{parse_request_envelope, process_contract::*};
use serde_json::{json, Value};
fn convert(schema: &str, input: &Value) -> Result<Value, String> {
    macro_rules! parsed {
        ($type:ty) => {
            serde_json::to_value(<$type>::parse(input).map_err(|e| e.code)?)
                .map_err(|e| e.to_string())
        };
    }
    macro_rules! result {
        ($type:ty) => {
            serde_json::from_value::<$type>(input.clone())
                .and_then(serde_json::to_value)
                .map_err(|e| e.to_string())
        };
    }
    match schema {
        "process.run" => parsed!(RunParams),
        "process.status" => parsed!(StatusParams),
        "process.stop" => parsed!(StopParams),
        "process.logs" => parsed!(LogsParams),
        "process.list" => parsed!(ListParams),
        "task" => result!(TaskStatus),
        "logs" => result!(ProcessLogsResult),
        "list" => result!(ProcessListResult),
        "envelope" => serde_json::to_value(
            parse_request_envelope(&input.to_string()).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string()),
        _ => Err("unknown schema".into()),
    }
}
fn main() {
    let path = std::env::args().nth(1).expect("fixture path");
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let output: Vec<Value> = cases
        .iter()
        .map(
            |case| match convert(case["schema"].as_str().unwrap(), &case["input"]) {
                Ok(payload) => {
                    assert_eq!(case["valid"], true, "unexpected acceptance: {case}");
                    assert_eq!(payload, case["expected"]);
                    json!({"valid":true,"payload":payload})
                }
                Err(_) => {
                    assert_eq!(case["valid"], false, "unexpected rejection: {case}");
                    json!({"valid":false})
                }
            },
        )
        .collect();
    println!("{}", json!(output));
}
