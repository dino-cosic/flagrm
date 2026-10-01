using Shop.Api.Services;

namespace Shop.Api.Tests;

public class PricingEngineTests
{
    [Fact]
    public void Summarize_NoDiscount_BelowBulkQuantity()
    {
        var summary = new PricingEngine().Summarize(TestCarts.Small);

        Assert.Equal(0m, summary.Discount);
        Assert.Equal(summary.Subtotal, summary.Total);
    }
}
