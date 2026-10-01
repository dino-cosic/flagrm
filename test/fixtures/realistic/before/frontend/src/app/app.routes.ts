import { inject } from '@angular/core';
import { Routes } from '@angular/router';
import { CheckoutComponent } from './checkout/checkout.component';
import { LegacyCartComponent } from './checkout/legacy-cart/legacy-cart.component';
import { FeatureFlagService } from './core/feature-flag.service';
import { FeatureFlag } from './core/feature-flags';

export const routes: Routes = [
  { path: 'checkout', component: CheckoutComponent },
  {
    path: 'cart',
    canMatch: [() => !inject(FeatureFlagService).isEnabled(FeatureFlag.NewCheckout)],
    component: LegacyCartComponent,
  },
  { path: 'cart', redirectTo: 'checkout' },
  { path: '', pathMatch: 'full', redirectTo: 'checkout' },
];
