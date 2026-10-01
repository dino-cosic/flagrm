/** Flag names, as served by the backend's FeatureManagement section. */
export const FLAGS = {
  newCheckout: 'NewCheckout',
  expressShipping: 'ExpressShipping',
} as const;

export type FlagName = (typeof FLAGS)[keyof typeof FLAGS];

/** @deprecated Use {@link FLAGS}. Still used by route guards. */
export enum FeatureFlag {
  NewCheckout = 'NewCheckout',
  ExpressShipping = 'ExpressShipping',
}
