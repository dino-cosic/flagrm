using Microsoft.FeatureManagement;
using Moq;
using Shop.Api.Features;
using Shop.Api.Models;
using Shop.Api.Services;

namespace Shop.Api.Tests;

public class CheckoutServiceTests
{
    private readonly Mock<IFeatureManager> _featureManager = new();
    private readonly Mock<ILegacyPricingCalculator> _legacyPricing = new();

    private CheckoutService CreateSut() => new(_featureManager.Object, new PricingEngine(), _legacyPricing.Object);

    [Fact]
    public async Task PlaceOrder_UsesPricingEngine_WhenNewCheckoutEnabled()
    {
        _featureManager.Setup(x => x.IsEnabledAsync(FeatureFlags.NewCheckout)).ReturnsAsync(true);

        var order = await CreateSut().PlaceOrderAsync(TestCarts.Bulk);

        Assert.Equal("v2", order.Flow);
        Assert.Equal(47.50m, order.Total);
        _legacyPricing.Verify(x => x.CalculateTotal(It.IsAny<Cart>()), Times.Never);
    }

    [Fact]
    public async Task PlaceOrder_UsesLegacyPricing_WhenNewCheckoutDisabled()
    {
        _featureManager.Setup(x => x.IsEnabledAsync(FeatureFlags.NewCheckout)).ReturnsAsync(false);
        _legacyPricing.Setup(x => x.CalculateTotal(It.IsAny<Cart>())).Returns(20.015m);

        var order = await CreateSut().PlaceOrderAsync(TestCarts.Small);

        Assert.Equal("legacy", order.Flow);
        Assert.Equal(20.02m, order.Total);
    }

    [Theory]
    [InlineData(true, 4.99)]
    [InlineData(false, 9.99)]
    public async Task QuoteShipping_DependsOnExpressShipping(bool express, double expected)
    {
        _featureManager.Setup(x => x.IsEnabledAsync(FeatureFlags.ExpressShipping)).ReturnsAsync(express);

        var quote = await CreateSut().QuoteShippingAsync(TestCarts.Small);

        Assert.Equal((decimal)expected, quote);
    }
}
