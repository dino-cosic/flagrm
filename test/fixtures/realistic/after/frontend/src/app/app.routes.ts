import { Routes } from '@angular/router';
import { CheckoutComponent } from './checkout/checkout.component';

export const routes: Routes = [
  { path: 'checkout', component: CheckoutComponent },
  { path: 'cart', redirectTo: 'checkout' },
  { path: '', pathMatch: 'full', redirectTo: 'checkout' },
];
