using Moq;
using Shop.Api.Features;
using Shop.Api.Models;
using Shop.Api.Services;

namespace Shop.Api.Tests;

public class OrderSummaryServiceTests
{
    private readonly Mock<ICheckoutFeatures> _checkoutFeatures = new();
    private readonly Mock<ILegacyPricingCalculator> _legacyPricing = new();

    private OrderSummaryService CreateSut() =>
        new(_checkoutFeatures.Object, new PricingEngine(), _legacyPricing.Object);

    [Fact]
    public async Task Summarize_AppliesBulkDiscount_WithNewCheckout()
    {
        _checkoutFeatures.Setup(x => x.IsNewCheckoutEnabledAsync()).ReturnsAsync(true);

        var summary = await CreateSut().SummarizeAsync(TestCarts.Bulk);

        Assert.Equal(new OrderSummary(50m, 2.50m, 47.50m), summary);
    }

    [Fact]
    public async Task Summarize_HasNoDiscount_OnLegacyFlow()
    {
        _checkoutFeatures.Setup(x => x.IsNewCheckoutEnabledAsync()).ReturnsAsync(false);
        _legacyPricing.Setup(x => x.CalculateTotal(It.IsAny<Cart>())).Returns(50m);

        var summary = await CreateSut().SummarizeAsync(TestCarts.Bulk);

        Assert.Equal(new OrderSummary(50m, 0m, 50m), summary);
    }
}
