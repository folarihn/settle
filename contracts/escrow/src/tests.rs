use std::panic::{catch_unwind, AssertUnwindSafe};

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult};

use super::*;

const NEAR: u128 = 10u128.pow(24);
const API: u128 = 35 * NEAR / 100;
const DESIGN: u128 = 15 * NEAR / 100;
const FLOOR: u128 = 75 * NEAR / 1000;
const TOTAL: u128 = API + DESIGN;
const T0: u64 = 1_800_000_000_000;
const HOUR: u64 = 3_600_000;
const DAY: u64 = 24 * HOUR;
const ID: &str = "job_demo_0001";
const STORAGE: u128 = NEAR / 10;

const CONTRACT: &str = "settle-escrow.testnet";

// Same fixed test seeds as packages/domain/test/fixtures.ts.
const VERIFIER_SEED: [u8; 32] = [0x11; 32];
const OTHER_SEED: [u8; 32] = [0x22; 32];

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sign(r: &VerificationReport, seed: [u8; 32]) -> String {
    hex(&SigningKey::from_bytes(&seed).sign(&report_signing_bytes(r)).to_bytes())
}
const CLIENT: &str = "client.testnet";
const WORKER: &str = "worker.testnet";
const VERIFIER: &str = "verifier.testnet";
const RESOLVER: &str = "resolver.testnet";

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn digest(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

fn builder(caller: &str, deposit: u128, now_ms: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(caller))
        .signer_account_id(acc(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(now_ms * 1_000_000)
        .account_balance(NearToken::from_near(100));
    b
}

/// Sets caller, attached deposit and block time for the next call.
fn as_(caller: &str, deposit: u128, now_ms: u64) {
    testing_env!(builder(caller, deposit, now_ms).build());
}

/// Asserts the call panics with the given error code. Every checked path fails
/// before mutating state, so the contract can be reused afterwards.
fn expect_err(code: &str, f: impl FnOnce()) {
    let err = catch_unwind(AssertUnwindSafe(f)).expect_err(&format!("expected {code} but call succeeded"));
    let msg = err
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(msg.contains(&format!("{code}:")), "expected {code}, got: {msg}");
}

fn terms() -> AgreementTerms {
    AgreementTerms {
        agreement_id: ID.into(),
        offchain_terms_hash: digest('0'),
        client: acc(CLIENT),
        worker: acc(WORKER),
        verifier: acc(VERIFIER),
        verifier_public_key: hex(SigningKey::from_bytes(&VERIFIER_SEED).verifying_key().as_bytes()),
        resolver: acc(RESOLVER),
        total: U128(TOTAL),
        milestones: vec![
            MilestoneTerms {
                id: "api".into(),
                amount: U128(API),
                kind: MilestoneKind::Automated { plan_hash: digest('a') },
            },
            MilestoneTerms {
                id: "design".into(),
                amount: U128(DESIGN),
                kind: MilestoneKind::HumanReview { max_revisions: 2, floor: U128(FLOOR) },
            },
        ],
        challenge_period_ms: HOUR,
        funding_deadline_ms: T0 + DAY,
        expires_at_ms: T0 + 14 * DAY,
    }
}

fn created() -> (Escrow, String) {
    as_(CLIENT, STORAGE, T0);
    let mut c = Escrow::default();
    let hash = c.create_agreement(terms());
    (c, hash)
}

fn funded() -> Escrow {
    let (mut c, hash) = created();
    as_(WORKER, 0, T0 + 1);
    c.accept_terms(ID.into(), hash.clone());
    as_(CLIENT, TOTAL, T0 + 2);
    c.fund(ID.into(), hash);
    c
}

fn ms(c: &Escrow, id: &str) -> MilestoneState {
    let a = c.get_agreement(ID.into()).unwrap();
    let i = a.terms.milestones.iter().position(|m| m.id == id).unwrap();
    a.milestones[i].clone()
}

fn submit(c: &mut Escrow, milestone: &str, artifact: &str, now: u64) -> u32 {
    as_(WORKER, 0, now);
    c.submit(ID.into(), milestone.into(), artifact.into())
}

fn report(c: &Escrow, outcome: Outcome, nonce: &str) -> VerificationReport {
    let sub = ms(c, "api").submission.expect("api milestone has a submission");
    VerificationReport {
        agreement_id: ID.into(),
        milestone_id: "api".into(),
        submission_seq: sub.seq,
        artifact_hash: sub.artifact_hash,
        plan_hash: digest('a'),
        outcome,
        evidence_digest: digest('e'),
        nonce: nonce.into(),
        issued_at_ms: sub.submitted_at_ms,
        expires_at_ms: T0 + 30 * DAY,
    }
}

/// Signs with the agreed verifier key and relays as the worker: the signature, not the caller, is the authority.
fn verify(c: &mut Escrow, r: VerificationReport, now: u64) {
    as_(WORKER, 0, now);
    let signature = sign(&r, VERIFIER_SEED);
    c.record_verification(r, signature);
}

fn verify_with(c: &mut Escrow, outcome: Outcome, nonce: &str, now: u64) {
    let r = report(c, outcome, nonce);
    verify(c, r, now);
}

/// Simulates the transfer receipt finishing and NEAR invoking our callback.
fn callback(c: &mut Escrow, milestone: &str, recipient: Recipient, amount: u128, ok: bool) -> bool {
    testing_env!(
        builder(CONTRACT, 0, T0 + 20 * DAY).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed }],
    );
    c.on_transfer(ID.into(), milestone.into(), recipient, U128(amount))
}

/// API milestone verified PASS and past its challenge window.
fn api_claimable() -> Escrow {
    let mut c = funded();
    submit(&mut c, "api", "commit-good", T0 + 10);
    verify_with(&mut c, Outcome::Pass, "nonce-pass-0000001", T0 + 11);
    as_(WORKER, 0, T0 + 11 + HOUR);
    c.finalize_challenge(ID.into(), "api".into());
    c
}

// ---- creation and funding ----------------------------------------------------------------

#[test]
fn rejects_invalid_terms() {
    let cases: Vec<(&str, Box<dyn Fn(&mut AgreementTerms)>)> = vec![
        ("ACCOUNTING", Box::new(|t| t.total = U128(1))),
        ("VALIDATION", Box::new(|t| t.worker = acc(CLIENT))),
        ("VALIDATION", Box::new(|t| t.verifier = acc(WORKER))),
        ("VALIDATION", Box::new(|t| t.resolver = acc(CLIENT))),
        ("VALIDATION", Box::new(|t| t.milestones[1].id = "api".into())),
        ("VALIDATION", Box::new(|t| t.milestones[0].kind = MilestoneKind::Automated { plan_hash: "abc".into() })),
        (
            "VALIDATION",
            Box::new(|t| {
                t.milestones[1].kind = MilestoneKind::HumanReview { max_revisions: 1, floor: U128(DESIGN + 1) }
            }),
        ),
        ("VALIDATION", Box::new(|t| t.challenge_period_ms = 1)),
        ("DEADLINE", Box::new(|t| t.funding_deadline_ms = T0)),
        ("VALIDATION", Box::new(|t| t.expires_at_ms = t.funding_deadline_ms)),
    ];
    for (code, mutate) in cases {
        let mut t = terms();
        mutate(&mut t);
        as_(CLIENT, STORAGE, T0);
        let mut c = Escrow::default();
        expect_err(code, || {
            c.create_agreement(t);
        });
    }
}

#[test]
fn only_the_named_client_creates_and_storage_must_be_prepaid() {
    as_(WORKER, STORAGE, T0);
    let mut c = Escrow::default();
    expect_err("UNAUTHORIZED", || {
        c.create_agreement(terms());
    });
    as_(CLIENT, 1, T0);
    let mut c = Escrow::default();
    expect_err("STORAGE", || {
        c.create_agreement(terms());
    });
}

#[test]
fn terms_hash_is_deterministic_and_covers_amounts() {
    let (c, hash) = created();
    assert_eq!(c.compute_terms_hash(terms()), hash);
    let mut changed = terms();
    changed.milestones[0].amount = U128(API - 1);
    changed.milestones[1].amount = U128(DESIGN + 1);
    assert_ne!(c.compute_terms_hash(changed), hash);
}

#[test]
fn funding_requires_worker_acceptance_exact_amount_and_deadline() {
    let (mut c, hash) = created();
    as_(CLIENT, TOTAL, T0 + 1);
    expect_err("INVALID_TRANSITION", || c.fund(ID.into(), hash.clone()));

    as_(CLIENT, 0, T0 + 1);
    expect_err("UNAUTHORIZED", || c.accept_terms(ID.into(), hash.clone()));
    as_(WORKER, 0, T0 + 1);
    expect_err("HASH_MISMATCH", || c.accept_terms(ID.into(), digest('9')));
    c.accept_terms(ID.into(), hash.clone());

    for amount in [TOTAL - 1, TOTAL + 1] {
        as_(CLIENT, amount, T0 + 2);
        expect_err("ACCOUNTING", || c.fund(ID.into(), hash.clone()));
    }
    as_(CLIENT, TOTAL, T0 + 2);
    expect_err("HASH_MISMATCH", || c.fund(ID.into(), digest('9')));
    as_(WORKER, TOTAL, T0 + 2);
    expect_err("UNAUTHORIZED", || c.fund(ID.into(), hash.clone()));
    as_(CLIENT, TOTAL, T0 + 2 * DAY);
    expect_err("DEADLINE", || c.fund(ID.into(), hash.clone()));

    as_(CLIENT, TOTAL, T0 + 2);
    c.fund(ID.into(), hash.clone());
    assert_eq!(c.get_total_held(), U128(TOTAL));
    expect_err("TERMS_LOCKED", || c.fund(ID.into(), hash.clone()));
    as_(WORKER, 0, T0 + 3);
    expect_err("TERMS_LOCKED", || c.accept_terms(ID.into(), hash));
}

#[test]
fn milestone_actions_need_a_funded_agreement() {
    let (mut c, _) = created();
    as_(WORKER, 0, T0 + 1);
    expect_err("INVALID_TRANSITION", || {
        c.submit(ID.into(), "api".into(), "commit".into());
    });
}

// ---- automated milestone ------------------------------------------------------------------

#[test]
fn fail_pays_nothing_and_pass_pays_exactly_after_the_challenge_window() {
    let mut c = funded();
    submit(&mut c, "api", "commit-bad", T0 + 10);
    verify_with(&mut c, Outcome::Fail, "nonce-fail-0000001", T0 + 11);
    let m = ms(&c, "api");
    assert_eq!((m.status, m.allocated, m.submission), (MilestoneStatus::Pending, false, None));

    let seq = submit(&mut c, "api", "commit-good", T0 + 20);
    assert_eq!(seq, 2);
    verify_with(&mut c, Outcome::Pass, "nonce-pass-0000001", T0 + 21);
    assert_eq!(ms(&c, "api").status, MilestoneStatus::VerifiedPendingChallenge);

    as_(WORKER, 0, T0 + 21 + HOUR - 1);
    expect_err("DEADLINE", || c.finalize_challenge(ID.into(), "api".into()));
    as_(RESOLVER, 0, T0 + 21 + HOUR);
    expect_err("UNAUTHORIZED", || c.finalize_challenge(ID.into(), "api".into()));
    as_(WORKER, 0, T0 + 21 + HOUR);
    c.finalize_challenge(ID.into(), "api".into());
    let m = ms(&c, "api");
    assert_eq!((m.status, m.worker.due, m.client.due), (MilestoneStatus::Claimable, U128(API), U128(0)));
}

#[test]
fn inconclusive_and_runner_error_fail_closed() {
    let mut c = funded();
    submit(&mut c, "api", "commit-1", T0 + 10);
    verify_with(&mut c, Outcome::Inconclusive, "nonce-inconclusive-01", T0 + 11);
    verify_with(&mut c, Outcome::RunnerError, "nonce-runner-error-01", T0 + 12);
    let m = ms(&c, "api");
    assert_eq!((m.status, m.allocated), (MilestoneStatus::Submitted, false));
    expect_err("REPLAY", || verify_with(&mut c, Outcome::Pass, "nonce-runner-error-01", T0 + 13));
    verify_with(&mut c, Outcome::Pass, "nonce-pass-0000001", T0 + 13);
    assert_eq!(ms(&c, "api").status, MilestoneStatus::VerifiedPendingChallenge);
}

#[test]
fn rejects_reports_not_bound_to_the_live_submission_and_plan() {
    let mut c = funded();
    submit(&mut c, "api", "commit-bad", T0 + 10);
    let stale = report(&c, Outcome::Pass, "nonce-stale-000001");
    verify_with(&mut c, Outcome::Fail, "nonce-fail-0000001", T0 + 11);
    submit(&mut c, "api", "commit-good", T0 + 12);

    // A PASS issued for the earlier submission cannot pay the new one.
    expect_err("BINDING_MISMATCH", || verify(&mut c, stale.clone(), T0 + 13));
    let good = report(&c, Outcome::Pass, "nonce-pass-0000001");
    for bad in [
        VerificationReport { artifact_hash: "commit-other".into(), ..good.clone() },
        VerificationReport { plan_hash: digest('b'), ..good.clone() },
        VerificationReport { issued_at_ms: T0, ..good.clone() },
    ] {
        expect_err("BINDING_MISMATCH", || verify(&mut c, bad, T0 + 13));
    }
    expect_err("DEADLINE", || verify(&mut c, good.clone(), T0 + 31 * DAY));
    expect_err("NOT_FOUND", || {
        verify(&mut c, VerificationReport { agreement_id: "job_other_0001".into(), ..good.clone() }, T0 + 13)
    });
}

#[test]
fn rejects_reports_without_a_valid_verifier_signature() {
    let mut c = funded();
    submit(&mut c, "api", "commit-1", T0 + 10);
    let good = report(&c, Outcome::Fail, "nonce-fail-0000001");
    as_(WORKER, 0, T0 + 11);

    let worker_signed = sign(&good, OTHER_SEED);
    expect_err("INVALID_SIGNATURE", || c.record_verification(good.clone(), worker_signed));
    let tampered = VerificationReport { outcome: Outcome::Pass, ..good.clone() };
    expect_err("INVALID_SIGNATURE", || c.record_verification(tampered, sign(&good, VERIFIER_SEED)));
    expect_err("INVALID_SIGNATURE", || c.record_verification(good.clone(), "zz".repeat(64)));

    // Signed for another escrow deployment: the contract account is part of the signed bytes.
    let foreign = {
        let mut b = builder(WORKER, 0, T0 + 11);
        b.current_account_id(acc("other-escrow.testnet"));
        testing_env!(b.build());
        sign(&good, VERIFIER_SEED)
    };
    as_(WORKER, 0, T0 + 11);
    expect_err("INVALID_SIGNATURE", || c.record_verification(good.clone(), foreign));

    let sig = sign(&good, VERIFIER_SEED);
    c.record_verification(good, sig);
    assert_eq!(ms(&c, "api").status, MilestoneStatus::Pending);
}

/// Pinned vector shared with packages/domain/test/automated.test.ts. The TypeScript
/// signer produced this signature; verifying it here proves both sides sign identical bytes.
#[test]
fn signing_vector_matches_domain() {
    as_(WORKER, 0, T0);
    let r = VerificationReport {
        agreement_id: "job_demo_0001".into(),
        milestone_id: "api".into(),
        submission_seq: 2,
        artifact_hash: "commit-good".into(),
        plan_hash: digest('a'),
        outcome: Outcome::Pass,
        evidence_digest: digest('e'),
        nonce: "nonce-vector-000001".into(),
        issued_at_ms: 1_800_000_000_000,
        expires_at_ms: 1_802_592_000_000,
    };
    let public_key = "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
    let signature = "1baab16ab1bc2c385d624804c1a8abc0b67205e03953edeb9e625f03f4a4d948ec86154406aba6dbdee58960994cb5ba2835d6d620a6185029ad775c81b8e403";
    assert_eq!(hex(SigningKey::from_bytes(&VERIFIER_SEED).verifying_key().as_bytes()), public_key);
    assert!(verify_report_signature(&r, signature, public_key));
    assert_eq!(sign(&r, VERIFIER_SEED), signature);
}

#[test]
fn client_can_challenge_a_pass_only_inside_the_window() {
    let mut c = funded();
    submit(&mut c, "api", "commit-1", T0 + 10);
    verify_with(&mut c, Outcome::Pass, "nonce-pass-0000001", T0 + 11);
    as_(CLIENT, 0, T0 + 11 + HOUR);
    expect_err("DEADLINE", || c.challenge(ID.into(), "api".into(), "late".into()));
    as_(CLIENT, 0, T0 + 12);
    c.challenge(ID.into(), "api".into(), "returns stale data".into());
    assert_eq!(ms(&c, "api").status, MilestoneStatus::Disputed);

    as_(CLIENT, 0, T0 + 13);
    expect_err("UNAUTHORIZED", || c.resolve_dispute(ID.into(), "api".into(), U128(0)));
    as_(RESOLVER, 0, T0 + 13);
    c.resolve_dispute(ID.into(), "api".into(), U128(API));
    assert_eq!(ms(&c, "api").worker.due, U128(API));
}

// ---- payout -------------------------------------------------------------------------------

#[test]
fn payout_is_single_flight_and_a_failed_transfer_is_recoverable() {
    let mut c = api_claimable();
    as_(WORKER, 0, T0 + 2 * DAY);
    c.payout(ID.into(), "api".into());
    let m = ms(&c, "api");
    assert_eq!((m.status, m.worker.pending), (MilestoneStatus::PayoutPending, U128(API)));
    expect_err("INVALID_TRANSITION", || {
        c.payout(ID.into(), "api".into());
    });

    assert!(!callback(&mut c, "api", Recipient::Worker, API, false));
    let m = ms(&c, "api");
    assert_eq!((m.status, m.worker.due, m.worker.paid), (MilestoneStatus::Claimable, U128(API), U128(0)));
    assert_eq!(c.get_total_held(), U128(TOTAL));

    as_(CLIENT, 0, T0 + 3 * DAY);
    c.payout(ID.into(), "api".into());
    assert!(callback(&mut c, "api", Recipient::Worker, API, true));
    let m = ms(&c, "api");
    assert_eq!((m.status, m.worker.paid), (MilestoneStatus::Paid, U128(API)));
    assert_eq!(c.get_total_held(), U128(DESIGN));

    as_(WORKER, 0, T0 + 3 * DAY);
    expect_err("INVALID_TRANSITION", || {
        c.payout(ID.into(), "api".into());
    });
}

#[test]
fn only_parties_can_trigger_payout_and_only_the_contract_can_confirm_it() {
    let mut c = api_claimable();
    as_(VERIFIER, 0, T0 + 2 * DAY);
    expect_err("UNAUTHORIZED", || {
        c.payout(ID.into(), "api".into());
    });
    as_(WORKER, 0, T0 + 2 * DAY);
    c.payout(ID.into(), "api".into());
    as_(WORKER, 0, T0 + 2 * DAY);
    let forged =
        catch_unwind(AssertUnwindSafe(|| c.on_transfer(ID.into(), "api".into(), Recipient::Worker, U128(API))));
    assert!(forged.is_err(), "on_transfer must be private");
}

// ---- human-review milestone ---------------------------------------------------------------

#[test]
fn revisions_keep_funds_locked_until_approval() {
    let mut c = funded();
    submit(&mut c, "design", "design-v1", T0 + 10);
    as_(CLIENT, 0, T0 + 11);
    c.request_revision(ID.into(), "design".into(), "increase contrast".into());
    as_(WORKER, 0, T0 + 12);
    expect_err("INVALID_TRANSITION", || {
        c.payout(ID.into(), "design".into());
    });
    expect_err("UNAUTHORIZED", || c.approve(ID.into(), "design".into()));

    submit(&mut c, "design", "design-v2", T0 + 13);
    as_(CLIENT, 0, T0 + 14);
    c.request_revision(ID.into(), "design".into(), "one more".into());
    submit(&mut c, "design", "design-v3", T0 + 15);
    as_(CLIENT, 0, T0 + 16);
    expect_err("INVALID_TRANSITION", || c.request_revision(ID.into(), "design".into(), "again".into()));
    c.approve(ID.into(), "design".into());
    assert_eq!(ms(&c, "design").worker.due, U128(DESIGN));
}

#[test]
fn mutual_partial_settlement_pays_both_sides_and_survives_a_one_sided_failure() {
    let mut c = funded();
    submit(&mut c, "design", "design-v1", T0 + 10);
    let half = U128(DESIGN / 2);
    as_(WORKER, 0, T0 + 11);
    c.propose_settlement(ID.into(), "design".into(), half);
    expect_err("UNAUTHORIZED", || c.accept_settlement(ID.into(), "design".into(), half));
    as_(CLIENT, 0, T0 + 12);
    expect_err("BINDING_MISMATCH", || c.accept_settlement(ID.into(), "design".into(), U128(DESIGN)));
    c.accept_settlement(ID.into(), "design".into(), half);
    let m = ms(&c, "design");
    assert_eq!((m.worker.due, m.client.due), (half, U128(DESIGN - half.0)));

    as_(CLIENT, 0, T0 + 13);
    c.payout(ID.into(), "design".into());
    assert!(callback(&mut c, "design", Recipient::Worker, half.0, true));
    assert_eq!(ms(&c, "design").status, MilestoneStatus::PayoutPending);
    assert!(!callback(&mut c, "design", Recipient::Client, DESIGN - half.0, false));
    let m = ms(&c, "design");
    assert_eq!((m.status, m.worker.paid, m.client.due), (MilestoneStatus::Claimable, half, U128(DESIGN - half.0)));

    // Retrying sends only the client refund; the worker cannot be paid twice.
    as_(CLIENT, 0, T0 + 14);
    c.payout(ID.into(), "design".into());
    let m = ms(&c, "design");
    assert_eq!((m.worker.pending, m.client.pending), (U128(0), U128(DESIGN - half.0)));
    assert!(callback(&mut c, "design", Recipient::Client, DESIGN - half.0, true));
    assert_eq!(ms(&c, "design").status, MilestoneStatus::Paid);
}

#[test]
fn dispute_rulings_stay_within_the_floor_and_do_not_touch_earned_milestones() {
    let mut c = api_claimable();
    submit(&mut c, "design", "design-v1", T0 + 2 * DAY);
    as_(CLIENT, 0, T0 + 2 * DAY + 1);
    c.open_dispute(ID.into(), "design".into(), "does not match the brief".into());

    as_(RESOLVER, 0, T0 + 2 * DAY + 2);
    expect_err("ACCOUNTING", || c.resolve_dispute(ID.into(), "design".into(), U128(FLOOR - 1)));
    expect_err("ACCOUNTING", || c.resolve_dispute(ID.into(), "design".into(), U128(DESIGN + 1)));
    c.resolve_dispute(ID.into(), "design".into(), U128(FLOOR));
    assert_eq!(ms(&c, "api").worker.due, U128(API));

    for (id, worker_amount, client_amount) in [("api", API, 0), ("design", FLOOR, DESIGN - FLOOR)] {
        as_(WORKER, 0, T0 + 3 * DAY);
        c.payout(ID.into(), id.into());
        callback(&mut c, id, Recipient::Worker, worker_amount, true);
        if client_amount > 0 {
            callback(&mut c, id, Recipient::Client, client_amount, true);
        }
    }
    let a = c.get_agreement(ID.into()).unwrap();
    assert_eq!(a.status, AgreementStatus::Completed);
    assert_eq!(c.get_total_held(), U128(0));
}

#[test]
fn human_review_actions_are_rejected_on_automated_milestones() {
    let mut c = funded();
    submit(&mut c, "api", "commit-1", T0 + 10);
    as_(CLIENT, 0, T0 + 11);
    expect_err("INVALID_TRANSITION", || c.approve(ID.into(), "api".into()));
    expect_err("INVALID_TRANSITION", || c.open_dispute(ID.into(), "api".into(), "x".into()));
}

// ---- expiry -------------------------------------------------------------------------------

#[test]
fn expiry_refunds_unstarted_work_but_never_expires_submitted_work() {
    let mut c = funded();
    submit(&mut c, "design", "design-v1", T0 + 10);
    as_(CLIENT, 0, T0 + 13 * DAY);
    expect_err("DEADLINE", || c.expire_milestone(ID.into(), "api".into()));

    as_(CLIENT, 0, T0 + 14 * DAY);
    c.expire_milestone(ID.into(), "api".into());
    let m = ms(&c, "api");
    assert_eq!((m.worker.due, m.client.due), (U128(0), U128(API)));
    expect_err("INVALID_TRANSITION", || c.expire_milestone(ID.into(), "design".into()));
    as_(WORKER, 0, T0 + 14 * DAY);
    expect_err("DEADLINE", || {
        c.submit(ID.into(), "design".into(), "late".into());
    });
}

// ---- storage ------------------------------------------------------------------------------

#[test]
fn prepaid_storage_covers_worst_case_growth() {
    let mut c = funded();
    let size = |c: &Escrow| near_sdk::borsh::to_vec(&c.get_agreement(ID.into()).unwrap()).unwrap().len() as u64;
    let before = size(&c);
    let long_artifact = "x".repeat(200);
    submit(&mut c, "api", &long_artifact, T0 + 10);
    verify_with(&mut c, Outcome::Pass, &"n".repeat(128), T0 + 11);
    submit(&mut c, "design", &long_artifact, T0 + 12);
    as_(WORKER, 0, T0 + 13);
    c.propose_settlement(ID.into(), "design".into(), U128(DESIGN));
    let grown = size(&c) - before;
    assert!(grown <= GROWTH_BYTES_PER_MILESTONE * 2, "grew {grown} bytes");
}

/// Pinned vector shared with packages/domain/test/contract.test.ts: the API's TypeScript
/// port of this hash must agree byte for byte, or it would mis-detect onchain terms.
#[test]
fn terms_hash_vector_matches_domain() {
    as_(CLIENT, 0, T0);
    let c = Escrow::default();
    assert_eq!(
        c.compute_terms_hash(terms()),
        "sha256:c6457601cba9b243067f750272d1ef45c7d542584d30f9fe968dc4dfd44f751f"
    );
}
