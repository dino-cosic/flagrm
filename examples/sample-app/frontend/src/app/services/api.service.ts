import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ApiService {
  useV1(): void {}
  useV2(): void {}
  refresh(): void {}
  legacyRefresh(): void {}
}
