import { useEffect, useState } from "react";
import { api, yoctoToNear, type Job } from "./api";

export function JobList() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ jobs: Job[] }>("GET", "/v1/jobs").then(
      (r) => setJobs(r.jobs),
      (e: Error) => setError(e.message),
    );
  }, []);

  return (
    <section className="card">
      <div className="row">
        <h2>Your agreements</h2>
        <span className="spacer" />
        <a className="button" href="#/new">
          Create agreement
        </a>
      </div>
      {error && <p className="error">{error}</p>}
      {jobs?.length === 0 && <p className="muted">No agreements yet. Create one as the client, or ask a client to name your account as the worker. Agreements where you are the resolver also appear here.</p>}
      {jobs && jobs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Your role</th>
              <th>Status</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id}>
                <td>
                  <a href={`#/jobs/${j.id}`}>{j.id}</a>
                </td>
                <td>{j.roles.join(", ")}</td>
                <td>{j.state.status}</td>
                <td>{yoctoToNear(j.state.terms.totalYocto)} NEAR</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
