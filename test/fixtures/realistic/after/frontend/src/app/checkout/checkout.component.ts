import { Component, computed, inject, signal } from '@angular/core';
import { FeatureFlagService } from '../core/feature-flag.service';
import { FLAGS } from '../core/feature-flags';
import { CheckoutApi } from './checkout-api.service';
import { CheckoutStepsComponent } from './checkout-steps.component';
import { CartItem, OrderResult } from './models';

@Component({
  selector: 'app-checkout',
  imports: [CheckoutStepsComponent],
  templateUrl: './checkout.component.html',
})
export class CheckoutComponent {
  private readonly ff = inject(FeatureFlagService);
  private readonly api = inject(CheckoutApi);

  readonly items = signal<CartItem[]>([]);
  readonly promoCode = signal('');
  readonly expressShipping = this.ff.watch(FLAGS.expressShipping);
  readonly cartEmpty = computed(() => this.items().length === 0);

  submit(): Promise<OrderResult> {
    return this.api.placeOrder(this.items());
  }

  applyPromo(): Promise<void> {
    return this.api.applyPromo(this.items(), this.promoCode());
  }
}
