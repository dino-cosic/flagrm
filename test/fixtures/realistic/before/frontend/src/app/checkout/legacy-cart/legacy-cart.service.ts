import { Injectable } from '@angular/core';
import { CartItem, OrderResult } from '../models';

@Injectable({ providedIn: 'root' })
export class LegacyCartService {
  async submit(items: CartItem[]): Promise<OrderResult> {
    const response = await fetch('/api/cart/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    });
    return (await response.json()) as OrderResult;
  }
}
