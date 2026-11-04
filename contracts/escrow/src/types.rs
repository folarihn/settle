use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

/// How a milestone is accepted. Mirrors `MilestoneTerms` in `packages/domain`, keeping
/// only what settlement needs onchain; full plans and rubrics stay offchain, bound by hash.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum MilestoneKind {
    /// Paid after a PASS report from the agreed verifier for exactly this plan.
    Automated { plan_hash: String },
    /// Paid on client approval, a mutual settlement, or a bounded resolver ruling.
    /// `floor` is the minimum a ruling may award once a deliverable was submitted (0 = none).
    HumanReview { max_revisions: u8, floor: U128 },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MilestoneTerms {
    pub id: String,
    pub amount: U128,
    pub kind: MilestoneKind,
}

/// Everything both parties agree to before funding. The onchain terms hash is
/// sha256 over the borsh encoding of this struct; `offchain_terms_hash` binds the
/// full offchain document (plans, rubric) computed by `packages/domain`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgreementTerms {
    pub agreement_id: String,
    pub offchain_terms_hash: String,
    pub client: AccountId,
    pub worker: AccountId,
    pub verifier: AccountId,
    /// Raw ed25519 public key (64 lowercase hex chars) that signs verification reports.
    pub verifier_public_key: String,
    pub resolver: AccountId,
    pub total: U128,
    pub milestones: Vec<MilestoneTerms>,
    pub challenge_period_ms: u64,
    pub funding_deadline_ms: u64,
    pub expires_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgreementStatus {
    Draft,
    Funded,
    Completed,
    /// An open bounty: funded, waiting for a worker to claim it. Appended after the
    /// original variants so agreements stored before bounties existed still decode.
    Open,
    /// An open bounty the client withdrew before anyone claimed it; the deposit was refunded.
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MilestoneStatus {
    Pending,
    Submitted,
    VerifiedPendingChallenge,
    RevisionRequested,
    Disputed,
    Claimable,
    PayoutPending,
    Paid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Pass,
    Fail,
    Inconclusive,
    RunnerError,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Submission {
    /// Assigned by the contract (1, 2, ...) so ids can never be reused.
    pub seq: u32,
    pub artifact_hash: String,
    pub submitted_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Proposal {
    pub proposer: AccountId,
    pub worker_amount: U128,
}

/// One recipient's share of an allocated milestone. `due + pending + paid` never changes
/// once allocated; a transfer moves due -> pending -> paid, or pending -> due on failure.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Share {
    pub due: U128,
    pub pending: U128,
    pub paid: U128,
}

impl Share {
    pub fn total(&self) -> u128 {
        self.due.0 + self.pending.0 + self.paid.0
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recipient {
    Worker,
    Client,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MilestoneState {
    pub status: MilestoneStatus,
    pub submission: Option<Submission>,
    pub submission_count: u32,
    pub revisions_used: u8,
    pub challenge_ends_at_ms: Option<u64>,
    pub last_outcome: Option<Outcome>,
    pub last_report_nonce: Option<String>,
    pub proposal: Option<Proposal>,
    /// Set exactly once, when the milestone becomes Claimable.
    pub allocated: bool,
    pub worker: Share,
    pub client: Share,
}

impl Default for MilestoneState {
    fn default() -> Self {
        Self {
            status: MilestoneStatus::Pending,
            submission: None,
            submission_count: 0,
            revisions_used: 0,
            challenge_ends_at_ms: None,
            last_outcome: None,
            last_report_nonce: None,
            proposal: None,
            allocated: false,
            worker: Share::default(),
            client: Share::default(),
        }
    }
}

impl MilestoneState {
    pub fn share_mut(&mut self, r: Recipient) -> &mut Share {
        match r {
            Recipient::Worker => &mut self.worker,
            Recipient::Client => &mut self.client,
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Agreement {
    pub terms: AgreementTerms,
    pub terms_hash: String,
    pub status: AgreementStatus,
    pub accepted_by_worker: bool,
    pub funded_at_ms: Option<u64>,
    pub milestones: Vec<MilestoneState>,
}

/// What the verifier attests to. Bound to agreement, milestone, submission seq,
/// artifact and plan, and authenticated by the verifier's ed25519 signature over
/// `borsh((REPORT_SIGNING_TAG, contract_account_id, report))`. Field order is part of
/// that format and must match `reportSigningBytes` in packages/domain.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct VerificationReport {
    pub agreement_id: String,
    pub milestone_id: String,
    pub submission_seq: u32,
    pub artifact_hash: String,
    pub plan_hash: String,
    pub outcome: Outcome,
    pub evidence_digest: String,
    pub nonce: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}
