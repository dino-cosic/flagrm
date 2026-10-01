# Flag removal patterns

The flag is always ON: keep the ON path, delete the OFF path.

## C# / .NET

**Fall-through return.** The code after an `if` that returns is the OFF path.

```csharp
// before
if (await _featureManager.IsEnabledAsync(FeatureFlags.NewCheckout))
    return await PlaceOrderAsync(cart);
return PlaceOrderLegacy(cart);
// after
return await PlaceOrderAsync(cart);
```

**Negated guard.** The block only runs when OFF: delete it.

```csharp
if (!await checkoutFeatures.IsNewCheckoutEnabledAsync()) { return Legacy(); }  // delete
```

**Wrapper.** `Task<bool> IsNewCheckoutEnabledAsync()` is the flag under another
name: record it with `--kind wrapper`, replace each call with `true`, then
delete the member, its interface member, the interface and class when nothing
is left, and their DI registration. Test mocks of it (`Setup(x => x.IsNewCheckoutEnabledAsync())`) go too.

**DI toggle.** Keep the ON registration.

```csharp
// before
if (config.GetValue<bool>("FeatureManagement:NewPayments"))
    services.AddScoped<IPaymentService, NewPaymentService>();
else
    services.AddScoped<IPaymentService, LegacyPaymentService>();
// after
services.AddScoped<IPaymentService, NewPaymentService>();
```

**Switch.** `flag switch { true => A(), false => B() }` → `A()`.

**Middleware.** `app.UseWhen(ctx => flag, b => b.UseMiddleware<M>())` →
`app.UseMiddleware<M>()` at the same position in the pipeline.

**`[FeatureGate]`.** Remove the attribute. If another action only served the
disabled case (404, redirect), delete it too.

**Config.** Remove the key from `appsettings*.json` in every environment, and a
`FeatureManagement` section left empty. Keys outside the repo (Key Vault, App
Service settings, Helm values) go in your report as follow-ups.

## Angular / TypeScript

**Templates.** `@if (newCheckout()) { A } @else { B }` → `A`. An element with
`*ngIf="!newCheckout()"` is deleted; `*ngIf="newCheckout()"` loses the directive
(an `<ng-container>` left with no directive is unwrapped). A binding such as
`[disabled]="!newCheckout()"` is `false` when ON: remove it.

**Signals and Observables.** `newCheckout = this.flags.watch(FLAGS.newCheckout)`
is a wrapper: remove the field and every read. `flag$ | async` and
`toSignal(getFlag$())` are the same: remove the stream, `AsyncPipe` and `NgIf`
when the template no longer needs them.

**Standalone imports.** Remove `imports: [...]` entries (components, `NgIf`,
`AsyncPipe`) the template no longer uses.

**Routes.** A route guarded with `canMatch: [() => !isEnabled(...)]` only
served the OFF case: delete it. A positive guard loses the guard.

**Tests.** `spyOn(flags, 'isEnabled').withArgs(FLAGS.newCheckout).and.returnValue(true)`
is setup: delete it and keep the test. A test returning `false`, or calling
`flags.override(FLAGS.newCheckout, false)`, tests the OFF path: delete it.
`TestBed` providers only the OFF path needed go too.

## Any stack

**Flag passed as a parameter.**

```ts
// before
function price(cart: Cart, useEngine: boolean) { return useEngine ? engine(cart) : legacy(cart); }
price(cart, flags.isEnabled('NewCheckout'));
// after
function price(cart: Cart) { return engine(cart); }
price(cart);
```

Pass `true` first, simplify, then remove the parameter only when every caller
passes `true`. A caller that passes something else keeps it.

**Stored in a field or local.** `const useNew = isEnabled(...)` is a wrapper:
record it, replace each read with `true`, then delete it.

**Two flags.** `if (flagA && flagB)` → `if (flagB)` when removing `flagA`.
Never remove or change the other flag.
