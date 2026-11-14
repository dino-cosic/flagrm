/**
 * Errors the CLI turns into exit codes. A {@link UsageError} is the user's to
 * fix (an option, the config, a missing baseline) and exits 2 with its message
 * alone; anything else thrown is unexpected, most likely a bug in flagrm, and
 * exits 4 with its stack trace so it can't be mistaken for a usage error.
 */

/** A problem with how flagrm was run (options, config, missing baseline) rather than with the code under check. */
export class UsageError extends Error {}
