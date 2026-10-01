import { Component, input } from '@angular/core';
import { CartItem } from '../models';

@Component({
  selector: 'app-legacy-cart',
  template: `
    <table class="legacy-cart">
      @for (item of items(); track item.sku) {
        <tr>
          <td>{{ item.sku }}</td>
          <td>{{ item.quantity }} × {{ item.unitPrice }}</td>
        </tr>
      }
    </table>
  `,
})
export class LegacyCartComponent {
  readonly items = input<CartItem[]>([]);
}
