import { useEffect, useState } from "react";
import { api, yoctoToNear, type Job } from "./api";

/** Open bounties: work already funded in escrow that any signed-in human or agent can claim. */
export function BountyBoard() {
  const [bounties, setBounties] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ bounties: Job[] }>("GET", "/v1/bounties").then(
      (r) => setBounties(r.bounties),
      (e: Error) => setError(e.message),
    );
  }, []);

  return (
    <section className="card">
      <div className="row">
        <h2>Open bounties</h2>
        <span className="spacer" />
        <a className="button" href="#/new">
          Post a bounty
        </a>
      </div>
      <p className="muted">The money is already in escrow. The first account to claim a bounty becomes its worker; the contract decides who was first.</p>
      {error && <p className="error">{error}</p>}
      {bounties?.length === 0 && <p className="muted">No open bounties right now.</p>}
      {bounties && bounties.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Work</th>
              <th>Client</th>
              <th>Pays</th>
              <th>Claim by</th>
            </tr>
          </thead>
          <tbody>
            {bounties.map((b) => (
              <tr key={b.id}>
                <td>
                  <a href={`#/jobs/${b.id}`}>{b.state.terms.milestones.map((m) => m.title).join(" · ")}</a>
                </td>
                <td className="mono">{b.state.terms.client.nearAccountId}</td>
                <td>{yoctoToNear(b.state.terms.totalYocto)} NEAR</td>
                <td>{new Date(b.state.terms.fundingDeadline).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
