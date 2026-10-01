import { AsyncPipe, NgIf } from '@angular/common';
import { Component, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { FeatureFlagService } from '../core/feature-flag.service';
import { FLAGS } from '../core/feature-flags';

@Component({
  selector: 'app-header',
  imports: [AsyncPipe, NgIf, RouterLink],
  template: `
    <nav>
      <a routerLink="/">Shop</a>
      <ng-container *ngIf="newCheckout$ | async; else legacyLink">
        <a routerLink="/checkout">Checkout</a>
      </ng-container>
      <ng-template #legacyLink>
        <a routerLink="/cart">Cart</a>
      </ng-template>
    </nav>
  `,
})
export class HeaderComponent {
  private readonly ff = inject(FeatureFlagService);

  readonly newCheckout$ = toObservable(this.ff.watch(FLAGS.newCheckout));
}
