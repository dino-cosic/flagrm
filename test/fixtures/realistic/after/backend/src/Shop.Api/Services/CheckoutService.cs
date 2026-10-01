using Microsoft.FeatureManagement;
using Shop.Api.Features;
using Shop.Api.Models;

namespace Shop.Api.Services;

public class CheckoutService
{
    private readonly IFeatureManager _featureManager;
    private readonly IPricingEngine _pricingEngine;

    public CheckoutService(
        IFeatureManager featureManager,
        IPricingEngine pricingEngine)
    {
        _featureManager = featureManager;
        _pricingEngine = pricingEngine;
    }

    public Task<Order> PlaceOrderAsync(Cart cart)
    {
        return Task.FromResult(PlaceOrderV2(cart));
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

    private static string NewOrderId() => Guid.NewGuid().ToString("N");
}
