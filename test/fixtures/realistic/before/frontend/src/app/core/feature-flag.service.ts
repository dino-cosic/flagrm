import { Injectable, Signal, computed, signal } from '@angular/core';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class FeatureFlagService {
  private readonly flags = signal<Record<string, boolean>>({ ...environment.features });

  isEnabled(flag: string): boolean {
    return this.flags()[flag] ?? false;
  }

  /** Reactive view of a single flag. */
  watch(flag: string): Signal<boolean> {
    return computed(() => this.flags()[flag] ?? false);
  }

  override(flag: string, enabled: boolean): void {
    this.flags.update((flags) => ({ ...flags, [flag]: enabled }));
  }
}
