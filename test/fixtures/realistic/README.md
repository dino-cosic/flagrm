# Realistic fixture: `NewCheckout`

A small shop app (Angular 22 frontend + .NET 10 backend) built from the stress-test
findings of the first flagrm prototype. The flag under removal is **`NewCheckout`**,
removed as **ON**: the new path stays and the old (OFF) path goes.
`ExpressShipping` is a second flag that must survive untouched.

```
before/   the code as it is today (flag present)
after/    golden result of a correct removal
```

Each side is a self-contained repo root with its own `flagrm.config.yaml`.
`after/` only edits or deletes files from `before/`. It never adds any.

## Building and testing by hand

Build output (`bin/`, `obj/`, `node_modules/`) is gitignored. Work in a scratch
copy so nothing ends up in the repo:

```sh
cp -R test/fixtures/realistic/before /tmp/rf && cd /tmp/rf
(cd backend && dotnet test Shop.sln)                   # before: 9 tests, after: 5
(cd frontend && npm install && npm run typecheck)       # ngc with strictTemplates
```

`test/verify.test.ts` copies `before/` into a scratch git repository, takes a
baseline, and checks that `flagrm verify` fails on the untouched and on
deliberately broken copies and passes on `after/`. `test/realistic-fixture.test.ts`
guards the invariants below, so `before/` and `after/` stay a matched pair.

Both sides build cleanly with `tsc --noUnusedLocals --noUnusedParameters` and with
`dotnet build -p:EnforceCodeStyleInBuild=true` with IDE0051/IDE0052/IDE0005 set to warnings.
Jasmine specs are typechecked but not run (there is no Karma setup).

## Site catalogue

The Issue column numbers the stress-test finding each site reproduces.

### Backend (`backend/`)

| Location | Construct | Issue | Golden outcome |
|---|---|---|---|
| `Features/FeatureFlags.cs` | `const string NewCheckout` | 4 | member removed |
| `Features/Feature.cs` | enum member `NewCheckout` | 4 | file deleted (the other member is unused, so the enum is dead) |
| `Features/CheckoutFeatures.cs` | wrapper `IsNewCheckoutEnabledAsync()` + interface | 4 | file deleted |
| `Program.cs` | DI for `ICheckoutFeatures` and `ILegacyPricingCalculator` | 4 | registrations removed |
| `Services/CheckoutService.cs` | braceless `if (await IsEnabledAsync(FeatureFlags.NewCheckout)) return …; return Legacy…;` | 2 | only the ON call remains |
| `Services/CheckoutService.cs` | `TODO(NewCheckout)` comment | – | removed |
| `Services/CheckoutService.cs` | `_legacyPricing` field, `PlaceOrderLegacy`, `RoundLegacy` (only used by the OFF path) | 4 | removed |
| `Services/OrderSummaryService.cs` | `if (!await wrapper()) { … }` guard, primary-constructor params | 4 | guard and unused params removed |
| `Services/LegacyPricingCalculator.cs` | class only used by OFF paths | 4 | file deleted |
| `Controllers/CheckoutController.cs` | ternary on `nameof(Feature.NewCheckout)` | – | `Ok("v2")`, `IFeatureManager` dependency removed |
| `Controllers/CheckoutController.cs` | `[FeatureGate(FeatureFlags.NewCheckout)]` | – | attribute removed |
| `appsettings.json`, `appsettings.Development.json` | `FeatureManagement:NewCheckout` | – | keys removed |
| `CheckoutServiceTests.cs` | Moq `Setup(x => x.IsEnabledAsync(FeatureFlags.NewCheckout)).ReturnsAsync(true)` | 1 | setup stripped, test renamed |
| `CheckoutServiceTests.cs` | the same setup with `ReturnsAsync(false)` | 1 | test deleted |
| `OrderSummaryServiceTests.cs` | Moq setup on the wrapper (`true` / `false`) | 1 | strip / delete |
| `LegacyPricingCalculatorTests.cs` | tests of the OFF-only class | 4 | file deleted |

.NET tests: 9 before, 5 after (4 OFF-path tests deleted).

### Frontend (`frontend/`)

| Location | Construct | Issue | Golden outcome |
|---|---|---|---|
| `core/feature-flags.ts` | object key `FLAGS.newCheckout` | 3 | key removed |
| `core/feature-flags.ts` | enum member `FeatureFlag.NewCheckout` | 4 | enum removed (its only other user was the removed route) |
| `environments/environment*.ts` | `features.NewCheckout` | – | keys removed |
| `app.routes.ts` | `canMatch` guard `!isEnabled(FeatureFlag.NewCheckout)` on a `cart` route | – | route removed (the `cart` → `checkout` redirect stays) |
| `checkout/checkout.component.ts` | `inject()`, signal `watch(FLAGS.newCheckout)`, `computed` title | 3 | signal and title removed |
| `checkout/checkout.component.ts` | braceless `if (isEnabled(FLAGS.newCheckout)) return …; return legacy…;` | 2, 3 | only the ON call remains |
| `checkout/checkout.component.ts` | `legacyCart = inject(LegacyCartService)`, `NgIf`/`LegacyCartComponent` imports | 4 | removed |
| `checkout/checkout.component.html` | `@if (newCheckout()) {…} @else {…}` | – | ON block unwrapped |
| `checkout/checkout.component.html` | `*ngIf="!newCheckout()"` | – | element removed |
| `checkout/checkout.component.html` | `[disabled]="!newCheckout()"` | 1.3 in plan | binding removed (folds to `false`) |
| `layout/header.component.ts` | `*ngIf="newCheckout$ \| async; else legacyLink"` on `toObservable(watch(FLAGS.newCheckout))` | 3 | plain link; `inject`, `toObservable`, `AsyncPipe`, `NgIf` removed |
| `checkout/legacy-cart/*` | component + service + spec only used by OFF paths | 4 | directory deleted |
| `checkout/models.ts` | `flow: 'v2' \| 'legacy'` | 4 | narrowed to `'v2'` |
| `checkout.component.spec.ts` | `spyOn(ff, 'isEnabled').withArgs(FLAGS.newCheckout).and.returnValue(true)` | 1 | setup stripped, test renamed |
| `checkout.component.spec.ts` | `spyOn(…).and.returnValue(false)`, `ff.override(FLAGS.newCheckout, false)` | 1 | tests deleted |
| `core/feature-flag.service.spec.ts` | uses `FLAGS.newCheckout` only as a sample flag | – | review: switched to `FLAGS.expressShipping` |

Jasmine specs: 8 before, 5 after.

## What must not change

All `ExpressShipping` code, config and tests. The `FeatureFlagService` API
(`isEnabled`, `watch`, `override`). `PricingEngine`, `CheckoutApi`,
`CheckoutStepsComponent`, and the public signatures of `CheckoutService.PlaceOrderAsync`
and `OrderSummaryService.SummarizeAsync`.
