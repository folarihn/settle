//! Integration tests against a real NEAR sandbox node running the compiled wasm.
//!
//! Unlike `src/tests.rs` (mocked blockchain), these deploy `target/near/settle_escrow.wasm`
//! and drive it with signed transactions, so promises, callbacks, gas, storage staking
//! and real balance changes are all exercised. Linux/macOS only (the sandbox binary has
//! no Windows build). See SANDBOX.md:
//!
//!     cargo near build non-reproducible-wasm
//!     cargo test --features sandbox --test sandbox -- --nocapture
//!
//! `SETTLE_ESCROW_WASM=/path/to.wasm` overrides the wasm location.

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use settle_escrow::{
    Agreement, AgreementStatus, AgreementTerms, MilestoneKind, MilestoneStatus, MilestoneTerms, Outcome,
    VerificationReport, REPORT_SIGNING_TAG,
};

type R<T = ()> = Result<T, Box<dyn std::error::Error>>;

const MILLI_NEAR: u128 = 10u128.pow(21);
const NEAR: u128 = 10u128.pow(24);
/// Generous storage prepayment; the contract refunds whatever it does not need.
const STORAGE: u128 = 100 * MILLI_NEAR;
/// Same gas the API/UI attaches to `payout` (PAYOUT_GAS in packages/domain/src/contract.ts).
const PAYOUT_GAS: Gas = Gas::from_tgas(60);
/// Gas for every other call: ample, but not max_gas, so pending refunds stay small.
const CALL_GAS: Gas = Gas::from_tgas(100);
const CHALLENGE_MS: u64 = 60_000; // contract minimum
/// Fixed, test-only verifier seed (same as src/tests.rs and packages/domain fixtures).
const VERIFIER_SEED: [u8; 32] = [0x11; 32];

struct Env {
    worker: Worker<Sandbox>,
    contract: Contract,
    client: Account,
    freelancer: Account,
    verifier: Account,
    resolver: Account,
    key: SigningKey,
}

fn wasm() -> Vec<u8> {
    let path = std::env::var("SETTLE_ESCROW_WASM")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/target/near/settle_escrow.wasm").to_string());
    std::fs::read(&path)
        .unwrap_or_else(|e| panic!("cannot read {path}: {e}. Run `cargo near build non-reproducible-wasm` first."))
}

async fn setup() -> R<Env> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&wasm()).await?;
    Ok(Env {
        client: worker.dev_create_account().await?,
        freelancer: worker.dev_create_account().await?,
        verifier: worker.dev_create_account().await?,
        resolver: worker.dev_create_account().await?,
        contract,
        worker,
        key: SigningKey::from_bytes(&VERIFIER_SEED),
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn digest(c: char) -> String {
    format!("sha256:{}", c.to_string().repeat(64))
}

async fn now_ms(env: &Env) -> R<u64> {
    Ok(env.worker.view_block().await?.timestamp() / 1_000_000)
}

/// Gas refunds are separate receipts that may land a block or two after `transact()`
/// returns. Wait a few real blocks so balance comparisons only see the payout itself.
async fn settle(env: &Env) -> R {
    let start = env.worker.view_block().await?.height();
    while env.worker.view_block().await?.height() < start + 3 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Ok(())
}

async fn balance(a: &Account) -> R<u128> {
    Ok(a.view_account().await?.balance.as_yoctonear())
}

fn terms(env: &Env, id: &str, now: u64, milestones: Vec<MilestoneTerms>) -> AgreementTerms {
    AgreementTerms {
        agreement_id: id.into(),
        offchain_terms_hash: digest('0'),
        client: env.client.id().clone(),
        worker: env.freelancer.id().clone(),
        verifier: env.verifier.id().clone(),
        verifier_public_key: hex(env.key.verifying_key().as_bytes()),
        resolver: env.resolver.id().clone(),
        total: U128(milestones.iter().map(|m| m.amount.0).sum()),
        milestones,
        challenge_period_ms: CHALLENGE_MS,
        funding_deadline_ms: now + 3_600_000,
        expires_at_ms: now + 14 * 24 * 3_600_000,
    }
}

/// Panics unless the call failed with the given contract error code.
fn assert_fails(res: ExecutionFinalResult, code: &str) {
    let err = res.into_result().expect_err(&format!("expected {code} but call succeeded"));
    let msg = format!("{err:?}");
    assert!(msg.contains(&format!("{code}:")), "expected {code}, got: {msg}");
}

async fn call(from: &Account, env: &Env, method: &str, args: serde_json::Value) -> R<ExecutionFinalResult> {
    Ok(from.call(env.contract.id(), method).args_json(args).gas(CALL_GAS).transact().await?)
}

async fn agreement(env: &Env, id: &str) -> R<Agreement> {
    let a: Option<Agreement> =
        env.contract.view("get_agreement").args_json(json!({ "agreement_id": id })).await?.json()?;
    Ok(a.expect("agreement exists"))
}

async fn total_held(env: &Env) -> R<u128> {
    let v: U128 = env.contract.view("get_total_held").await?.json()?;
    Ok(v.0)
}

/// create (client) -> accept (worker) -> fund (client, exact total). Returns the terms hash.
async fn create_and_fund(env: &Env, t: &AgreementTerms) -> R<String> {
    let res = env
        .client
        .call(env.contract.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .deposit(NearToken::from_yoctonear(STORAGE))
        .gas(CALL_GAS)
        .transact()
        .await?;
    let hash: String = res.into_result()?.json()?;
    let view_hash: String = env.contract.view("compute_terms_hash").args_json(json!({ "terms": t })).await?.json()?;
    assert_eq!(hash, view_hash);

    call(&env.freelancer, env, "accept_terms", json!({ "agreement_id": t.agreement_id, "terms_hash": hash }))
        .await?
        .into_result()?;
    env.client
        .call(env.contract.id(), "fund")
        .args_json(json!({ "agreement_id": t.agreement_id, "terms_hash": hash }))
        .deposit(NearToken::from_yoctonear(t.total.0))
        .gas(CALL_GAS)
        .transact()
        .await?
        .into_result()?;
    Ok(hash)
}

async fn submit(env: &Env, id: &str, milestone: &str, artifact: &str) -> R<u32> {
    let res = call(
        &env.freelancer,
        env,
        "submit",
        json!({ "agreement_id": id, "milestone_id": milestone, "artifact_hash": artifact }),
    )
    .await?;
    Ok(res.into_result()?.json()?)
}

/// Builds and signs a report exactly as the verifier service does:
/// ed25519 over borsh((REPORT_SIGNING_TAG, contract_account_id, report)).
async fn signed_report(
    env: &Env,
    id: &str,
    milestone: &str,
    seq: u32,
    artifact: &str,
    outcome: Outcome,
    nonce: &str,
) -> R<(VerificationReport, String)> {
    let now = now_ms(env).await?;
    let report = VerificationReport {
        agreement_id: id.into(),
        milestone_id: milestone.into(),
        submission_seq: seq,
        artifact_hash: artifact.into(),
        plan_hash: digest('a'),
        outcome,
        evidence_digest: digest('e'),
        nonce: nonce.into(),
        issued_at_ms: now,
        expires_at_ms: now + 3_600_000,
    };
    let bytes = near_sdk::borsh::to_vec(&(REPORT_SIGNING_TAG, env.contract.id().as_str(), &report))?;
    let sig = hex(&env.key.sign(&bytes).to_bytes());
    Ok((report, sig))
}

async fn payout(from: &Account, env: &Env, id: &str, milestone: &str) -> R<ExecutionFinalResult> {
    Ok(from
        .call(env.contract.id(), "payout")
        .args_json(json!({ "agreement_id": id, "milestone_id": milestone }))
        .gas(PAYOUT_GAS)
        .transact()
        .await?)
}

/// Fast-forwards the sandbox until its block timestamp is strictly past `target_ms`.
async fn advance_past(env: &Env, target_ms: u64) -> R {
    for _ in 0..30 {
        let now = now_ms(env).await?;
        if now > target_ms {
            return Ok(());
        }
        // Blocks are ~1s apart in the sandbox's genesis; overshoot a little and re-check.
        env.worker.fast_forward((target_ms - now) / 1000 + 5).await?;
    }
    Err(format!("sandbox clock did not pass {target_ms}").into())
}

#[tokio::test]
async fn automated_milestone_verify_challenge_finalize_payout() -> R {
    let env = setup().await?;
    let id = "sandbox_auto_0001";
    let amount = 2 * NEAR;
    let t = terms(
        &env,
        id,
        now_ms(&env).await?,
        vec![MilestoneTerms {
            id: "api".into(),
            amount: U128(amount),
            kind: MilestoneKind::Automated { plan_hash: digest('a') },
        }],
    );

    // Storage must be prepaid: 1 yoctoNEAR is not enough.
    let res = env
        .client
        .call(env.contract.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(CALL_GAS)
        .transact()
        .await?;
    assert_fails(res, "STORAGE");

    let res = env
        .client
        .call(env.contract.id(), "create_agreement")
        .args_json(json!({ "terms": t }))
        .deposit(NearToken::from_yoctonear(STORAGE))
        .gas(CALL_GAS)
        .transact()
        .await?;
    let hash: String = res.into_result()?.json()?;
    call(&env.freelancer, &env, "accept_terms", json!({ "agreement_id": id, "terms_hash": hash }))
        .await?
        .into_result()?;
    let res = env
        .client
        .call(env.contract.id(), "fund")
        .args_json(json!({ "agreement_id": id, "terms_hash": hash }))
        .deposit(NearToken::from_yoctonear(amount - 1))
        .gas(CALL_GAS)
        .transact()
        .await?;
    // Funding with anything but the exact total is rejected.
    assert_fails(res, "ACCOUNTING");
    assert_eq!(total_held(&env).await?, 0);
    env.client
        .call(env.contract.id(), "fund")
        .args_json(json!({ "agreement_id": id, "terms_hash": hash }))
        .deposit(NearToken::from_yoctonear(amount))
        .gas(CALL_GAS)
        .transact()
        .await?
        .into_result()?;
    assert_eq!(agreement(&env, id).await?.status, AgreementStatus::Funded);
    assert_eq!(total_held(&env).await?, amount);

    // First submission fails verification and goes back to Pending.
    let seq = submit(&env, id, "api", "git:aaaa").await?;
    assert_eq!(seq, 1);
    let (report, sig) = signed_report(&env, id, "api", seq, "git:aaaa", Outcome::Fail, "nonce-fail-0000001").await?;
    // Relayed by an unrelated account: the signature, not the caller, is what counts.
    call(&env.resolver, &env, "record_verification", json!({ "report": report, "signature": sig }))
        .await?
        .into_result()?;
    assert_eq!(agreement(&env, id).await?.milestones[0].status, MilestoneStatus::Pending);

    // A report signed by any other key is rejected.
    let seq = submit(&env, id, "api", "git:bbbb").await?;
    assert_eq!(seq, 2);
    let (report, _) = signed_report(&env, id, "api", seq, "git:bbbb", Outcome::Pass, "nonce-pass-0000002").await?;
    let bytes = near_sdk::borsh::to_vec(&(REPORT_SIGNING_TAG, env.contract.id().as_str(), &report))?;
    let forged = hex(&SigningKey::from_bytes(&[0x22; 32]).sign(&bytes).to_bytes());
    let res =
        call(&env.verifier, &env, "record_verification", json!({ "report": report, "signature": forged })).await?;
    assert_fails(res, "INVALID_SIGNATURE");

    // The genuine PASS opens the challenge window.
    let sig = hex(&env.key.sign(&bytes).to_bytes());
    call(&env.verifier, &env, "record_verification", json!({ "report": report, "signature": sig }))
        .await?
        .into_result()?;
    let m = agreement(&env, id).await?.milestones[0].clone();
    assert_eq!(m.status, MilestoneStatus::VerifiedPendingChallenge);
    let ends = m.challenge_ends_at_ms.expect("challenge end set");

    let res =
        call(&env.freelancer, &env, "finalize_challenge", json!({ "agreement_id": id, "milestone_id": "api" })).await?;
    assert_fails(res, "DEADLINE");

    advance_past(&env, ends).await?;
    call(&env.freelancer, &env, "finalize_challenge", json!({ "agreement_id": id, "milestone_id": "api" }))
        .await?
        .into_result()?;
    assert_eq!(agreement(&env, id).await?.milestones[0].status, MilestoneStatus::Claimable);

    // The client triggers payout, so the worker pays no gas and must gain exactly `amount`.
    settle(&env).await?;
    let before = balance(&env.freelancer).await?;
    let res = payout(&env.client, &env, id, "api").await?;
    settle(&env).await?;
    let logs: Vec<String> = res.logs().iter().map(|s| s.to_string()).collect();
    assert!(res.is_success(), "payout failed: {:?}", res.into_result().err());
    assert!(logs.iter().any(|l| l.contains("Worker") && l.contains("succeeded")), "logs: {logs:?}");
    assert_eq!(balance(&env.freelancer).await? - before, amount);

    let a = agreement(&env, id).await?;
    assert_eq!(a.milestones[0].status, MilestoneStatus::Paid);
    assert_eq!(a.milestones[0].worker.paid, U128(amount));
    assert_eq!(a.status, AgreementStatus::Completed);
    assert_eq!(total_held(&env).await?, 0);

    // A second payout cannot send the same funds again.
    let res = payout(&env.client, &env, id, "api").await?;
    assert_fails(res, "INVALID_TRANSITION");
    settle(&env).await?;
    assert_eq!(balance(&env.freelancer).await? - before, amount);
    Ok(())
}

#[tokio::test]
async fn human_review_approval_and_partial_settlement_pay_both_parties() -> R {
    let env = setup().await?;
    let id = "sandbox_human_0001";
    let (design, copy) = (NEAR, 2 * NEAR);
    let worker_share = 1_200 * MILLI_NEAR; // 60% of `copy`
    let client_share = copy - worker_share;
    let t = terms(
        &env,
        id,
        now_ms(&env).await?,
        vec![
            MilestoneTerms {
                id: "design".into(),
                amount: U128(design),
                kind: MilestoneKind::HumanReview { max_revisions: 1, floor: U128(0) },
            },
            MilestoneTerms {
                id: "copy".into(),
                amount: U128(copy),
                kind: MilestoneKind::HumanReview { max_revisions: 1, floor: U128(NEAR / 2) },
            },
        ],
    );
    create_and_fund(&env, &t).await?;
    assert_eq!(total_held(&env).await?, design + copy);

    // Milestone 1: submit -> client approves -> payout to the worker.
    submit(&env, id, "design", "ipfs:design-v1").await?;
    call(&env.client, &env, "approve", json!({ "agreement_id": id, "milestone_id": "design" })).await?.into_result()?;
    settle(&env).await?;
    let before = balance(&env.freelancer).await?;
    let res = payout(&env.client, &env, id, "design").await?;
    settle(&env).await?;
    assert!(res.is_success(), "payout failed: {:?}", res.into_result().err());
    assert_eq!(balance(&env.freelancer).await? - before, design);
    assert_eq!(total_held(&env).await?, copy);

    // Milestone 2: submit -> worker proposes 60/40 -> client accepts -> both shares paid.
    submit(&env, id, "copy", "ipfs:copy-v1").await?;
    let args = json!({ "agreement_id": id, "milestone_id": "copy", "worker_amount": U128(worker_share) });
    call(&env.freelancer, &env, "propose_settlement", args.clone()).await?.into_result()?;
    // The proposer cannot accept their own proposal.
    assert_fails(call(&env.freelancer, &env, "accept_settlement", args.clone()).await?, "UNAUTHORIZED");
    call(&env.client, &env, "accept_settlement", args).await?.into_result()?;
    let m = agreement(&env, id).await?.milestones[1].clone();
    assert_eq!(m.status, MilestoneStatus::Claimable);
    assert_eq!((m.worker.due.0, m.client.due.0), (worker_share, client_share));

    settle(&env).await?;
    let (w0, c0) = (balance(&env.freelancer).await?, balance(&env.client).await?);
    let res = payout(&env.client, &env, id, "copy").await?;
    settle(&env).await?;
    for o in res.receipt_outcomes() {
        eprintln!("payout receipt on {}: {} gas burnt", o.executor_id, o.gas_burnt);
    }
    let logs: Vec<String> = res.logs().iter().map(|s| s.to_string()).collect();
    assert!(res.is_success(), "payout failed: {:?}", res.into_result().err());
    assert_eq!(logs.iter().filter(|l| l.contains("succeeded")).count(), 2, "logs: {logs:?}");
    // Worker did not sign, so the increase is exact.
    assert_eq!(balance(&env.freelancer).await? - w0, worker_share);
    // Client signed the payout and paid its gas: gained its share minus well under 0.01 NEAR.
    let c1 = balance(&env.client).await?;
    assert!(c1 > c0 + client_share - 10 * MILLI_NEAR && c1 < c0 + client_share, "client {c0} -> {c1}");

    let a = agreement(&env, id).await?;
    assert!(a.milestones.iter().all(|m| m.status == MilestoneStatus::Paid));
    assert_eq!(a.milestones[1].worker.paid, U128(worker_share));
    assert_eq!(a.milestones[1].client.paid, U128(client_share));
    assert_eq!(a.status, AgreementStatus::Completed);
    assert_eq!(total_held(&env).await?, 0);
    Ok(())
}
