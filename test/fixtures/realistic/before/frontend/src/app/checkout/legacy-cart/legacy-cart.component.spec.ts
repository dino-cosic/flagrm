import { TestBed } from '@angular/core/testing';
import { LegacyCartComponent } from './legacy-cart.component';

describe('LegacyCartComponent', () => {
  it('renders one row per item', () => {
    const fixture = TestBed.createComponent(LegacyCartComponent);
    fixture.componentRef.setInput('items', [
      { sku: 'a', quantity: 1, unitPrice: 2 },
      { sku: 'b', quantity: 3, unitPrice: 4 },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('tr').length).toBe(2);
  });
});
