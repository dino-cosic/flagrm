using Microsoft.FeatureManagement;
using Shop.Api.Features;
using Shop.Api.Models;

namespace Shop.Api.Services;

public class CheckoutService
{
    private readonly IFeatureManager _featureManager;
    private readonly IPricingEngine _pricingEngine;
    private readonly ILegacyPricingCalculator _legacyPricing;

    public CheckoutService(
        IFeatureManager featureManager,
        IPricingEngine pricingEngine,
        ILegacyPricingCalculator legacyPricing)
    {
        _featureManager = featureManager;
        _pricingEngine = pricingEngine;
        _legacyPricing = legacyPricing;
    }

    public async Task<Order> PlaceOrderAsync(Cart cart)
    {
        // TODO(NewCheckout): drop the legacy flow once the rollout reaches 100%.
        if (await _featureManager.IsEnabledAsync(FeatureFlags.NewCheckout))
            return PlaceOrderV2(cart);
        return PlaceOrderLegacy(cart);
    }

    public async Task<decimal> QuoteShippingAsync(Cart cart)
    {
        var express = await _featureManager.IsEnabledAsync(FeatureFlags.ExpressShipping);
        return express ? 4.99m : 9.99m;
    }

    private Order PlaceOrderV2(Cart cart)
    {
        var summary = _pricingEngine.Summarize(cart);
        return new Order(NewOrderId(), summary.Total, "v2");
    }

    private Order PlaceOrderLegacy(Cart cart)
    {
        var total = _legacyPricing.CalculateTotal(cart);
        return new Order(NewOrderId(), RoundLegacy(total), "legacy");
    }

    private static decimal RoundLegacy(decimal total) => Math.Round(total, 2, MidpointRounding.AwayFromZero);

    private static string NewOrderId() => Guid.NewGuid().ToString("N");
}
