import { Injectable } from '@angular/core';
import { CartItem, OrderResult } from './models';

@Injectable({ providedIn: 'root' })
export class CheckoutApi {
  async placeOrder(items: CartItem[]): Promise<OrderResult> {
    const response = await fetch('/api/checkout/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: items }),
    });
    return (await response.json()) as OrderResult;
  }

  async applyPromo(items: CartItem[], code: string): Promise<void> {
    await fetch(`/api/checkout/promo?code=${encodeURIComponent(code)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines: items }),
    });
  }
}
