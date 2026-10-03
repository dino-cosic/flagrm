/**
 * The words a flag's names are made of, to recognize a name that is about the
 * flag (`useVfo1Terminology`, `Save_Vfo1Enabled`) among ones that aren't.
 */

import type { RecordedName } from "./types.js";

/** Words that say nothing about which flag a name is about. */
const GENERIC = new Set(
  "feature features flag flags toggle key keys enabled disabled enable disable is has use get async on off the when with if and".split(
    " ",
  ),
);

/** Lowercase words of a name: `Vfo1FoundationEnabled_Saves` → vfo1, foundation, enabled, saves. */
export function words(name: string): string[] {
  return (name.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+[0-9]*|[A-Z]+[0-9]*|[0-9]+/g) ?? []).map((w) => w.toLowerCase());
}

/** Words of the flag's recorded names */
export function flagWords(names: Array<Pick<RecordedName, "name">>): Set<string> {
  return new Set(names.flatMap((n) => words(n.name)).filter((w) => !GENERIC.has(w)));
}

/** Whether `name` contains one of the flag's words. */
export function mentionsFlag(name: string, flag: Set<string>): boolean {
  return words(name).some((w) => flag.has(w));
}

/**
 * Whether `name` names this flag clearly enough to look for it in every file:
 * it contains all words of the flag's name in order (`IsNewCheckoutEnabledAsync`
 * for `NewCheckout`), or a flag word with a digit (`vfo1`), which ordinary
 * names don't have. One plain word (`express`, `checkout`) is not enough.
 * `flagNames` are the literal and the definitions' last segments.
 */
export function namesFlag(name: string, flagNames: string[], flag: Set<string>): boolean {
  const own = words(name);
  if (own.some((w) => flag.has(w) && /\d/.test(w) && /[a-z]/.test(w) && w.length >= 3)) return true;
  return flagNames.some((flagName) => {
    const seq = words(flagName).filter((w) => !GENERIC.has(w));
    if (seq.length < 2) return false;
    return own.some((_, i) => seq.every((w, j) => own[i + j] === w));
  });
}
