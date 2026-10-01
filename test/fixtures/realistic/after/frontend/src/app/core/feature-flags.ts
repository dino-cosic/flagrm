/** Flag names, as served by the backend's FeatureManagement section. */
export const FLAGS = {
  expressShipping: 'ExpressShipping',
} as const;

export type FlagName = (typeof FLAGS)[keyof typeof FLAGS];
