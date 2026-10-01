import { Component, OnInit } from '@angular/core';
import { ApiService } from '../services/api.service';
import { FeatureFlagsService } from '../services/feature-flags.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent implements OnInit {
  readonly newDashboardEnabled = this.featureFlags.isEnabled('EnableNewDashboard');

  constructor(
    private readonly featureFlags: FeatureFlagsService,
    private readonly api: ApiService,
  ) {}

  ngOnInit(): void {
    if (this.featureFlags.isEnabled('UseNewApi')) {
      this.api.useV2();
    } else {
      this.api.useV1();
    }
  }

  loadWidgets(): string[] {
    return this.newDashboardEnabled ? ['charts', 'insights'] : ['legacy-list'];
  }

  refresh(): void {
    if (!this.newDashboardEnabled) {
      this.api.legacyRefresh();
      return;
    }
    this.api.refresh();
  }
}
