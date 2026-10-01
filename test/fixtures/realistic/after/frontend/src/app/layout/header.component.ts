import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'app-header',
  imports: [RouterLink],
  template: `
    <nav>
      <a routerLink="/">Shop</a>
      <a routerLink="/checkout">Checkout</a>
    </nav>
  `,
})
export class HeaderComponent {}
