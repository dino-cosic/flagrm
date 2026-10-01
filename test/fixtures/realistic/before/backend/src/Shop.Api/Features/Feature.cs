namespace Shop.Api.Features;

// Older code paths still reference flags through this enum via nameof(Feature.X).
public enum Feature
{
    NewCheckout,
    ExpressShipping,
}
