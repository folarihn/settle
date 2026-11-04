use crate::error::{ensure, fail};
use crate::types::{AgreementTerms, MilestoneKind, VerificationReport};

pub const MAX_MILESTONES: usize = 10;
pub const MAX_REVISIONS: u8 = 10;
pub const MAX_SUBMISSIONS_PER_MILESTONE: u32 = 20;
pub const MIN_CHALLENGE_MS: u64 = 60_000;
pub const MAX_CHALLENGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_HASH_LEN: usize = 200;

/// Decodes exactly N bytes of lowercase hex.
pub fn decode_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

pub fn is_sha256_digest(s: &str) -> bool {
    s.len() == 71
        && s.starts_with("sha256:")
        && s[7..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_slug(s: &str, min: usize, max: usize, allow_upper_and_underscore: bool) -> bool {
    (min..=max).contains(&s.len())
        && s.bytes().all(|b| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || b == b'-'
                || (allow_upper_and_underscore && (b.is_ascii_uppercase() || b == b'_'))
        })
}

pub fn validate_artifact_hash(s: &str) {
    ensure(
        !s.is_empty() && s.len() <= MAX_ARTIFACT_HASH_LEN && s.is_ascii(),
        "VALIDATION",
        "artifact hash must be 1-200 ASCII characters",
    );
}

/// Same rules as `AgreementTerms` in packages/domain, restricted to onchain fields.
pub fn validate_terms(t: &AgreementTerms, now_ms: u64) {
    ensure(is_slug(&t.agreement_id, 8, 64, true), "VALIDATION", "agreement id must be 8-64 url-safe characters");
    ensure(is_sha256_digest(&t.offchain_terms_hash), "VALIDATION", "offchain terms hash must be sha256:<64 hex>");

    ensure(
        decode_hex::<32>(&t.verifier_public_key).is_some(),
        "VALIDATION",
        "verifier public key must be 64 lowercase hex characters",
    );
    ensure(t.client != t.worker, "VALIDATION", "client and worker must be different accounts");
    for (role, account) in [("verifier", &t.verifier), ("resolver", &t.resolver)] {
        ensure(
            account != &t.client && account != &t.worker,
            "VALIDATION",
            &format!("{role} must be independent of client and worker"),
        );
    }

    ensure(
        (MIN_CHALLENGE_MS..=MAX_CHALLENGE_MS).contains(&t.challenge_period_ms),
        "VALIDATION",
        "challenge period must be between 1 minute and 30 days",
    );
    ensure(t.funding_deadline_ms > now_ms, "DEADLINE", "funding deadline must be in the future");
    ensure(t.expires_at_ms > t.funding_deadline_ms, "VALIDATION", "expiry must be after the funding deadline");

    ensure((1..=MAX_MILESTONES).contains(&t.milestones.len()), "VALIDATION", "an agreement needs 1-10 milestones");
    let mut sum: u128 = 0;
    for (i, m) in t.milestones.iter().enumerate() {
        ensure(is_slug(&m.id, 1, 64, false), "VALIDATION", "milestone id must be a lowercase slug");
        ensure(
            !t.milestones[..i].iter().any(|o| o.id == m.id),
            "VALIDATION",
            &format!("duplicate milestone id '{}'", m.id),
        );
        ensure(m.amount.0 > 0, "VALIDATION", "milestone amount must be positive");
        sum = sum.checked_add(m.amount.0).unwrap_or_else(|| fail("ACCOUNTING", "milestone amounts overflow"));
        match &m.kind {
            MilestoneKind::Automated { plan_hash } => {
                ensure(is_sha256_digest(plan_hash), "VALIDATION", "plan hash must be sha256:<64 hex>")
            }
            MilestoneKind::HumanReview { max_revisions, floor } => {
                ensure(*max_revisions <= MAX_REVISIONS, "VALIDATION", "at most 10 revisions");
                ensure(floor.0 <= m.amount.0, "VALIDATION", "floor cannot exceed milestone amount");
            }
        }
    }
    ensure(sum == t.total.0, "ACCOUNTING", &format!("milestone amounts sum to {sum} but total is {}", t.total.0));
}

pub fn validate_report_shape(r: &VerificationReport) {
    ensure(
        is_sha256_digest(&r.evidence_digest) && is_sha256_digest(&r.plan_hash),
        "VALIDATION",
        "report digests must be sha256:<64 hex>",
    );
    ensure(
        (16..=128).contains(&r.nonce.len()) && r.nonce.is_ascii(),
        "VALIDATION",
        "nonce must be 16-128 ASCII characters",
    );
    validate_artifact_hash(&r.artifact_hash);
}
