use near_sdk::env;

/// Panics with `CODE: message`. Codes match `DomainErrorCode` in packages/domain so
/// clients can handle onchain and offchain rejections the same way.
pub fn fail(code: &str, msg: &str) -> ! {
    env::panic_str(&format!("{code}: {msg}"))
}

pub fn ensure(cond: bool, code: &str, msg: &str) {
    if !cond {
        fail(code, msg)
    }
}
