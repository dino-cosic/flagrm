import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class FeatureFlagsService {
  private readonly flags: Record<string, boolean> = {};

  isEnabled(flag: string): boolean {
    return this.flags[flag] ?? false;
  }
}
