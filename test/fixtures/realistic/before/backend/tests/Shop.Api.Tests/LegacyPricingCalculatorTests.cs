using Shop.Api.Services;

namespace Shop.Api.Tests;

public class LegacyPricingCalculatorTests
{
    [Fact]
    public void CalculateTotal_SumsLines()
    {
        Assert.Equal(20.010m, new LegacyPricingCalculator().CalculateTotal(TestCarts.Small));
    }

    [Fact]
    public void CalculateTotal_IgnoresBulkDiscount()
    {
        Assert.Equal(50m, new LegacyPricingCalculator().CalculateTotal(TestCarts.Bulk));
    }
}
