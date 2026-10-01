import { TestBed } from '@angular/core/testing';
import { FeatureFlagService } from '../core/feature-flag.service';
import { FLAGS } from '../core/feature-flags';
import { CheckoutApi } from './checkout-api.service';
import { CheckoutComponent } from './checkout.component';
import { LegacyCartService } from './legacy-cart/legacy-cart.service';

describe('CheckoutComponent', () => {
  let ff: FeatureFlagService;
  let api: jasmine.SpyObj<CheckoutApi>;
  let legacyCart: jasmine.SpyObj<LegacyCartService>;

  beforeEach(() => {
    api = jasmine.createSpyObj<CheckoutApi>('CheckoutApi', ['placeOrder', 'applyPromo']);
    legacyCart = jasmine.createSpyObj<LegacyCartService>('LegacyCartService', ['submit']);
    TestBed.configureTestingModule({
      imports: [CheckoutComponent],
      providers: [
        { provide: CheckoutApi, useValue: api },
        { provide: LegacyCartService, useValue: legacyCart },
      ],
    });
    ff = TestBed.inject(FeatureFlagService);
  });

  it('places the order through the checkout API when NewCheckout is on', async () => {
    spyOn(ff, 'isEnabled').withArgs(FLAGS.newCheckout).and.returnValue(true);
    api.placeOrder.and.resolveTo({ id: 'o-1', flow: 'v2' });

    await TestBed.createComponent(CheckoutComponent).componentInstance.submit();

    expect(api.placeOrder).toHaveBeenCalled();
    expect(legacyCart.submit).not.toHaveBeenCalled();
  });

  it('falls back to the legacy cart when NewCheckout is off', async () => {
    spyOn(ff, 'isEnabled').and.returnValue(false);
    legacyCart.submit.and.resolveTo({ id: 'o-2', flow: 'legacy' });

    await TestBed.createComponent(CheckoutComponent).componentInstance.submit();

    expect(legacyCart.submit).toHaveBeenCalled();
  });

  it('shows the legacy title when the flag is off', () => {
    ff.override(FLAGS.newCheckout, false);
    const fixture = TestBed.createComponent(CheckoutComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('h1').textContent).toContain('Your cart');
  });

  it('passes express shipping to the checkout steps', () => {
    ff.override(FLAGS.expressShipping, true);
    const fixture = TestBed.createComponent(CheckoutComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Shipping: Express');
  });
});
