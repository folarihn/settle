//! SETTLE escrow: holds native NEAR (testnet) for a locked milestone agreement and
//! releases it only through the rules in docs/ARCHITECTURE.md. The state machine
//! mirrors `packages/domain`; this contract is the authority for money.

mod error;
mod types;
mod validate;

#[cfg(test)]
mod tests;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, BorshStorageKey, Gas, NearToken, Promise};

use error::{ensure, fail};
pub use types::*;
use validate::{
    decode_hex, validate_artifact_hash, validate_report_shape, validate_terms, MAX_SUBMISSIONS_PER_MILESTONE,
};

/// Domain separator for report signatures; see `reportSigningBytes` in packages/domain.
pub const REPORT_SIGNING_TAG: &str = "settle-report-v1";

/// Upper bound on how much one milestone's state can grow after creation
/// (submission, proposal, last nonce/outcome, challenge timestamp). The client
/// prepays this so later calls by any party never consume escrowed funds for storage.
pub const GROWTH_BYTES_PER_MILESTONE: u64 = 600;
const CALLBACK_GAS: Gas = Gas::from_tgas(5);
const MAX_REASON_LEN: usize = 2000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Agreements,
}

#[near(contract_state)]
pub struct Escrow {
    agreements: LookupMap<String, Agreement>,
    /// Escrowed yoctoNEAR not yet transferred out, across all agreements.
    total_held: u128,
}

impl Default for Escrow {
    fn default() -> Self {
        Self { agreements: LookupMap::new(StorageKey::Agreements), total_held: 0 }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Role {
    Client,
    Worker,
    Verifier,
    Resolver,
}

#[near]
impl Escrow {
    // ---- agreement lifecycle -----------------------------------------------------

    /// Client proposes terms and prepays storage. Creating counts as the client's
    /// acceptance of these exact terms. Returns the onchain terms hash the worker must accept.
    #[payable]
    pub fn create_agreement(&mut self, terms: AgreementTerms) -> String {
        ensure(
            env::predecessor_account_id() == terms.client,
            "UNAUTHORIZED",
            "only the client named in the terms can create the agreement",
        );
        validate_terms(&terms, env::block_timestamp_ms());
        ensure(!self.agreements.contains_key(&terms.agreement_id), "VALIDATION", "agreement id already exists");

        let terms_hash = terms_hash(&terms);
        let milestones = terms.milestones.len() as u64;
        let id = terms.agreement_id.clone();
        let before = env::storage_usage();
        self.agreements.insert(
            id,
            Agreement {
                milestones: (0..milestones).map(|_| MilestoneState::default()).collect(),
                terms,
                terms_hash: terms_hash.clone(),
                status: AgreementStatus::Draft,
                accepted_by_worker: false,
                funded_at_ms: None,
            },
        );
        self.agreements.flush();
        let bytes = env::storage_usage() - before + GROWTH_BYTES_PER_MILESTONE * milestones;
        let required = env::storage_byte_cost().as_yoctonear() * bytes as u128;
        let attached = env::attached_deposit().as_yoctonear();
        ensure(attached >= required, "STORAGE", &format!("attach at least {required} yoctoNEAR for storage"));
        if attached > required {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(attached - required))
                .detach();
        }
        terms_hash
    }

    pub fn accept_terms(&mut self, agreement_id: String, terms_hash: String) {
        let a = self.agreement_mut(&agreement_id);
        require_role(a, &[Role::Worker]);
        ensure(a.status == AgreementStatus::Draft, "TERMS_LOCKED", "agreement is already funded");
        ensure(a.terms_hash == terms_hash, "HASH_MISMATCH", "accepted hash does not match the terms");
        a.accepted_by_worker = true;
    }

    /// Client deposits exactly the agreed total. Terms are immutable from here on.
    #[payable]
    pub fn fund(&mut self, agreement_id: String, terms_hash: String) {
        let now = env::block_timestamp_ms();
        let attached = env::attached_deposit().as_yoctonear();
        let a = self.agreement_mut(&agreement_id);
        require_role(a, &[Role::Client]);
        ensure(a.status == AgreementStatus::Draft, "TERMS_LOCKED", "agreement is already funded");
        ensure(a.terms_hash == terms_hash, "HASH_MISMATCH", "funding references different terms");
        ensure(a.accepted_by_worker, "INVALID_TRANSITION", "the worker has not accepted the terms");
        ensure(now <= a.terms.funding_deadline_ms, "DEADLINE", "funding deadline has passed");
        ensure(
            attached == a.terms.total.0,
            "ACCOUNTING",
            &format!("attach exactly {} yoctoNEAR, got {attached}", a.terms.total.0),
        );
        a.status = AgreementStatus::Funded;
        a.funded_at_ms = Some(now);
        self.total_held += attached;
    }

    // ---- milestone transitions -----------------------------------------------------

    /// Returns the contract-assigned submission sequence number that reports must cite.
    pub fn submit(&mut self, agreement_id: String, milestone_id: String, artifact_hash: String) -> u32 {
        validate_artifact_hash(&artifact_hash);
        let now = env::block_timestamp_ms();
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Worker]);
            ensure(now < a.terms.expires_at_ms, "DEADLINE", "agreement has expired");
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::Pending, MilestoneStatus::RevisionRequested]);
            ensure(
                m.submission_count < MAX_SUBMISSIONS_PER_MILESTONE,
                "INVALID_TRANSITION",
                "submission limit reached",
            );
            m.submission_count += 1;
            m.submission = Some(Submission { seq: m.submission_count, artifact_hash, submitted_at_ms: now });
            m.status = MilestoneStatus::Submitted;
            m.submission_count
        })
    }

    /// Records a report signed by the agreed verifier key. Anyone may relay it, so the
    /// verifier never needs a NEAR account key and the relay cannot alter results.
    /// FAIL returns the milestone to Pending; INCONCLUSIVE and RUNNER_ERROR leave it
    /// Submitted. None of them releases funds.
    pub fn record_verification(&mut self, report: VerificationReport, signature: String) {
        validate_report_shape(&report);
        let now = env::block_timestamp_ms();
        let (agreement_id, milestone_id) = (report.agreement_id.clone(), report.milestone_id.clone());
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            ensure(
                verify_report_signature(&report, &signature, &a.terms.verifier_public_key),
                "INVALID_SIGNATURE",
                "report is not signed by the agreed verifier key",
            );
            let plan_hash = match &a.terms.milestones[i].kind {
                MilestoneKind::Automated { plan_hash } => plan_hash.clone(),
                _ => fail("INVALID_TRANSITION", "milestone is not automatically verified"),
            };
            let challenge_ms = a.terms.challenge_period_ms;
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::Submitted]);
            let sub = m.submission.as_ref().unwrap_or_else(|| fail("INVALID_TRANSITION", "no submission"));
            let mut mismatches = Vec::new();
            if report.submission_seq != sub.seq {
                mismatches.push("submission_seq");
            }
            if report.artifact_hash != sub.artifact_hash {
                mismatches.push("artifact_hash");
            }
            if report.plan_hash != plan_hash {
                mismatches.push("plan_hash");
            }
            ensure(
                mismatches.is_empty(),
                "BINDING_MISMATCH",
                &format!("report does not match: {}", mismatches.join(", ")),
            );
            ensure(
                m.last_report_nonce.as_deref() != Some(report.nonce.as_str()),
                "REPLAY",
                "report nonce already used",
            );
            ensure(report.issued_at_ms >= sub.submitted_at_ms, "BINDING_MISMATCH", "report predates the submission");
            ensure(now <= report.expires_at_ms, "DEADLINE", "report has expired");

            m.last_report_nonce = Some(report.nonce.clone());
            m.last_outcome = Some(report.outcome);
            match report.outcome {
                Outcome::Pass => {
                    m.status = MilestoneStatus::VerifiedPendingChallenge;
                    m.challenge_ends_at_ms = Some(now + challenge_ms);
                }
                Outcome::Fail => {
                    m.status = MilestoneStatus::Pending;
                    m.submission = None;
                }
                Outcome::Inconclusive | Outcome::RunnerError => {}
            }
        })
    }

    pub fn challenge(&mut self, agreement_id: String, milestone_id: String, reason: String) {
        check_reason(&reason);
        let now = env::block_timestamp_ms();
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client]);
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::VerifiedPendingChallenge]);
            ensure(now < m.challenge_ends_at_ms.unwrap_or(0), "DEADLINE", "challenge period has ended");
            m.status = MilestoneStatus::Disputed;
            m.challenge_ends_at_ms = None;
        })
    }

    pub fn finalize_challenge(&mut self, agreement_id: String, milestone_id: String) {
        let now = env::block_timestamp_ms();
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client, Role::Worker, Role::Verifier]);
            let amount = a.terms.milestones[i].amount.0;
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::VerifiedPendingChallenge]);
            ensure(now >= m.challenge_ends_at_ms.unwrap_or(u64::MAX), "DEADLINE", "challenge period has not ended");
            allocate(m, amount, amount);
        })
    }

    pub fn approve(&mut self, agreement_id: String, milestone_id: String) {
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client]);
            require_human_review(a, i);
            let amount = a.terms.milestones[i].amount.0;
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::Submitted]);
            allocate(m, amount, amount);
        })
    }

    pub fn request_revision(&mut self, agreement_id: String, milestone_id: String, feedback: String) {
        check_reason(&feedback);
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client]);
            let (max_revisions, _) = require_human_review(a, i);
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::Submitted]);
            ensure(
                m.revisions_used < max_revisions,
                "INVALID_TRANSITION",
                "all agreed revisions used; approve, settle or dispute",
            );
            m.revisions_used += 1;
            m.submission = None;
            m.status = MilestoneStatus::RevisionRequested;
        })
    }

    pub fn open_dispute(&mut self, agreement_id: String, milestone_id: String, reason: String) {
        check_reason(&reason);
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client, Role::Worker]);
            require_human_review(a, i);
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::Submitted, MilestoneStatus::RevisionRequested]);
            m.status = MilestoneStatus::Disputed;
        })
    }

    pub fn propose_settlement(&mut self, agreement_id: String, milestone_id: String, worker_amount: U128) {
        let caller = env::predecessor_account_id();
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client, Role::Worker]);
            require_human_review(a, i);
            let amount = a.terms.milestones[i].amount.0;
            ensure(worker_amount.0 <= amount, "ACCOUNTING", "worker share exceeds milestone amount");
            let m = &mut a.milestones[i];
            require_status(m, SETTLEABLE);
            m.proposal = Some(Proposal { proposer: caller, worker_amount });
        })
    }

    pub fn accept_settlement(&mut self, agreement_id: String, milestone_id: String, worker_amount: U128) {
        let caller = env::predecessor_account_id();
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client, Role::Worker]);
            require_human_review(a, i);
            let amount = a.terms.milestones[i].amount.0;
            let m = &mut a.milestones[i];
            require_status(m, SETTLEABLE);
            let p = m.proposal.clone().unwrap_or_else(|| fail("INVALID_TRANSITION", "no settlement proposal"));
            ensure(p.proposer != caller, "UNAUTHORIZED", "the other party must accept the settlement");
            ensure(p.worker_amount == worker_amount, "BINDING_MISMATCH", "amount differs from the proposal");
            allocate(m, amount, worker_amount.0);
        })
    }

    /// The resolver's award must lie between the protected floor (once a deliverable
    /// was submitted) and the milestone amount.
    pub fn resolve_dispute(&mut self, agreement_id: String, milestone_id: String, worker_amount: U128) {
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Resolver]);
            let terms = &a.terms.milestones[i];
            let amount = terms.amount.0;
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::Disputed]);
            let floor = match &terms.kind {
                MilestoneKind::HumanReview { floor, .. } if m.submission_count > 0 => floor.0,
                _ => 0,
            };
            ensure(worker_amount.0 >= floor, "ACCOUNTING", &format!("award below the agreed floor of {floor}"));
            ensure(worker_amount.0 <= amount, "ACCOUNTING", "award exceeds milestone amount");
            allocate(m, amount, worker_amount.0);
        })
    }

    /// After expiry, a milestone with no live submission refunds the client in full.
    /// Submitted work never expires; it must be reviewed, settled or disputed.
    pub fn expire_milestone(&mut self, agreement_id: String, milestone_id: String) {
        let now = env::block_timestamp_ms();
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client, Role::Worker]);
            ensure(now >= a.terms.expires_at_ms, "DEADLINE", "agreement has not expired");
            let amount = a.terms.milestones[i].amount.0;
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::Pending, MilestoneStatus::RevisionRequested]);
            allocate(m, amount, 0);
        })
    }

    // ---- payout ----------------------------------------------------------------------

    /// Sends every due share of a Claimable milestone. Each transfer has its own
    /// callback; while any is in flight the milestone is PayoutPending and cannot be paid again.
    pub fn payout(&mut self, agreement_id: String, milestone_id: String) -> Promise {
        let mut transfers: Vec<(Recipient, AccountId, u128)> = Vec::new();
        self.with_milestone(&agreement_id, &milestone_id, |a, i| {
            require_role(a, &[Role::Client, Role::Worker]);
            let (worker, client) = (a.terms.worker.clone(), a.terms.client.clone());
            let m = &mut a.milestones[i];
            require_status(m, &[MilestoneStatus::Claimable]);
            for (r, account) in [(Recipient::Worker, worker), (Recipient::Client, client)] {
                let s = m.share_mut(r);
                if s.due.0 > 0 {
                    transfers.push((r, account, s.due.0));
                    s.pending = s.due;
                    s.due = U128(0);
                }
            }
            ensure(!transfers.is_empty(), "INVALID_TRANSITION", "nothing due");
            m.status = MilestoneStatus::PayoutPending;
        });

        let mut promise: Option<Promise> = None;
        for (r, account, amount) in transfers {
            let p = Promise::new(account).transfer(NearToken::from_yoctonear(amount)).then(
                Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer(
                    agreement_id.clone(),
                    milestone_id.clone(),
                    r,
                    U128(amount),
                ),
            );
            promise = Some(match promise {
                Some(prev) => prev.and(p),
                None => p,
            });
        }
        promise.unwrap()
    }

    /// Transfer callback: success moves pending -> paid; failure moves pending -> due so
    /// the same share can be paid again. Must not panic, or funds would stay pending.
    #[private]
    pub fn on_transfer(
        &mut self,
        agreement_id: String,
        milestone_id: String,
        recipient: Recipient,
        amount: U128,
    ) -> bool {
        let ok = near_sdk::is_promise_success();
        let a = self.agreement_mut(&agreement_id);
        let i = milestone_index(a, &milestone_id);
        let m = &mut a.milestones[i];
        let s = m.share_mut(recipient);
        s.pending = U128(s.pending.0.saturating_sub(amount.0));
        if ok {
            s.paid = U128(s.paid.0 + amount.0);
        } else {
            s.due = U128(s.due.0 + amount.0);
        }
        if m.worker.pending.0 == 0 && m.client.pending.0 == 0 {
            m.status = if m.worker.due.0 == 0 && m.client.due.0 == 0 {
                MilestoneStatus::Paid
            } else {
                MilestoneStatus::Claimable
            };
        }
        if a.milestones.iter().all(|m| m.status == MilestoneStatus::Paid) {
            a.status = AgreementStatus::Completed;
        }
        if ok {
            self.total_held -= amount.0;
        }
        env::log_str(&format!(
            "payout {agreement_id}/{milestone_id} {recipient:?} {} {}",
            amount.0,
            if ok { "succeeded" } else { "failed; restored as due" }
        ));
        ok
    }

    // ---- views -----------------------------------------------------------------------

    pub fn get_agreement(&self, agreement_id: String) -> Option<Agreement> {
        self.agreements.get(&agreement_id).cloned()
    }

    pub fn compute_terms_hash(&self, terms: AgreementTerms) -> String {
        terms_hash(&terms)
    }

    pub fn get_total_held(&self) -> U128 {
        U128(self.total_held)
    }
}

// ---- helpers ---------------------------------------------------------------------------

const SETTLEABLE: &[MilestoneStatus] =
    &[MilestoneStatus::Submitted, MilestoneStatus::RevisionRequested, MilestoneStatus::Disputed];

impl Escrow {
    fn agreement_mut(&mut self, id: &str) -> &mut Agreement {
        self.agreements.get_mut(id).unwrap_or_else(|| fail("NOT_FOUND", "no such agreement"))
    }

    /// Runs a milestone transition on a funded agreement and checks accounting afterwards.
    fn with_milestone<R>(
        &mut self,
        agreement_id: &str,
        milestone_id: &str,
        f: impl FnOnce(&mut Agreement, usize) -> R,
    ) -> R {
        let a = self.agreement_mut(agreement_id);
        ensure(a.status == AgreementStatus::Funded, "INVALID_TRANSITION", "agreement is not funded");
        let i = milestone_index(a, milestone_id);
        let out = f(a, i);
        assert_reconciled(a);
        out
    }
}

pub(crate) fn report_signing_bytes(report: &VerificationReport) -> Vec<u8> {
    near_sdk::borsh::to_vec(&(REPORT_SIGNING_TAG, env::current_account_id().as_str(), report))
        .unwrap_or_else(|_| fail("VALIDATION", "cannot encode report"))
}

fn verify_report_signature(report: &VerificationReport, signature_hex: &str, public_key_hex: &str) -> bool {
    match (decode_hex::<64>(signature_hex), decode_hex::<32>(public_key_hex)) {
        (Some(sig), Some(pk)) => env::ed25519_verify(&sig, report_signing_bytes(report), &pk),
        _ => false,
    }
}

fn terms_hash(terms: &AgreementTerms) -> String {
    let bytes = near_sdk::borsh::to_vec(terms).unwrap_or_else(|_| fail("VALIDATION", "cannot encode terms"));
    let digest = env::sha256_array(&bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256:{hex}")
}

fn milestone_index(a: &Agreement, milestone_id: &str) -> usize {
    a.terms
        .milestones
        .iter()
        .position(|m| m.id == milestone_id)
        .unwrap_or_else(|| fail("NOT_FOUND", "no such milestone"))
}

fn require_role(a: &Agreement, allowed: &[Role]) -> Role {
    let caller = env::predecessor_account_id();
    let t = &a.terms;
    allowed
        .iter()
        .copied()
        .find(|r| {
            caller
                == *match r {
                    Role::Client => &t.client,
                    Role::Worker => &t.worker,
                    Role::Verifier => &t.verifier,
                    Role::Resolver => &t.resolver,
                }
        })
        .unwrap_or_else(|| fail("UNAUTHORIZED", "caller does not hold a role allowed to do this"))
}

fn require_status(m: &MilestoneState, allowed: &[MilestoneStatus]) {
    ensure(
        allowed.contains(&m.status),
        "INVALID_TRANSITION",
        &format!("milestone is {:?}; expected one of {allowed:?}", m.status),
    );
}

fn require_human_review(a: &Agreement, i: usize) -> (u8, u128) {
    match &a.terms.milestones[i].kind {
        MilestoneKind::HumanReview { max_revisions, floor } => (*max_revisions, floor.0),
        _ => fail("INVALID_TRANSITION", "milestone is not a human-review milestone"),
    }
}

fn check_reason(text: &str) {
    ensure(!text.trim().is_empty() && text.len() <= MAX_REASON_LEN, "VALIDATION", "text must be 1-2000 characters");
}

/// Fixes the split of a milestone exactly once.
fn allocate(m: &mut MilestoneState, amount: u128, worker_amount: u128) {
    ensure(!m.allocated, "ACCOUNTING", "milestone already allocated");
    ensure(worker_amount <= amount, "ACCOUNTING", "worker share exceeds milestone amount");
    m.allocated = true;
    m.worker = Share { due: U128(worker_amount), ..Share::default() };
    m.client = Share { due: U128(amount - worker_amount), ..Share::default() };
    m.status = MilestoneStatus::Claimable;
    m.proposal = None;
    m.challenge_ends_at_ms = None;
}

/// Every yoctoNEAR of a funded agreement is either locked in an unallocated milestone or
/// in exactly one of due/pending/paid for one recipient.
fn assert_reconciled(a: &Agreement) {
    for (terms, m) in a.terms.milestones.iter().zip(&a.milestones) {
        let settled =
            matches!(m.status, MilestoneStatus::Claimable | MilestoneStatus::PayoutPending | MilestoneStatus::Paid);
        ensure(settled == m.allocated, "ACCOUNTING", "allocation does not match milestone status");
        if m.allocated {
            ensure(
                m.worker.total() + m.client.total() == terms.amount.0,
                "ACCOUNTING",
                "milestone shares do not sum to its amount",
            );
        }
    }
}
