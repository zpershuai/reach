//! Check the release executable's container and CPU before executing it.

pub fn verify(bytes: &[u8], os: &str, arch: &str) -> Result<(), &'static str> {
    let u16_at = |offset| {
        bytes
            .get(offset..offset + 2)
            .map(|value| u16::from_le_bytes(value.try_into().unwrap()))
    };
    let u32_at = |offset| {
        bytes
            .get(offset..offset + 4)
            .map(|value| u32::from_le_bytes(value.try_into().unwrap()))
    };
    let u64_at = |offset| {
        bytes
            .get(offset..offset + 8)
            .map(|value| u64::from_le_bytes(value.try_into().unwrap()))
    };
    let within = |offset: u64, size: u64| {
        offset
            .checked_add(size)
            .is_some_and(|end| end <= bytes.len() as u64)
    };
    let invalid = "Executable platform, architecture or format mismatch";
    if os == "linux" {
        let cpu = match arch {
            "x86_64" | "x64" => 62,
            "aarch64" | "arm64" => 183,
            _ => return Err(invalid),
        };
        if bytes.len() < 64
            || bytes.get(..7) != Some(b"\x7fELF\x02\x01\x01")
            || !matches!(u16_at(16), Some(2 | 3))
            || u16_at(18) != Some(cpu)
            || u32_at(20) != Some(1)
            || u16_at(52) != Some(64)
            || u16_at(54) != Some(56)
        {
            return Err(invalid);
        }
        let rows = u16_at(56).ok_or(invalid)? as u64;
        let table = u64_at(32).ok_or(invalid)?;
        if !(1..=4096).contains(&rows) || !within(table, rows * 56) {
            return Err(invalid);
        }
        let entry = u64_at(24).ok_or(invalid)?;
        let mut executable = false;
        for row in 0..rows {
            let position = (table + row * 56) as usize;
            let offset = u64_at(position + 8).ok_or(invalid)?;
            let size = u64_at(position + 32).ok_or(invalid)?;
            if !within(offset, size) {
                return Err(invalid);
            }
            let address = u64_at(position + 16).ok_or(invalid)?;
            let memory = u64_at(position + 40).ok_or(invalid)?;
            executable |= u32_at(position) == Some(1)
                && u32_at(position + 4).unwrap_or(0) & 1 != 0
                && memory >= size
                && address <= entry
                && address.checked_add(memory).is_some_and(|end| entry < end);
        }
        return if executable { Ok(()) } else { Err(invalid) };
    }
    let cpu = match (os, arch) {
        ("macos" | "darwin", "x86_64" | "x64") => 0x01000007,
        ("macos" | "darwin", "aarch64" | "arm64") => 0x0100000c,
        _ => return Err(invalid),
    };
    if bytes.len() < 32
        || bytes.get(..4) != Some(b"\xcf\xfa\xed\xfe")
        || u32_at(4) != Some(cpu)
        || u32_at(12) != Some(2)
    {
        return Err(invalid);
    }
    let commands = u32_at(16).ok_or(invalid)?;
    let size = u32_at(20).ok_or(invalid)? as u64;
    if !(1..=4096).contains(&commands) || !within(32, size) {
        return Err(invalid);
    }
    let mut position = 32usize;
    let mut executable = false;
    for _ in 0..commands {
        if position as u64 + 8 > 32 + size {
            return Err(invalid);
        }
        let command = u32_at(position).ok_or(invalid)?;
        let length = u32_at(position + 4).ok_or(invalid)? as usize;
        if length < 8 || position as u64 + length as u64 > 32 + size {
            return Err(invalid);
        }
        if command == 0x19 {
            if length < 72 {
                return Err(invalid);
            }
            let offset = u64_at(position + 40).ok_or(invalid)?;
            let count = u64_at(position + 48).ok_or(invalid)?;
            if !within(offset, count) {
                return Err(invalid);
            }
            executable |= u32_at(position + 60).unwrap_or(0) & 4 != 0 && count > 0;
        }
        position += length;
    }
    if position as u64 == 32 + size && executable {
        Ok(())
    } else {
        Err(invalid)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn shared_executable_identity_matrix() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/executable-identity.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let bytes: Vec<_> = case["hex"]
                .as_str()
                .unwrap()
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect();
            let (os, arch) = case["target"].as_str().unwrap().split_once('-').unwrap();
            assert_eq!(
                super::verify(&bytes, os, arch).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["id"]
            );
        }
    }
}
