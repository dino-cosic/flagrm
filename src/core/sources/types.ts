/**
 * A flag service flagrm reads flags from, for `flagrm stale`. Read-only: a
 * source never writes to the service. LaunchDarkly is the only one today;
 * another service is a new file implementing {@link FlagSource}.
 */

/** What one environment serves: one value to every context, or something that depends on the context. */
export type Served =
  | { kind: "fixed"; value: unknown }
  | {
      kind: "targeted";
      /** Why, for the reasons flagrm prints: "2 rules", "a percentage rollout", ... */
      detail: string;
    };

export interface SourceEnvironment {
  serves: Served;
  /**
   * ISO 8601 UTC date since when the environment has served what `serves` says,
   * for `fixed` environments; absent for `targeted` ones.
   */
  since?: string;
  /** `audit`: the latest targeting change in the audit log; `lastModified`: the environment's last change of any kind. */
  sinceSource?: "audit" | "lastModified";
}

export interface SourceFlag {
  key: string;
  name: string;
  /** `boolean`, or the service's word for other flags (`multivariate`). */
  kind: string;
  /** Marked temporary (meant to be removed) in the service. */
  temporary: boolean;
  tags: string[];
  /** ISO 8601 UTC. */
  creationDate: string;
  /** Per checked environment key. */
  environments: Record<string, SourceEnvironment>;
  /** Set when the service returned data flagrm can't read; such a flag is never removed. */
  unrecognized?: string;
}

export interface SourceRead {
  /** The checked environment keys, in the service's order. */
  environments: string[];
  flags: SourceFlag[];
}

export interface FlagSource {
  /**
   * Every non-archived flag and what each checked environment serves. `since`
   * comes from the change history only for flags `wantsHistory` accepts (it is
   * slow); the others get the environment's last-modified date.
   */
  read(wantsHistory: (flag: SourceFlag) => boolean): Promise<SourceRead>;
}

/**
 * The service couldn't be asked: unreachable, timed out, rejected the token,
 * unknown project, rate limit retries used up. `flagrm stale` exits 3 on it.
 * Messages name the endpoint, never the token.
 */
export class SourceError extends Error {
  override name = "SourceError";
}
