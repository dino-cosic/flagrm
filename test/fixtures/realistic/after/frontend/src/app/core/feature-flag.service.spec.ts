import { TestBed } from '@angular/core/testing';
import { FeatureFlagService } from './feature-flag.service';
import { FLAGS } from './feature-flags';

describe('FeatureFlagService', () => {
  let service: FeatureFlagService;

  beforeEach(() => {
    service = TestBed.inject(FeatureFlagService);
  });

  it('reads flags from the environment', () => {
    expect(service.isEnabled(FLAGS.expressShipping)).toBeTrue();
  });

  it('treats unknown flags as disabled', () => {
    expect(service.isEnabled('DoesNotExist')).toBeFalse();
  });

  it('notifies watchers when a flag is overridden', () => {
    const express = service.watch(FLAGS.expressShipping);
    service.override(FLAGS.expressShipping, false);
    expect(express()).toBeFalse();
  });
});
