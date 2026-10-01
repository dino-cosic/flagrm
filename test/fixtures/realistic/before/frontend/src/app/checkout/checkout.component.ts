import { NgIf } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FeatureFlagService } from '../core/feature-flag.service';
import { FLAGS } from '../core/feature-flags';
import { CheckoutApi } from './checkout-api.service';
import { CheckoutStepsComponent } from './checkout-steps.component';
import { LegacyCartComponent } from './legacy-cart/legacy-cart.component';
import { LegacyCartService } from './legacy-cart/legacy-cart.service';
import { CartItem, OrderResult } from './models';

@Component({
  selector: 'app-checkout',
  imports: [NgIf, CheckoutStepsComponent, LegacyCartComponent],
  templateUrl: './checkout.component.html',
})
export class CheckoutComponent {
  private readonly ff = inject(FeatureFlagService);
  private readonly api = inject(CheckoutApi);
  private readonly legacyCart = inject(LegacyCartService);

  readonly items = signal<CartItem[]>([]);
  readonly promoCode = signal('');
  readonly newCheckout = this.ff.watch(FLAGS.newCheckout);
  readonly expressShipping = this.ff.watch(FLAGS.expressShipping);
  readonly cartEmpty = computed(() => this.items().length === 0);
  readonly title = computed(() => (this.newCheckout() ? 'Checkout' : 'Your cart'));

  submit(): Promise<OrderResult> {
    if (this.ff.isEnabled(FLAGS.newCheckout))
      return this.api.placeOrder(this.items());
    return this.legacyCart.submit(this.items());
  }

  applyPromo(): Promise<void> {
    return this.api.applyPromo(this.items(), this.promoCode());
  }
}
