import { TestBed } from '@angular/core/testing';
import { FeatureFlagService } from '../core/feature-flag.service';
import { FLAGS } from '../core/feature-flags';
import { CheckoutApi } from './checkout-api.service';
import { CheckoutComponent } from './checkout.component';

describe('CheckoutComponent', () => {
  let ff: FeatureFlagService;
  let api: jasmine.SpyObj<CheckoutApi>;

  beforeEach(() => {
    api = jasmine.createSpyObj<CheckoutApi>('CheckoutApi', ['placeOrder', 'applyPromo']);
    TestBed.configureTestingModule({
      imports: [CheckoutComponent],
      providers: [{ provide: CheckoutApi, useValue: api }],
    });
    ff = TestBed.inject(FeatureFlagService);
  });

  it('places the order through the checkout API', async () => {
    api.placeOrder.and.resolveTo({ id: 'o-1', flow: 'v2' });

    await TestBed.createComponent(CheckoutComponent).componentInstance.submit();

    expect(api.placeOrder).toHaveBeenCalled();
  });

  it('passes express shipping to the checkout steps', () => {
    ff.override(FLAGS.expressShipping, true);
    const fixture = TestBed.createComponent(CheckoutComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Shipping: Express');
  });
});
