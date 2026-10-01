using Microsoft.FeatureManagement;
using Moq;
using Shop.Api.Features;
using Shop.Api.Services;

namespace Shop.Api.Tests;

public class CheckoutServiceTests
{
    private readonly Mock<IFeatureManager> _featureManager = new();

    private CheckoutService CreateSut() => new(_featureManager.Object, new PricingEngine());

    [Fact]
    public async Task PlaceOrder_UsesPricingEngine()
    {
        var order = await CreateSut().PlaceOrderAsync(TestCarts.Bulk);

        Assert.Equal("v2", order.Flow);
        Assert.Equal(47.50m, order.Total);
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
