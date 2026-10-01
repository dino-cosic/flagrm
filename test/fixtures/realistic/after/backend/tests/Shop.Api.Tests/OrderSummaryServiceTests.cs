using Shop.Api.Models;
using Shop.Api.Services;

namespace Shop.Api.Tests;

public class OrderSummaryServiceTests
{
    private static OrderSummaryService CreateSut() => new(new PricingEngine());

    [Fact]
    public async Task Summarize_AppliesBulkDiscount()
    {
        var summary = await CreateSut().SummarizeAsync(TestCarts.Bulk);

        Assert.Equal(new OrderSummary(50m, 2.50m, 47.50m), summary);
    }
}
