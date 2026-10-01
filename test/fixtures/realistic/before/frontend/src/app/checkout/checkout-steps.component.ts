import { Component, computed, input } from '@angular/core';
import { CartItem } from './models';

@Component({
  selector: 'app-checkout-steps',
  template: `
    <ol class="steps">
      <li>Review {{ items().length }} item(s)</li>
      <li>Shipping: {{ express() ? 'Express' : 'Standard' }}</li>
      <li>Pay {{ total() }}</li>
    </ol>
  `,
})
export class CheckoutStepsComponent {
  readonly items = input.required<CartItem[]>();
  readonly express = input(false);

  readonly total = computed(() => this.items().reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
}
