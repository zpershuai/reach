use super::*;

impl ProcessManager {
    pub fn logs(&self, value: &Value) -> Result<Value> {
        let p = LogsParams::parse(value)?;
        let max = p.max_bytes.unwrap_or(16 * 1024);
        let t = self
            .find(&p.process_id)?
            .task
            .lock()
            .map_err(|_| error("PROCESS_CLEANUP_FAILED"))?;
        let prefix = format!("{}:{}:", self.scope, p.process_id);
        let (cursor, mut offset) = match p.cursor {
            None => (0, 0),
            Some(c) => c
                .strip_prefix(&prefix)
                .and_then(|s| s.split_once(':'))
                .and_then(|(sequence, offset)| {
                    Some((sequence.parse::<u64>().ok()?, offset.parse::<usize>().ok()?))
                })
                .filter(|(sequence, _)| *sequence <= t.sequence)
                .ok_or_else(|| error("INVALID_CURSOR"))?,
        };
        let first = t.output.front().map(|r| r.sequence).unwrap_or(t.sequence);
        let mut next = cursor.max(first);
        if cursor < first {
            offset = 0;
        }
        if next == t.sequence && offset != 0 {
            return Err(error("INVALID_CURSOR"));
        }
        let mut bytes = 0;
        let mut records = vec![];
        for record in t
            .output
            .iter()
            .filter(|record| record.sequence >= cursor.max(first))
        {
            if offset > record.text.len() || !record.text.is_char_boundary(offset) {
                return Err(error("INVALID_CURSOR"));
            }
            let available = &record.text[offset..];
            let mut end = available.len().min(max - bytes);
            while !available.is_char_boundary(end) {
                end -= 1;
            }
            if end == 0 && !available.is_empty() {
                if records.is_empty() {
                    return Err(error("INVALID_PARAMS"));
                }
                break;
            }
            records.push(LogRecord {
                sequence: record.sequence,
                stream: record.stream.clone(),
                text: available[..end].into(),
            });
            bytes += end;
            if end < available.len() {
                next = record.sequence;
                offset += end;
                break;
            }
            next = record.sequence + 1;
            offset = 0;
            if bytes == max {
                break;
            }
        }
        Ok(
            json!({"records":records,"nextCursor":format!("{prefix}{next}:{offset}"),"truncated":cursor<first,"eof":t.pipes==0&&next>=t.sequence}),
        )
    }
}
fn append_output(task: &Arc<Mutex<Task>>, stream: &'static str, text: String, cap: usize) {
    if text.is_empty() {
        return;
    }
    let Ok(mut t) = task.lock() else {
        return;
    };
    let sequence = t.sequence;
    t.sequence += 1;
    t.bytes += text.len();
    t.output.push_back(LogRecord {
        sequence,
        stream: stream.into(),
        text,
    });
    while t.bytes > cap {
        if let Some(record) = t.output.pop_front() {
            t.bytes -= record.text.len();
        } else {
            break;
        }
    }
}
pub(super) fn collect<R: Read + Send + 'static>(
    mut pipe: R,
    task: Arc<Mutex<Task>>,
    stream: &'static str,
    cap: usize,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buffer = [0u8; 1024];
        let mut pending = Vec::new();
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buffer[..n]);
                    loop {
                        match std::str::from_utf8(&pending) {
                            Ok(text) => {
                                append_output(&task, stream, text.into(), cap);
                                pending.clear();
                                break;
                            }
                            Err(error) => {
                                let valid = error.valid_up_to();
                                if valid > 0 {
                                    append_output(
                                        &task,
                                        stream,
                                        String::from_utf8(pending.drain(..valid).collect())
                                            .unwrap(),
                                        cap,
                                    );
                                }
                                if let Some(length) = error.error_len() {
                                    pending.drain(..length);
                                    append_output(&task, stream, "\u{fffd}".into(), cap);
                                } else {
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        append_output(
            &task,
            stream,
            String::from_utf8_lossy(&pending).into_owned(),
            cap,
        );
        if let Ok(mut task) = task.lock() {
            task.pipes = task.pipes.saturating_sub(1);
        }
    })
}
